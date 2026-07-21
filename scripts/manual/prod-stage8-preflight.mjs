// ============================================================
// prod-stage8-preflight.mjs — 8단계 PROD write 전 최종 preflight (읽기 전용)
// ============================================================
// GPT 판정: PREFLIGHT_START = AUTHORIZED_WITH_MANDATORY_PATCHES
//           PROD_TX_A_RESET = HOLD_PENDING_PREFLIGHT_REVIEW
//
// 이 스크립트는 **아무것도 쓰지 않는다.** 운영 DB 는 read only 트랜잭션으로만 열고,
// 로컬은 소스 해시만 계산한다. 결과를 GPT 에 제출해 TX-A 승인 여부를 받는다.
//
// 검사 범위 (GPT 8단계 지시 §2 + 필수보완 6건)
//   A. 백업·복구세트 결속 재검증
//   B. 실행 원본 봉인 (reset SQL, 001~005, 도구)
//   C. 001~005 정적 분석 (트랜잭션 경계·shell escape·동적 SQL·secret 출력)
//   D. 운영 상태 재확인 (지문·행수·writer·lock·prepared·앱 503·origin/main)
//   E. 확장 ACL 측정 — 필수보완 3·4·5
//        · acldefault 전개 (proacl IS NULL = PUBLIC EXECUTE)
//        · relkind ∈ r,p,v,m,f  (updatable view 만이 아님)
//        · TRIGGER · MAINTAIN · database-level CREATE
//
// 종료: 0 = PASS, 3 = BLOCKED, 1 = 실행 실패
// ============================================================
import pg from "pg";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readProdEnv, assertProdUrl, PROD_REF, refOf, scrub } from "./prod-url.mjs";

