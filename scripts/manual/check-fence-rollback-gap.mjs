// ============================================================
// check-fence-rollback-gap.mjs — 저장된 fence-rollback.sql 이 실제로 복원되는지 검증
// ============================================================
// 왜 필요한가:
//   GPT 지적 — `proacl IS NULL` 은 "권한 없음"이 아니다. PostgreSQL 은 함수 생성 시
//   기본 ACL 로 PUBLIC EXECUTE 를 부여하고 catalog 에는 NULL 로 남긴다.
//   `aclexplode(NULL)` 은 0행이므로, NULL 인 객체는 스냅샷에 한 건도 안 잡힌다.
//   그런데 fence 는 `revoke ... from PUBLIC` 을 실행했다.
//   → 제거는 했는데 복원문이 없는 상태일 수 있다.
//
// 검증 방식 (v2):
//   카탈로그를 눈으로 비교하는 간접 추론을 버리고 **실제로 되돌려본다.**
//     BEGIN → 저장된 fence-rollback.sql 적용 → effective privilege vector 재계산
//     → fence-acl-before.json 의 벡터와 대조 → ROLLBACK
//   영구 변경 0. 이게 "복원되는가"에 대한 유일하게 정직한 답이다.
//
//   v1 은 두 군데가 틀렸다(스스로 발견):
//     · PUBLIC 판별을 pg_get_userbyid(grantee)='' 로 했는데 실제로는
//       'unknown (OID=0)' 이 반환된다. → grantee = 0 으로 직접 판별해야 한다.
//     · rollback 문에 함수 "이름"이 있는지만 봐서, anon/authenticated 복원문 때문에
//       PUBLIC 복원 누락이 가려졌다.
//
// 실행: node scripts/manual/check-fence-rollback-gap.mjs
// 종료: 0 = 복원 정상, 3 = 복원 불일치(보강 필요), 1 = 실행 실패
// ============================================================
import pg from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readProdEnv, assertProdUrl, PROD_REF, refOf, scrub } from "./prod-url.mjs";

const BACKUP_ROOT = join(homedir(), "prod-backups");
const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
if (refOf(url) !== PROD_REF) { console.error("[중단] 운영 ref 불일치"); process.exit(1); }

const TABLES = ["comment_owners", "comments", "post_owners", "posts", "profiles"];
const SEQS = ["comments_id_seq", "posts_id_seq"];
const ROLES = ["anon", "authenticated"];
const TBL_PRIVS = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"];
const COL_PRIVS = ["INSERT", "UPDATE"];
const SEQ_PRIVS = ["USAGE", "UPDATE"];

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const line = (k, v) => console.log(`  ${String(k).padEnd(46)} ${v}`);
const head = (t) => console.log(`\n=== ${t} ===`);

let ROUTINES = [];

/** fence 스크립트와 동일한 규칙의 effective privilege vector */
async function privVector() {
  const v = {};
  for (const r of ROLES) {
    for (const t of TABLES) {
      for (const p of TBL_PRIVS) {
        v[`t:${r}:${t}:${p}`] = (await client.query(
          `select has_table_privilege($1,$2,$3) x`, [r, `public.${t}`, p])).rows[0].x;
      }
      const cols = (await client.query(
        `select attname from pg_attribute
          where attrelid = $1::regclass and attnum > 0 and not attisdropped`, [`public.${t}`])).rows;
      for (const c of cols) for (const p of COL_PRIVS) {
        v[`c:${r}:${t}.${c.attname}:${p}`] = (await client.query(
          `select has_column_privilege($1,$2,$3,$4) x`, [r, `public.${t}`, c.attname, p])).rows[0].x;
      }
    }
    for (const s of SEQS) for (const p of SEQ_PRIVS) {
      v[`s:${r}:${s}:${p}`] = (await client.query(
        `select has_sequence_privilege($1,$2,$3) x`, [r, `public.${s}`, p])).rows[0].x;
    }
    for (const f of ROUTINES) {
      v[`f:${r}:${f.sig}:EXECUTE`] = (await client.query(
        `select has_function_privilege($1,$2::oid,'EXECUTE') x`, [r, f.oid])).rows[0].x;
    }
    v[`n:${r}:public:CREATE`] = (await client.query(
      `select has_schema_privilege($1,'public','CREATE') x`, [r])).rows[0].x;
    v[`n:${r}:public:USAGE`] = (await client.query(
      `select has_schema_privilege($1,'public','USAGE') x`, [r])).rows[0].x;
  }
  return v;
}

/** PUBLIC 의 실제 권한 — grantee OID 0 으로 직접 판별하고, NULL ACL 은 acldefault 로 전개 */
async function publicPrivs() {
  const out = {};
  for (const f of ROUTINES) {
    const r = (await client.query(`
      select exists (
        select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         where a.grantee = 0 and a.privilege_type = 'EXECUTE'
      ) x,
      p.proacl is null as is_null
      from pg_proc p where p.oid = $1`, [f.oid])).rows[0];
    out[f.sig] = { publicExecute: r.x, aclIsNull: r.is_null };
  }
  for (const t of TABLES) {
    const r = (await client.query(`
      select coalesce(array_agg(a.privilege_type) filter (where a.grantee = 0), '{}') p
        from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
       where c.oid = $1::regclass`, [`public.${t}`])).rows[0];
    out[`table:${t}`] = { publicPrivs: r.p };
  }
  return out;
}

