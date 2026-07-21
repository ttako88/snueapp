// ============================================================
// diag-new-rpcs.mjs — 011~014 가 실제로 노출한 public RPC 목록 (READ-ONLY)
// ============================================================
// 모듈 검증에서 함수 이름을 내가 추측해 넣었다가 대부분 틀렸다.
// 추측하지 말고 카탈로그에서 뽑는다. 마이그레이션 파일에 적힌
// grant execute 대상과 실제 카탈로그를 함께 본다.
// READ-ONLY.
// ============================================================
import pg from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readProdEnv, assertProdUrl, scrub } from "./prod-url.mjs";

const DIR = join(process.cwd(), "supabase/migrations");
const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();
  await c.query("begin read only");
  const q = async (s, p = []) => (await c.query(s, p)).rows;

  // 각 파일이 만든 public 함수 이름을 소스에서 뽑는다
  for (const f of ["011_course_review.sql", "012_board_notice.sql",
                   "013_vote_bookmark_report.sql", "014_bug_report.sql"]) {
    const sql = readFileSync(join(DIR, f), "utf8");
    const names = [...new Set([...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.([a-z0-9_]+)/gi)]
      .map((m) => m[1]))];
    console.log(`\n=== ${f} ===`);
    if (!names.length) { console.log("  (public 함수 없음 — private 전용 모듈)"); continue; }
    for (const n of names) {
      const rows = await q(`select p.oid::regprocedure::text sig,
          has_function_privilege('authenticated', p.oid,'EXECUTE') auth,
          has_function_privilege('anon', p.oid,'EXECUTE') anon,
          has_function_privilege('service_role', p.oid,'EXECUTE') svc
        from pg_proc p join pg_namespace n2 on n2.oid=p.pronamespace
        where n2.nspname='public' and p.proname=$1::text order by 1`, [n]);
      if (!rows.length) { console.log(`  ⛔ ${n} — 카탈로그에 없음`); continue; }
      for (const r of rows)
        console.log(`  ${r.sig}\n      authenticated=${r.auth} anon=${r.anon} service_role=${r.svc}`);
    }
  }

  console.log("\n=== authenticated 가 부를 수 있는 public 함수 전체 ===");
  const all = await q(`select p.oid::regprocedure::text sig
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and has_function_privilege('authenticated', p.oid,'EXECUTE')
    order by 1`);
  console.log(`  총 ${all.length}개`);
  for (const r of all) console.log(`    ${r.sig}`);

  await c.query("rollback");
}

try { await main(); }
catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
