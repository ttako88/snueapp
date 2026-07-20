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
import { realpathSync, lstatSync } from "node:fs";
import { resolve, extname, sep } from "node:path";
import pg from "pg";
import { readDevEnv, assertDevUrl, scrub } from "./dev-url.mjs";

// 경로 하드닝 — apply-sql-dev.mjs와 동일한 규칙(저장소 내부 .sql만, 심볼릭 링크 거부).
// 규칙이 두 벌이면 한쪽만 느슨해지므로 같은 검사를 그대로 쓴다.
const REPO_ROOT = realpathSync(process.cwd());
function fail(msg) { console.error("[거부] " + msg); process.exit(1); }
function safeSqlPath(f) {
  if (extname(f).toLowerCase() !== ".sql") fail(".sql 파일만 허용: " + f);
  const abs = resolve(REPO_ROOT, f);
  let real;
  try { real = realpathSync(abs); } catch { fail("파일 없음/접근 불가: " + f); }
  if (real !== abs) fail("심볼릭 링크/경로 정규화 불일치 거부: " + f);
  if (real !== REPO_ROOT && !real.startsWith(REPO_ROOT + sep)) fail("저장소 루트 밖 경로 거부: " + f);
  if (!lstatSync(real).isFile()) fail("일반 파일 아님: " + f);
  return real;
}

const argv = process.argv.slice(2);
if (!argv.length) {
  console.error("사용법: node scripts/manual/validate-sql-dev.mjs <저장소내부.sql> [...]");
  process.exit(1);
}
const files = argv.map(safeSqlPath);

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
