// pending 마이그레이션 문법·참조 검증기 (dev, 흔적 없음).
//
// BEGIN → 파일 실행 → **무조건 ROLLBACK**. 스키마를 실제로 바꾸지 않고
// "문법이 맞는가 / 참조하는 테이블·함수가 실제로 있는가"만 확인한다.
// (파일 안의 begin/commit은 제거하고 우리 트랜잭션 안에서 돌린다 —
//  파일이 스스로 commit해버리면 롤백이 불가능하기 때문.)
//
// 사용: node scripts/manual/validate-sql-dev.mjs supabase/migrations/pending/010_course_review.sql
// 값(DEV_DB_URL)은 .env.dev.local에서만 읽고 출력하지 않는다.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { readDevEnv, assertDevUrl, scrub } from "./dev-url.mjs";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("사용법: node scripts/manual/validate-sql-dev.mjs <파일.sql> [...]");
  process.exit(1);
}
for (const f of files) {
  if (path.extname(f) !== ".sql") { console.error("[거부] .sql 파일만 허용:", f); process.exit(1); }
  if (!fs.existsSync(f)) { console.error("[거부] 파일 없음:", f); process.exit(1); }
}

const { DEV_DB_URL: dbUrl } = readDevEnv(["DEV_DB_URL"]);
assertDevUrl(dbUrl, "DEV_DB_URL");

const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function main() {
  await client.connect();
  let failed = 0;

  for (const f of files) {
    // 파일이 스스로 커밋하지 못하게 트랜잭션 제어문만 제거
    const sql = fs.readFileSync(f, "utf8")
      .replace(/^\s*begin\s*;\s*$/gim, "")
      .replace(/^\s*commit\s*;\s*$/gim, "");

    await client.query("begin");
    try {
      await client.query(sql);
      console.log(`PASS  ${f}  (문법·참조 OK — 롤백함)`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${f}`);
      console.log(`      ${e.message}`);
      if (e.position) {
        // 오류 위치 주변을 보여줘 어느 줄인지 바로 찾게 한다
        const upto = sql.slice(0, Number(e.position));
        const line = upto.split("\n").length;
        console.log(`      → 약 ${line}번째 줄 부근`);
      }
    } finally {
      await client.query("rollback"); // 성공하든 실패하든 반드시 되돌린다
    }
  }

  await client.end();
  console.log(`\n=== 검증: ${files.length - failed}/${files.length} PASS (dev 스키마 무변경) ===`);
  process.exit(failed ? 2 : 0);
}

main().catch((e) => { console.error("[fail] " + scrub(e.message || String(e), "", dbUrl)); process.exit(1); });
