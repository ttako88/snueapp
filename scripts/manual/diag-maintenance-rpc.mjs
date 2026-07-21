import pg from "pg";
import { readProdEnv, assertProdUrl, scrub } from "./prod-url.mjs";
const NAMES = ["acquire_maintenance_lease","claim_accounts_for_deletion","claim_expired_uploads",
"claim_verification_docs_to_purge","detach_member_content","expire_unreviewed_submissions",
"get_member_verification_paths","mark_member_verification_doc_purged","mark_verification_doc_purged",
"prepare_account_deletion","record_maintenance_run","record_verification_purge_failure"];
const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url,"PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl:{rejectUnauthorized:false} });
await c.connect(); await c.query("begin read only");
let miss=0;
for (const n of NAMES) {
  const r = await c.query(`select count(*) v from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname=$1::text`,[n]);
  const ok = Number(r.rows[0].v)>0; if(!ok) miss++;
  console.log(`  ${n.padEnd(38)} ${ok?"있음":"⛔ 없음"}`);
}
console.log(`\nMAINTENANCE_RPC=${miss?"MISSING":"PASS"} (없음 ${miss})`);
await c.query("rollback"); await c.end();
