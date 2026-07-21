// ============================================================
// diag-course-review-link.mjs — 강의평가와 강의검색이 이어질 수 있나 (READ-ONLY)
// ============================================================
// 강의평가 RPC 는 p_subject_id bigint 를 받는다. 그런데 강의검색은
// app/data/courses.json 정적 파일을 쓴다. 둘 사이에 매핑이 없으면
// "강의검색 상세에서 그 과목 평가 보여주기" 는 배선만으로 안 된다.
//
// 확인할 것
//   · 과목 테이블이 무엇이고 행이 있는가
//   · courses.json 의 식별자와 대조 가능한 열이 있는가
//   · 없다면 무엇을 채워야 하는가
// READ-ONLY.
// ============================================================
import pg from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readProdEnv, assertProdUrl, scrub } from "./prod-url.mjs";

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();
  await c.query("begin read only");
  const q = async (s, p = []) => (await c.query(s, p)).rows;

  console.log("=== 강의평가 관련 테이블 ===");
  const tables = await q(`select n.nspname sch, c2.relname t,
      (select count(*) from pg_attribute a where a.attrelid=c2.oid and a.attnum>0 and not a.attisdropped) cols
     from pg_class c2 join pg_namespace n on n.oid=c2.relnamespace
    where n.nspname in ('public','private') and c2.relkind='r'
      and (c2.relname like '%course%' or c2.relname like '%subject%'
           or c2.relname like '%review%' or c2.relname like '%exam%' or c2.relname like '%ticket%')
    order by 1,2`);
  for (const t of tables) {
    const n = (await q(`select count(*) v from ${t.sch}.${t.t}`))[0].v;
    console.log(`  ${t.sch}.${t.t}  (컬럼 ${t.cols})  행 ${n}`);
  }

  // 과목 테이블 구조
  const subj = tables.find((t) => /subject/.test(t.t));
  if (subj) {
    console.log(`\n=== ${subj.sch}.${subj.t} 구조 ===`);
    for (const a of await q(`select a.attname, format_type(a.atttypid,a.atttypmod) ty, a.attnotnull nn
       from pg_attribute a where a.attrelid=($1||'.'||$2)::regclass and a.attnum>0 and not a.attisdropped
       order by a.attnum`, [subj.sch, subj.t]))
      console.log(`  ${a.attname.padEnd(22)} ${a.ty}${a.nn ? " NOT NULL" : ""}`);
  } else {
    console.log("\n  과목 테이블을 찾지 못했다.");
  }

  console.log("\n=== courses.json 쪽 식별자 ===");
  try {
    const raw = JSON.parse(readFileSync(join(process.cwd(), "app/data/courses.json"), "utf8"));
    const arr = Array.isArray(raw) ? raw : raw.courses ?? Object.values(raw)[0];
    console.log(`  최상위 형태: ${Array.isArray(raw) ? "배열" : "객체(" + Object.keys(raw).slice(0, 5).join(",") + ")"}`);
    if (Array.isArray(arr) && arr.length) {
      console.log(`  항목 수: ${arr.length}`);
      console.log(`  첫 항목 키: ${Object.keys(arr[0]).join(", ")}`);
    }
  } catch (e) {
    console.log(`  읽기 실패: ${(e.message || "").slice(0, 100)}`);
  }

  await c.query("rollback");
}

try { await main(); }
catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
