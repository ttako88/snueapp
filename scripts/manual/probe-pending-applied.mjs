// probe-pending-applied.mjs — 029/032/033 이 프로덕션 DB에 실제 적용됐는지 READ-ONLY 프로브.
// 함수 존재 + 029는 provolatile('v'=VOLATILE) 확인. 아무것도 쓰지 않는다.
import pg from "pg";
import { readProdEnv, assertProdUrl, scrub } from "./prod-url.mjs";

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

const fnExists = async (name) =>
  (await c.query(
    `select p.provolatile v from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname=$1 limit 1`, [name])).rows[0];

const tblExists = async (schema, name) =>
  (await c.query(
    `select 1 from pg_class cl join pg_namespace n on n.oid=cl.relnamespace
     where n.nspname=$1 and cl.relname=$2 and cl.relkind='r' limit 1`, [schema, name])).rowCount > 0;

async function main() {
  await c.connect();
  await c.query("begin read only");

  // 029: analytics 함수가 VOLATILE 인가
  const ov = await fnExists("analytics_overview");
  const da = await fnExists("analytics_daily");
  const vol = (r) => !r ? "⛔없음" : r.v === "v" ? "VOLATILE ✅적용" : `${r.v}(STABLE/IMMUTABLE) ❌미적용`;
  console.log("=== 029 analytics_volatility_fix ===");
  console.log(`  analytics_overview: ${vol(ov)}`);
  console.log(`  analytics_daily   : ${vol(da)}`);

  // 032: 지도안 저장 함수 + 테이블
  console.log("\n=== 032 lesson_plan_saves ===");
  for (const n of ["save_lesson_plan","list_my_lesson_plans","get_my_lesson_plan","delete_my_lesson_plan","my_lesson_plan_access"])
    console.log(`  ${n}: ${(await fnExists(n)) ? "✅있음" : "⛔없음"}`);
  console.log(`  table private.lesson_plan_saves: ${(await tblExists("private","lesson_plan_saves")) ? "✅있음" : "⛔없음"}`);

  // 033: 회원메모 + 알림함
  console.log("\n=== 033 member_notes_and_messages ===");
  for (const n of ["set_member_note","list_my_messages","my_unread_message_count"])
    console.log(`  ${n}: ${(await fnExists(n)) ? "✅있음" : "⛔없음"}`);
  console.log(`  table private.member_notes: ${(await tblExists("private","member_notes")) ? "✅있음" : "⛔없음"}`);

  await c.query("rollback");
}
try { await main(); }
catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
