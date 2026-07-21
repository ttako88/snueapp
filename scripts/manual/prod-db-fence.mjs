// ============================================================
// prod-db-fence.mjs — 운영 DB write fence (GPT 런북 7단계)
// ============================================================
// 목적:
//   Vercel Proxy 503 은 **앱 경유 요청만** 막는다. 브라우저가 Supabase REST 를
//   직접 때리면 그대로 통과한다. 그 구멍을 DB 권한으로 막는 것이 이 단계다.
//
// 범위 (승인된 경계):
//   대상 역할  anon · authenticated · PUBLIC
//   대상 객체  public 테이블 5 · 시퀀스 2 · 루틴 8 · schema public CREATE
//   차단 권한  INSERT/UPDATE/DELETE/TRUNCATE · 컬럼 INSERT/UPDATE ·
//              sequence USAGE/UPDATE · routine EXECUTE · schema CREATE
//   보존       SELECT · schema USAGE · owner · 관리형 역할/스키마 일체
//
//   service_role·authenticator·supabase_* ·postgres·dashboard_user 는 건드리지
//   않는다. 이건 fence 실패가 아니라 승인된 경계다(보고서에 명시한다).
//
// 안전 설계:
//   · 영구 적용 전에 **같은 운영 DB에서 rollback-only drill** 을 먼저 돌린다.
//     REVOKE → 차단 확인 → rollback SQL → 원복 확인 → ROLLBACK. 영구 변경 0.
//   · 실제 적용은 하나의 짧은 트랜잭션에서 원자적으로. assertion 전부 통과할
//     때만 COMMIT. 일부만 잠긴 상태로 commit 하지 않는다.
//   · rollback 합격 기준은 raw ACL 바이트 동일성이 아니라 **effective privilege
//     vector 의 의미적 동일성**이다.
//
// 사용: node scripts/manual/prod-db-fence.mjs [--drill-only]
// 종료: 0 = PASS, 3 = BLOCKED, 1 = 실패
// ============================================================
import pg from "pg";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { readProdEnv, assertProdUrl, PROD_REF, refOf, scrub } from "./prod-url.mjs";

const PG_BIN = "C:/pgsql17/bin";
const BACKUP_ROOT = join(homedir(), "prod-backups");
const EXPECT_MAIN = "e8fab516b538a8c34230d4b68c2efe93c3a69517";
const EXPECT_USERS_SHA = "1af01ece257e646d822e2d23f98cb5ef4874dd2952cc0657cf23aef3e55760b9";
const EXPECT_OBJS_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const TABLES = ["comment_owners", "comments", "post_owners", "posts", "profiles"];
const SEQS = ["comments_id_seq", "posts_id_seq"];
const ROLES = ["anon", "authenticated"];          // PUBLIC 은 별도 처리 (grantee oid 0)
const TBL_PRIVS = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"];
const COL_PRIVS = ["INSERT", "UPDATE"];
const SEQ_PRIVS = ["USAGE", "UPDATE"];