async function main() {
  await client.connect();

  const fenceDirs = readdirSync(BACKUP_ROOT).filter((d) => d.endsWith("_FENCE")).sort();
  if (!fenceDirs.length) { console.error("[중단] _FENCE 디렉터리 없음"); process.exit(1); }
  const FENCE = join(BACKUP_ROOT, fenceDirs[fenceDirs.length - 1]);
  const before = JSON.parse(readFileSync(join(FENCE, "fence-acl-before.json"), "utf8"));
  const rollbackSql = readFileSync(join(FENCE, "fence-rollback.sql"), "utf8")
    .split("\n").map((s) => s.trim()).filter(Boolean);

  head("대상");
  line("fence 디렉터리", fenceDirs[fenceDirs.length - 1]);
  line("before 스냅샷 grant 수", before.grants.length);
  line("before effective vector 항목", Object.keys(before.effective_privileges || {}).length);
  line("rollback SQL 문장 수", rollbackSql.length);

  await client.query("begin transaction isolation level repeatable read read only");
  ROUTINES = (await client.query(
    `select p.oid::int oid,
            quote_ident(n.nspname)||'.'||quote_ident(p.proname)||'('||
              pg_get_function_identity_arguments(p.oid)||')' sig
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' order by p.oid`)).rows;

  head("1. PUBLIC 권한 현황 (grantee OID 0 직접 판별 + NULL 은 acldefault 전개)");
  const pubNow = await publicPrivs();
  let nullAcl = 0, pubExec = 0;
  for (const f of ROUTINES) {
    const p = pubNow[f.sig];
    if (p.aclIsNull) nullAcl++;
    if (p.publicExecute) pubExec++;
  }
  line("public 함수 수", ROUTINES.length);
  line("proacl IS NULL 인 함수", `${nullAcl}${nullAcl ? " ⚠ (기본 ACL 적용 대상)" : " (전부 명시 ACL)"}`);
  line("현재 PUBLIC EXECUTE 가진 함수", pubExec);
  for (const t of TABLES) line(`  table ${t} 의 PUBLIC 권한`, pubNow[`table:${t}`].publicPrivs.join(",") || "(없음)");
  await client.query("rollback");

  // ── 실제 되돌려보기 ──
  head("2. 저장된 fence-rollback.sql 실제 적용 시험 (ROLLBACK 으로 종료)");
  await client.query("begin");
  await client.query("set local lock_timeout = '5s'");
  await client.query("set local statement_timeout = '120s'");
  let restored = null, pubAfter = null, err = null;
  try {
    for (const s of rollbackSql) await client.query(s);
    restored = await privVector();
    pubAfter = await publicPrivs();
  } catch (e) {
    err = scrub(e.message, url);
  } finally {
    await client.query("rollback");
  }
  if (err) { console.error(`  rollback SQL 실행 실패: ${err}`); process.exit(3); }
  line("실행 결과", "정상 (영구 변경 0, ROLLBACK 완료)");

  // ── 대조 ──
  head("3. 복원 결과 대조");
  const beforeVec = before.effective_privileges || {};
  const keys = new Set([...Object.keys(beforeVec), ...Object.keys(restored)]);
  const diff = [...keys].filter((k) => beforeVec[k] !== restored[k]);
  line("anon·authenticated vector 불일치", diff.length === 0 ? "0 ✅" : `${diff.length} ⛔`);
  for (const d of diff.slice(0, 10)) line("  차이", `${d}: before=${beforeVec[d]} → restored=${restored[d]}`);

  const pubDiff = ROUTINES.filter((f) => pubNow[f.sig].publicExecute !== pubAfter[f.sig].publicExecute);
  line("PUBLIC EXECUTE 변화(복원으로 되살아난 것)", pubDiff.length);
  for (const f of pubDiff) line("  되살아남", f.sig);

  head("판정");
  const gaps = [];
  if (diff.length) gaps.push(`anon/authenticated effective vector 불일치 ${diff.length}건`);

  // 핵심: fence 가 PUBLIC 에서 뺏은 게 있는데 rollback 이 되돌리지 못하면 누락이다.
  // before 스냅샷에 PUBLIC grant 가 0건이었는지 확인한다.
  const pubGrantsInSnapshot = before.grants.filter((g) => g.grantee === "PUBLIC");
  line("before 스냅샷의 PUBLIC grant", pubGrantsInSnapshot.length);
  if (nullAcl > 0 && pubGrantsInSnapshot.length === 0) {
    gaps.push("proacl NULL 함수가 있는데 스냅샷에 PUBLIC grant 가 0건 — 암묵적 기본 권한 미포착");
  }

  console.log("");
  if (!gaps.length) {
    console.log("FENCE_ROLLBACK_GAP=NONE");
    console.log("저장된 rollback SQL 을 실제로 적용한 결과가 fence 직전 상태와 일치한다.");
    if (pubGrantsInSnapshot.length === 0 && nullAcl === 0) {
      console.log("PUBLIC 은 fence 이전에도 대상 객체에 권한이 없었다(전부 명시 ACL). 따라서 복원할 것이 없다.");
    }
  } else {
    console.log("FENCE_ROLLBACK_GAP=DETECTED");
    for (const g of gaps) console.log(`  · ${g}`);
  }
  process.exitCode = gaps.length ? 3 : 0;
}

main()
  .then(async () => { await client.end(); console.log("\n읽기 전용 + ROLLBACK 으로 실행했습니다. 영구 변경 0."); })
  .catch(async (e) => { console.error("[fail] " + scrub(e.message || String(e), url));
    try { await client.end(); } catch {} process.exit(1); });
