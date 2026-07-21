// ============================================================
// diag-rpc-contracts.mjs — 화면 배선에 쓸 RPC 계약 추출 (READ-ONLY)
// ============================================================
// 함수 이름·인자·반환을 추측해서 붙이면 런타임에서만 터진다. 방금 그걸로
// 검증기를 네 번 고쳤다. 카탈로그에서 정확히 뽑아 화면 작업의 기준으로 쓴다.
// READ-ONLY.
// ============================================================
import pg from "pg";
import { readProdEnv, assertProdUrl, scrub } from "./prod-url.mjs";

const WANT = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();
  await c.query("begin read only");
  const q = async (s, p = []) => (await c.query(s, p)).rows;

  const rows = await q(`
    select p.proname,
           pg_get_function_identity_arguments(p.oid) args,
           pg_get_function_arguments(p.oid) args_full,
           pg_get_function_result(p.oid) result,
           has_function_privilege('authenticated', p.oid,'EXECUTE') auth,
           has_function_privilege('anon', p.oid,'EXECUTE') anon
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and ($1::text[] is null or p.proname = any($1::text[]))
     order by p.proname`, [WANT.length ? WANT : null]);

  for (const r of rows) {
    console.log(`\n${r.proname}`);
    console.log(`  인자   ${r.args_full || "(없음)"}`);
    console.log(`  반환   ${r.result}`);
    console.log(`  권한   authenticated=${r.auth} anon=${r.anon}`);
  }
  console.log(`\n총 ${rows.length}개`);
  await c.query("rollback");
}

try { await main(); }
catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