const DRILL_ONLY = process.argv.includes("--drill-only");

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
if (!url) { console.error("[중단] PROD_DB_URL 없음"); process.exit(1); }
assertProdUrl(url, "PROD_DB_URL");
const u = new URL(url);
if (!/\.pooler\.supabase\.com$/.test(u.hostname) || u.port !== "5432") {
  console.error("[거부] Session pooler 5432 만 허용"); process.exit(3);
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const line = (k, v) => console.log(`  ${String(k).padEnd(44)} ${v}`);
const head = (t) => console.log(`\n=== ${t} ===`);
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

let OUTDIR = null;
function stop(code, why) { console.error(`\n⛔ ${code}: ${why}`); throw Object.assign(new Error(code), { blocked: true }); }

// ── effective privilege vector ────────────────────────────────
// raw ACL 이 아니라 "실제로 할 수 있는가"를 본다. 직접 grant·상속·PUBLIC 경유
// 어느 경로든 결과가 같으면 같은 것으로 본다.
async function privVector() {
  const v = {};
  for (const r of ROLES) {
    for (const t of TABLES) {
      for (const p of TBL_PRIVS) {
        v[`t:${r}:${t}:${p}`] = (await client.query(
          `select has_table_privilege($1, $2, $3) x`, [r, `public.${t}`, p])).rows[0].x;
      }
      const cols = (await client.query(
        `select attname from pg_attribute
          where attrelid = $1::regclass and attnum > 0 and not attisdropped`, [`public.${t}`])).rows;
      for (const c of cols) for (const p of COL_PRIVS) {
        v[`c:${r}:${t}.${c.attname}:${p}`] = (await client.query(
          `select has_column_privilege($1, $2, $3, $4) x`, [r, `public.${t}`, c.attname, p])).rows[0].x;
      }
    }
    for (const s of SEQS) for (const p of SEQ_PRIVS) {
      v[`s:${r}:${s}:${p}`] = (await client.query(
        `select has_sequence_privilege($1, $2, $3) x`, [r, `public.${s}`, p])).rows[0].x;
    }
    for (const f of ROUTINES) {
      v[`f:${r}:${f.sig}:EXECUTE`] = (await client.query(
        `select has_function_privilege($1, $2::oid, 'EXECUTE') x`, [r, f.oid])).rows[0].x;
    }
    v[`n:${r}:public:CREATE`] = (await client.query(
      `select has_schema_privilege($1, 'public', 'CREATE') x`, [r])).rows[0].x;
    v[`n:${r}:public:USAGE`] = (await client.query(
      `select has_schema_privilege($1, 'public', 'USAGE') x`, [r])).rows[0].x;
  }
  return v;
}

/** fence 대상 privilege 중 true 로 남은 것 */
const mutationLeaks = (v) => Object.entries(v)
  .filter(([k, val]) => val && !/:(SELECT|USAGE)$/.test(k) && !k.endsWith(":public:USAGE"))
  .map(([k]) => k);

let ROUTINES = [];

async function loadRoutines() {
  ROUTINES = (await client.query(
    `select p.oid::int oid,
            quote_ident(n.nspname)||'.'||quote_ident(p.proname)||'('||
              pg_get_function_identity_arguments(p.oid)||')' sig,
            p.proname
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
      order by p.oid`)).rows;
}

// ── SQL 생성 ──────────────────────────────────────────────────
function fenceSql() {
  const s = [];
  const all = "anon, authenticated, PUBLIC";
  for (const t of TABLES) s.push(`revoke ${TBL_PRIVS.join(", ")} on table public.${t} from ${all};`);
  for (const q of SEQS) s.push(`revoke ${SEQ_PRIVS.join(", ")} on sequence public.${q} from ${all};`);
  for (const f of ROUTINES) s.push(`revoke execute on function ${f.sig} from ${all};`);
  s.push(`revoke create on schema public from ${all};`);
  return s;
}

/** before 스냅샷에서 "이번에 제거되는 권한만" 되돌리는 GRANT 를 만든다. */
function rollbackSql(before) {
  const s = [];
  const g = (who) => (who === "PUBLIC" ? "PUBLIC" : who);
  for (const e of before.grants) {
    if (e.kind === "table" && TBL_PRIVS.includes(e.priv)) {
      s.push(`grant ${e.priv} on table public.${e.name} to ${g(e.grantee)};`);
    } else if (e.kind === "column" && COL_PRIVS.includes(e.priv)) {
      s.push(`grant ${e.priv} (${e.column}) on table public.${e.name} to ${g(e.grantee)};`);
    } else if (e.kind === "sequence" && SEQ_PRIVS.includes(e.priv)) {
      s.push(`grant ${e.priv} on sequence public.${e.name} to ${g(e.grantee)};`);
    } else if (e.kind === "function" && e.priv === "EXECUTE") {
      s.push(`grant execute on function ${e.name} to ${g(e.grantee)};`);
    } else if (e.kind === "schema" && e.priv === "CREATE") {
      s.push(`grant create on schema public to ${g(e.grantee)};`);
    }
  }
  return s;
}

/** 원문 ACL 을 정규화해 기록 (사용자 식별자·secret 없음) */
async function aclSnapshot() {
  const grants = [];
  const push = (kind, name, column, row) => {
    const grantee = row.grantee === "-" || row.grantee === "" ? "PUBLIC" : row.grantee;
    if (!["anon", "authenticated", "PUBLIC"].includes(grantee)) return;
    grants.push({ kind, name, column, grantee, grantor: row.grantor, priv: row.privilege_type, grantable: row.is_grantable });
  };
  for (const t of TABLES) {
    for (const r of (await client.query(
      `select coalesce(nullif(pg_get_userbyid(a.grantee),''),'-') grantee,
              pg_get_userbyid(a.grantor) grantor, a.privilege_type, a.is_grantable
         from pg_class c, aclexplode(c.relacl) a
        where c.oid = $1::regclass`, [`public.${t}`])).rows) push("table", t, null, r);
    for (const r of (await client.query(
      `select att.attname, coalesce(nullif(pg_get_userbyid(a.grantee),''),'-') grantee,
              pg_get_userbyid(a.grantor) grantor, a.privilege_type, a.is_grantable
         from pg_attribute att, aclexplode(att.attacl) a
        where att.attrelid = $1::regclass and att.attnum > 0 and att.attacl is not null`,
      [`public.${t}`])).rows) push("column", t, r.attname, r);
  }
  for (const q of SEQS) {
    for (const r of (await client.query(
      `select coalesce(nullif(pg_get_userbyid(a.grantee),''),'-') grantee,
              pg_get_userbyid(a.grantor) grantor, a.privilege_type, a.is_grantable
         from pg_class c, aclexplode(c.relacl) a where c.oid = $1::regclass`,
      [`public.${q}`])).rows) push("sequence", q, null, r);
  }
  for (const f of ROUTINES) {
    for (const r of (await client.query(
      `select coalesce(nullif(pg_get_userbyid(a.grantee),''),'-') grantee,
              pg_get_userbyid(a.grantor) grantor, a.privilege_type, a.is_grantable
         from pg_proc p, aclexplode(p.proacl) a where p.oid = $1`, [f.oid])).rows) {
      push("function", f.sig, null, r);
    }
  }
  for (const r of (await client.query(
    `select coalesce(nullif(pg_get_userbyid(a.grantee),''),'-') grantee,
            pg_get_userbyid(a.grantor) grantor, a.privilege_type, a.is_grantable
       from pg_namespace n, aclexplode(n.nspacl) a where n.nspname = 'public'`)).rows) {
    push("schema", "public", null, r);
  }
  grants.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { grants, digest: sha256(JSON.stringify(grants)) };
}

async function dataState() {
  const g = async (q, p = []) => (await client.query(q, p)).rows[0];
  const s = { tables: {} };
  for (const t of TABLES) s.tables[t] = Number((await g(`select count(*) v from public.${t}`)).v);
  s.users = Number((await g(`select count(*) v from auth.users`)).v);
  s.idents = Number((await g(`select count(*) v from auth.identities`)).v);
  s.buckets = Number((await g(`select count(*) v from storage.buckets`)).v);
  s.objects = Number((await g(`select count(*) v from storage.objects`)).v);
  s.usersSha = sha256((await client.query(`select id::text from auth.users order by id`)).rows.map((r) => r.id).join("\n"));
  s.objsSha = sha256((await client.query(`select bucket_id, name from storage.objects order by bucket_id, name`))
    .rows.map((o) => `${o.bucket_id} ${o.name}`).join("\n"));
  return s;
}

async function main() {
  await client.connect();

  // ── 1. PRE_FENCE_INITIAL 결속 ────────────────────────────────
  head("1. PRE_FENCE_INITIAL 백업 결속");
  const dirs = readdirSync(BACKUP_ROOT).filter((d) => /^\d{4}-.*Z$/.test(d)).sort();
  if (!dirs.length) stop("PRE_FENCE_BACKUP_BINDING=BLOCKED", "백업 디렉터리 없음");
  const PRE = join(BACKUP_ROOT, dirs[dirs.length - 1]);
  line("PRE_FENCE_INITIAL", basename(PRE));
  const rec = join(PRE, "backup-receipt.json");
  if (!existsSync(rec) || statSync(rec).size === 0) stop("PRE_FENCE_BACKUP_BINDING=BLOCKED", "receipt 없음/0byte");
  for (const l of readFileSync(join(PRE, "SHA256SUMS.txt"), "utf8").trim().split("\n")) {
    const [h, n] = l.split(/\s+/);
    if (sha256File(join(PRE, n)) !== h) stop("PRE_FENCE_BACKUP_BINDING=BLOCKED", `${n} 해시 불일치`);
  }
  line("SHA256SUMS 재검증", "전부 일치 ✅");
  const preReceipt = JSON.parse(readFileSync(rec, "utf8"));
  line("roles.sql sha256", preReceipt.files["roles.sql"].sha256.slice(0, 24) + "…");
  line("schema.sql sha256", preReceipt.files["schema.sql"].sha256.slice(0, 24) + "…");

  const gitMain = execFileSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" }).trim();
  line("origin/main", gitMain === EXPECT_MAIN ? `${gitMain.slice(0, 7)} ✅` : `${gitMain.slice(0, 7)} ⛔`);
  if (gitMain !== EXPECT_MAIN) stop("PRE_FENCE_BACKUP_BINDING=BLOCKED", "origin/main 변경");

  // ── 2. fence 전 재확인 ───────────────────────────────────────
  head("2. fence preflight (read-only)");
  await client.query("begin transaction isolation level repeatable read read only");
  await loadRoutines();
  line("DB ref", refOf(url) === PROD_REF ? `${PROD_REF} ✅` : "⛔");
  line("public table / sequence / routine", `${TABLES.length} / ${SEQS.length} / ${ROUTINES.length}`);
  if (ROUTINES.length !== 8) stop("FENCE_PREFLIGHT_STATE_DRIFT=BLOCKED", `routine ${ROUTINES.length}개 (기대 8)`);

  for (const s of ["private", "authz"]) {
    const e = (await client.query(`select to_regnamespace($1) is not null e`, [s])).rows[0].e;
    line(`${s} 스키마`, e ? "존재 ⛔" : "없음 ✅");
    if (e) stop("FENCE_PREFLIGHT_STATE_DRIFT=BLOCKED", `${s} 스키마 생김`);
  }
  const w = (await client.query(
    `select count(*)::int n from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid() and state = 'active'
        and query ~* '^\\s*(insert|update|delete|truncate|alter|drop|create|grant|revoke)'`)).rows[0].n;
  const lk = (await client.query(
    `select count(*)::int n from pg_locks l join pg_class c on c.oid = l.relation
       join pg_namespace nn on nn.oid = c.relnamespace
      where nn.nspname = 'public' and l.pid <> pg_backend_pid()
        and l.mode in ('ExclusiveLock','AccessExclusiveLock','ShareRowExclusiveLock')`)).rows[0].n;
  const px = (await client.query(`select count(*)::int n from pg_prepared_xacts`)).rows[0].n;
  line("writer / lock / prepared", `${w} / ${lk} / ${px}`);
  if (w || lk || px) stop("FENCE_PREFLIGHT_STATE_DRIFT=BLOCKED", "writer/lock/prepared 존재");

  const st0 = await dataState();
  line("public 행수", TABLES.map((t) => `${t.slice(0, 6)}=${st0.tables[t]}`).join(" "));
  line("auth users/identities", `${st0.users} / ${st0.idents}`);
  line("storage buckets/objects", `${st0.buckets} / ${st0.objects}`);
  line("auth fingerprint", st0.usersSha === EXPECT_USERS_SHA ? "✅ 일치" : "⛔ 불일치");
  line("storage fingerprint", st0.objsSha === EXPECT_OBJS_SHA ? "✅ 일치" : "⛔ 불일치");
  if (st0.usersSha !== EXPECT_USERS_SHA || st0.objsSha !== EXPECT_OBJS_SHA) {
    stop("FENCE_PREFLIGHT_STATE_DRIFT=BLOCKED", "fingerprint 변화");
  }
  for (const p of ["/", "/login", "/board/free"]) {
    const r = await fetch(`https://snueapp.vercel.app${p}?cb=${Date.now()}${Math.random()}`, { redirect: "manual" });
    line(`앱 ${p}`, `${r.status}${r.status === 503 ? " ✅" : " ⛔"}`);
    if (r.status !== 503) stop("FENCE_PREFLIGHT_STATE_DRIFT=BLOCKED", `${p} 503 아님`);
  }

  // ── 3. ACL before ────────────────────────────────────────────
  head("3. ACL 스냅샷 + 계획 생성");
  const before = await aclSnapshot();
  const vBefore = await privVector();
  await client.query("rollback");
  line("대상 grant 항목", before.grants.length);
  line("ACL digest", before.digest.slice(0, 32) + "…");
  line("fence 전 mutation 가능 항목", mutationLeaks(vBefore).length);

  const applySql = fenceSql();
  const rbSql = rollbackSql(before);
  line("fence 문", `${applySql.length}개`);
  line("rollback 문", `${rbSql.length}개`);
  if (!rbSql.length) console.log("  (되돌릴 grant 가 0개 — 이미 권한이 없거나 PUBLIC 경유였다는 뜻)");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
  OUTDIR = join(BACKUP_ROOT, `${stamp}_FENCE`);
  mkdirSync(OUTDIR, { recursive: true });
  try {
    execFileSync("icacls", [OUTDIR, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:(OI)(CI)F`], { stdio: "ignore" });
  } catch {}
  writeFileSync(join(OUTDIR, "fence-acl-before.json"), JSON.stringify(
    { captured_at_utc: new Date().toISOString(), project_ref: PROD_REF, scope: "ANON_AUTHENTICATED_PUBLIC_APP_MUTATION",
      objects: { tables: TABLES, sequences: SEQS, routines: ROUTINES.map((r) => r.sig) },
      grants: before.grants, acl_digest: before.digest, effective_privileges: vBefore }, null, 2));
  writeFileSync(join(OUTDIR, "fence-apply.sql"), applySql.join("\n") + "\n");
  writeFileSync(join(OUTDIR, "fence-rollback.sql"), rbSql.join("\n") + "\n");
  console.log(`  계획 저장: ${OUTDIR}`);

  // ── 4. rollback drill (영구 변경 0) ──────────────────────────
  head("4. rollback drill (같은 운영 DB, ROLLBACK 으로 종료)");
  await client.query("begin");
  await client.query("set local lock_timeout = '5s'");
  await client.query("set local statement_timeout = '120s'");
  try {
    for (const s of applySql) await client.query(s);
    const vFenced = await privVector();
    const leaks = mutationLeaks(vFenced);
    line("drill: fence 후 잔존 mutation", leaks.length === 0 ? "0 ✅" : `${leaks.length} ⛔`);
    if (leaks.length) { for (const l of leaks.slice(0, 5)) line("  누수", l); stop("FENCE_ROLLBACK_DRILL=BLOCKED", "fence 후 mutation 잔존"); }

    for (const s of rbSql) await client.query(s);
    const vRestored = await privVector();
    const diff = Object.keys(vBefore).filter((k) => vBefore[k] !== vRestored[k]);
    line("drill: 복원 후 vector 불일치", diff.length === 0 ? "0 ✅" : `${diff.length} ⛔`);
    if (diff.length) { for (const d of diff.slice(0, 5)) line("  차이", d); stop("FENCE_ROLLBACK_DRILL=BLOCKED", "복원 vector 불일치"); }
  } finally {
    await client.query("rollback");
  }
  line("drill 종료", "ROLLBACK — 영구 변경 0 ✅");

  if (DRILL_ONLY) { console.log("\n--drill-only: 여기서 종료한다 (영구 변경 없음)"); return { drillOnly: true }; }

  // ── 5. 실제 fence (원자적) ───────────────────────────────────
  head("5. 실제 DB write fence 적용");
  await client.query("begin");
  await client.query("set local lock_timeout = '5s'");
  await client.query("set local statement_timeout = '120s'");
  let committed = false;
  try {
    const nT = (await client.query(`select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace
                                     where n.nspname='public' and c.relkind='r'`)).rows[0].n;
    const nF = (await client.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                                     where n.nspname='public'`)).rows[0].n;
    if (nT !== 5 || nF !== 8) stop("FENCE_TARGET_ASSERTION=BLOCKED", `대상 집합 변화 (table ${nT}, func ${nF})`);

    for (const s of applySql) await client.query(s);

    const vAfter = await privVector();
    const leaks = mutationLeaks(vAfter);
    line("fence 후 잔존 mutation", leaks.length === 0 ? "0 ✅" : `${leaks.length} ⛔`);
    if (leaks.length) stop("FENCE_ASSERTION=BLOCKED", "mutation 잔존");
    for (const r of ROLES) {
      const sel = (await client.query(`select has_table_privilege($1,'public.posts','SELECT') x`, [r])).rows[0].x;
      const usg = (await client.query(`select has_schema_privilege($1,'public','USAGE') x`, [r])).rows[0].x;
      line(`${r}: SELECT / schema USAGE 보존`, `${sel} / ${usg} ${sel && usg ? "✅" : "⛔"}`);
      if (!sel || !usg) stop("FENCE_ASSERTION=BLOCKED", `${r} 의 SELECT/USAGE 가 함께 사라짐`);
    }
    await client.query("commit");
    committed = true;
    line("COMMIT", "✅ 원자적 적용 완료");
  } catch (e) {
    if (!committed) { try { await client.query("rollback"); } catch {} }
    throw e;
  }

  // ── 6. fence 후 검증 ─────────────────────────────────────────
  head("6. fence 후 검증 (새 read-only transaction)");
  await client.query("begin transaction isolation level repeatable read read only");
  const afterAcl = await aclSnapshot();
  const vAfter2 = await privVector();
  const st1 = await dataState();
  const rlsN = (await client.query(`select count(*)::int n from pg_policy p join pg_class c on c.oid=p.polrelid
                                     join pg_namespace nn on nn.oid=c.relnamespace where nn.nspname='public'`)).rows[0].n;
  const trgN = (await client.query(`select count(*)::int n from pg_trigger t join pg_class c on c.oid=t.tgrelid
                                     join pg_namespace nn on nn.oid=c.relnamespace
                                    where nn.nspname='public' and not t.tgisinternal`)).rows[0].n;
  await client.query("rollback");

  line("잔존 mutation privilege", mutationLeaks(vAfter2).length === 0 ? "0 ✅" : "⛔");
  line("RLS 정책 / 트리거", `${rlsN} / ${trgN} ${rlsN === 11 && trgN === 7 ? "✅ 불변" : "⛔ 변화"}`);
  line("public 행수 불변", TABLES.every((t) => st1.tables[t] === st0.tables[t]) ? "✅" : "⛔");
  line("auth/storage fingerprint", st1.usersSha === EXPECT_USERS_SHA && st1.objsSha === EXPECT_OBJS_SHA ? "✅ 불변" : "⛔");
  if (rlsN !== 11 || trgN !== 7) stop("FENCE_VERIFY=BLOCKED", "RLS/트리거 변화");
  if (st1.usersSha !== EXPECT_USERS_SHA || st1.objsSha !== EXPECT_OBJS_SHA) stop("MANAGED_CHANNEL_STATE_DRIFT=BLOCKED", "관리형 fingerprint 변화");

  writeFileSync(join(OUTDIR, "fence-acl-after.json"), JSON.stringify(
    { captured_at_utc: new Date().toISOString(), project_ref: PROD_REF,
      grants: afterAcl.grants, acl_digest: afterAcl.digest, effective_privileges: vAfter2 }, null, 2));

  return { OUTDIR, PRE, preReceipt, st1, vBefore, vAfter2, before, afterAcl, gitMain, rbSql };
}

main()
  .then(async (r) => {
    if (!r || r.drillOnly) { await client.end(); return; }
    console.log("\nDB_WRITE_FENCE=PASS (probe·post-fence 백업은 다음 스크립트에서)");
    console.log(`FENCE_DIR=${basename(r.OUTDIR)}`);
    await client.end();
  })
  .catch(async (e) => {
    if (!e.blocked) console.error("[fail] " + scrub(e.message || String(e), url));
    try { await client.end(); } catch {}
    process.exit(e.blocked ? 3 : 1);
  });