const BACKUP_ROOT = join(homedir(), "prod-backups");
const EXPECT_MAIN = "e8fab516b538a8c34230d4b68c2efe93c3a69517";
const EXPECT_USERS_SHA = "1af01ece257e646d822e2d23f98cb5ef4874dd2952cc0657cf23aef3e55760b9";
const EXPECT_OBJS_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const TABLES = ["comment_owners", "comments", "post_owners", "posts", "profiles"];
const MIGRATIONS = ["001_schemas_roles", "002_foundation", "003_functions_triggers",
                    "004_admin_batch_functions", "005_schedules"];

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
if (refOf(url) !== PROD_REF) { console.error("[중단] 운영 ref 불일치"); process.exit(1); }

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const sha256File = (p) => sha256(readFileSync(p));
const gitBlob = (p) => { const b = Buffer.from(readFileSync(p).toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest("hex"); };
const line = (k, v) => console.log(`  ${String(k).padEnd(48)} ${v}`);
const head = (t) => console.log(`\n=== ${t} ===`);

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const blocks = [];
const rec = (n, ok, d) => { if (!ok) blocks.push(n); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

async function main() {
  await client.connect();

  // ── A. 백업·복구세트 결속 재검증 ──────────────────────────────
  head("A. 백업·복구세트 결속");
  const dirs = readdirSync(BACKUP_ROOT);
  const PRE = join(BACKUP_ROOT, dirs.filter((d) => /^\d{4}-.*Z$/.test(d)).sort().pop());
  const POST = join(BACKUP_ROOT, dirs.filter((d) => d.endsWith("_POSTFENCE")).sort().pop());
  const FENCE = join(BACKUP_ROOT, dirs.filter((d) => d.endsWith("_FENCE")).sort().pop());
  for (const [label, dir] of [["PRE_FENCE_INITIAL", PRE], ["POST_FENCE_FINAL", POST]]) {
    let ok = true, n = 0;
    for (const l of readFileSync(join(dir, "SHA256SUMS.txt"), "utf8").trim().split("\n")) {
      const [h, name] = l.split(/\s+/); n++;
      if (sha256File(join(dir, name)) !== h) ok = false;
    }
    rec(`${label} SHA256SUMS 재검증 (${n}개)`, ok, dir.split(/[\\/]/).pop());
  }
  const comp = JSON.parse(readFileSync(join(POST, "backup-receipt.json"), "utf8")).composite_recovery_set;
  const preRec = JSON.parse(readFileSync(join(PRE, "backup-receipt.json"), "utf8")).files;
  rec("composite recovery set — roles.sql 결속",
    comp["PRE_FENCE_INITIAL/roles.sql"] === preRec["roles.sql"].sha256);
  rec("composite recovery set — schema.sql 결속",
    comp["PRE_FENCE_INITIAL/schema.sql"] === preRec["schema.sql"].sha256);
  rec("composite recovery set — post-fence data.sql 결속",
    comp["POST_FENCE_FINAL_PRE_RESET/data.sql"] === sha256File(join(POST, "data.sql")));
  rec("fence-rollback.sql 존재", existsSync(join(FENCE, "fence-rollback.sql")),
    `${readFileSync(join(FENCE, "fence-rollback.sql"), "utf8").trim().split("\n").length}문`);

  // ── B. 실행 원본 봉인 ────────────────────────────────────────
  head("B. 실행 원본 봉인 (bytes / SHA-256 / git blob)");
  const seal = {};
  const srcs = [
    ["prod-reset-community.sql", "scripts/manual/prod-reset-community.sql"],
    ...MIGRATIONS.map((m) => [m, `supabase/migrations/${m}.sql`]),
  ];
  for (const [name, rel] of srcs) {
    const p = join(process.cwd(), rel);
    if (!existsSync(p)) { rec(`원본 존재: ${name}`, false, "파일 없음"); continue; }
    seal[name] = { bytes: statSync(p).size, sha256: sha256File(p), blob: gitBlob(p) };
    line(name, `${seal[name].bytes}B · ${seal[name].sha256.slice(0, 16)}… · blob ${seal[name].blob.slice(0, 12)}`);
  }

  head("B-1. 001~009 동결 무결성 (RC 대비 드리프트)");
  let drift = 0;
  for (const m of [...MIGRATIONS, "006_storage_policies", "007_soft_delete_rpc",
                   "008_harden_private_exec", "009_server_job_rpcs"]) {
    const rel = `supabase/migrations/${m}.sql`;
    const a = execFileSync("git", ["rev-parse", `e9d1c75:${rel}`], { encoding: "utf8" }).trim();
    const b = execFileSync("git", ["rev-parse", `HEAD:${rel}`], { encoding: "utf8" }).trim();
    if (a !== b) drift++;
  }
  rec("001~009 blob SHA 동결 (RC == HEAD)", drift === 0, `드리프트 ${drift}건`);

  // ── C. 001~005 정적 분석 ─────────────────────────────────────
  head("C. 001~005 정적 분석 (TX-A 전 차단 조건)");
  const badPatterns = [
    [/^\s*(begin|start\s+transaction)\b/im, "자체 BEGIN"],
    [/^\s*commit\b/im, "자체 COMMIT"],
    [/^\s*rollback\b/im, "자체 ROLLBACK"],
    [/^\s*\\\w/m, "psql meta/shell escape"],
    [/\bcreate\s+database\b|\bdrop\s+database\b/i, "database 수준 명령"],
    [/\bcreate\s+index\s+concurrently\b/i, "트랜잭션 내 실행 불가 명령"],
    [/\bvacuum\b/i, "트랜잭션 내 실행 불가 명령(VACUUM)"],
    [/\bdblink\b|\bpostgres_fdw\b/i, "연결 전환 가능성"],
    [/raise\s+notice[^;]*(password|secret|key|url)/i, "secret 출력 가능성"],
  ];
  for (const m of MIGRATIONS) {
    const txt = readFileSync(join(process.cwd(), `supabase/migrations/${m}.sql`), "utf8");
    const hits = badPatterns.filter(([re]) => re.test(txt)).map(([, label]) => label);
    rec(`${m} 정적 분석`, hits.length === 0, hits.length ? hits.join(", ") : "위반 0");
  }
  // 동적 SQL 은 존재 자체가 위반이 아니므로 개수만 보고한다
  for (const m of MIGRATIONS) {
    const txt = readFileSync(join(process.cwd(), `supabase/migrations/${m}.sql`), "utf8");
    const n = (txt.match(/\bexecute\s+format\s*\(/gi) || []).length;
    if (n) line(`  ${m} 동적 SQL(execute format)`, `${n}건 — GPT 검토 대상`);
  }

  // ── D. 운영 상태 재확인 ──────────────────────────────────────
  head("D. 운영 상태 재확인");
  const gitMain = execFileSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" }).trim();
  rec("origin/main == e8fab51", gitMain === EXPECT_MAIN, gitMain.slice(0, 12));

  for (const p of ["/", "/login", "/board/free"]) {
    const r = await fetch(`https://snueapp.vercel.app${p}?cb=${Date.now()}${Math.random()}`, { redirect: "manual" });
    rec(`앱 ${p} 503`, r.status === 503, String(r.status));
  }

  await client.query("begin transaction isolation level repeatable read read only");
  await client.query("set local lock_timeout = '5s'");
  await client.query("set local statement_timeout = '120s'");

  const g = async (q, p = []) => (await client.query(q, p)).rows[0];
  rec("DB ref 일치", refOf(url) === PROD_REF, PROD_REF);
  const ro = await g(`select current_setting('transaction_read_only') v`);
  rec("transaction_read_only = on", ro.v === "on", ro.v);

  for (const t of TABLES) {
    const n = Number((await g(`select count(*) v from public.${t}`)).v);
    line(`  public.${t}`, `${n}행`);
  }
  const users = Number((await g(`select count(*) v from auth.users`)).v);
  const idents = Number((await g(`select count(*) v from auth.identities`)).v);
  const buckets = Number((await g(`select count(*) v from storage.buckets`)).v);
  const objects = Number((await g(`select count(*) v from storage.objects`)).v);
  rec("auth.users = 1", users === 1, String(users));
  rec("auth.identities = 1", idents === 1, String(idents));
  rec("storage.buckets = 0", buckets === 0, String(buckets));
  rec("storage.objects = 0", objects === 0, String(objects));

  const uSha = sha256((await client.query(`select id::text from auth.users order by id`)).rows.map((r) => r.id).join("\n"));
  const oSha = sha256((await client.query(`select bucket_id, name from storage.objects order by bucket_id, name`))
    .rows.map((o) => `${o.bucket_id} ${o.name}`).join("\n"));
  rec("AUTH_USERS_ID_SHA256 불변", uSha === EXPECT_USERS_SHA, uSha.slice(0, 16) + "…");
  rec("STORAGE_OBJECT_KEYS_SHA256 불변", oSha === EXPECT_OBJS_SHA, oSha.slice(0, 16) + "…");

  const w = Number((await g(`select count(*) v from pg_stat_activity
     where datname = current_database() and pid <> pg_backend_pid() and state = 'active'
       and query ~* '^\\s*(insert|update|delete|truncate|alter|drop|create|grant|revoke)'`)).v);
  const lk = Number((await g(`select count(*) v from pg_locks l join pg_class c on c.oid = l.relation
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public','private','authz') and l.pid <> pg_backend_pid()
       and l.mode in ('ExclusiveLock','AccessExclusiveLock','ShareRowExclusiveLock')`)).v);
  const px = Number((await g(`select count(*) v from pg_prepared_xacts`)).v);
  rec("writer 0", w === 0, String(w));
  rec("충돌 lock 0", lk === 0, String(lk));
  rec("prepared transaction 0", px === 0, String(px));

  for (const s of ["private", "authz"]) {
    const e = (await g(`select to_regnamespace($1) is not null v`, [s])).v;
    rec(`${s} 스키마 미존재`, !e, e ? "존재" : "없음");
  }

  // ── E. 확장 ACL 측정 (필수보완 3·4·5) ────────────────────────
  head("E. 확장 ACL 측정 — 필수보완 3·4·5");

  // E-1. relkind 분모 (r=table, p=partitioned, v=view, m=matview, f=foreign)
  const rels = (await client.query(
    `select c.relkind, count(*)::int n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
      where ns.nspname = 'public' and c.relkind in ('r','p','v','m','f') group by 1 order by 1`)).rows;
  line("public relation 분모 (r,p,v,m,f)", rels.map((r) => `${r.relkind}=${r.n}`).join(" ") || "(없음)");

  // E-2. acldefault 전개 — proacl IS NULL 인 함수가 있는가
  const nullAcl = Number((await g(
    `select count(*) v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proacl is null`)).v);
  line("proacl IS NULL 인 public 함수", `${nullAcl}${nullAcl ? " ⚠ acldefault 전개 필수" : " (현재 전부 명시 ACL)"}`);
  const pubExec = Number((await g(
    `select count(*) v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     where a.grantee = 0 and a.privilege_type = 'EXECUTE')`)).v);
  line("PUBLIC EXECUTE 보유 함수 (acldefault 전개 후)", pubExec);

  // E-3. TRIGGER / MAINTAIN / database CREATE
  for (const role of ["anon", "authenticated"]) {
    const trg = Number((await g(
      `select count(*) v from (values ('comment_owners'),('comments'),('post_owners'),('posts'),('profiles')) t(x)
        where has_table_privilege($1, 'public.'||t.x, 'TRIGGER')`, [role])).v);
    let maintain = "N/A";
    try {
      maintain = String((await g(
        `select count(*)::int v from (values ('comment_owners'),('comments'),('post_owners'),('posts'),('profiles')) t(x)
          where has_table_privilege($1, 'public.'||t.x, 'MAINTAIN')`, [role])).v);
    } catch { maintain = "미지원(PG<17 권한명)"; }
    const dbc = (await g(`select has_database_privilege($1, current_database(), 'CREATE') v`, [role])).v;
    rec(`${role}: TRIGGER=0 / MAINTAIN=0 / database CREATE=false`,
      trg === 0 && (maintain === "0" || maintain.startsWith("미지원")) && dbc === false,
      `${trg} / ${maintain} / ${dbc}`);
  }

  // E-4. 현재 fence vector 유지
  const leak = Number((await g(
    `select count(*) v from (values ('anon'),('authenticated')) r(x),
            (values ('comment_owners'),('comments'),('post_owners'),('posts'),('profiles')) t(y)
      where has_table_privilege(r.x, 'public.'||t.y, 'INSERT')
         or has_table_privilege(r.x, 'public.'||t.y, 'UPDATE')
         or has_table_privilege(r.x, 'public.'||t.y, 'DELETE')
         or has_table_privilege(r.x, 'public.'||t.y, 'TRUNCATE')`)).v);
  rec("현재 ACL fence mutation vector 0", leak === 0, String(leak));

  await client.query("rollback");

  // ── 판정 ─────────────────────────────────────────────────────
  head("판정");
  console.log("");
  if (blocks.length) {
    console.log("PROD_RESET_PREFLIGHT=BLOCKED");
    console.log("RESET_EXECUTED=NO");
    for (const b of blocks) console.log(`  · ${b}`);
  } else {
    console.log("PROD_RESET_PREFLIGHT=PASS_LOCAL_AND_PROD_READONLY");
    console.log("RESET_EXECUTED=NO");
    console.log("DEV_CLEAN_REPLAY=NOT_YET_RUN   ← 별도 수행 필요 (GPT 지시 §2)");
    console.log("NEXT=AWAIT_GPT_REVIEW_OF_PREFLIGHT");
  }
  console.log("\n=== 봉인 요약 (GPT 제출용) ===");
  for (const [k, v] of Object.entries(seal)) console.log(`${k} = ${v.bytes}B / sha256 ${v.sha256} / blob ${v.blob}`);
  process.exitCode = blocks.length ? 3 : 0;
}

main()
  .then(async () => { await client.end(); console.log("\n읽기 전용으로 실행했습니다. 영구 변경 0."); })
  .catch(async (e) => { console.error("[fail] " + scrub(e.message || String(e), url));
    try { await client.end(); } catch {} process.exit(1); });
