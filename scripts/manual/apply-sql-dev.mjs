// ============================================================
// apply-sql-dev.mjs  (P0-6 실행기 — dev 전용, 로컬)
// ============================================================
// 목적: .env.dev.local의 DEV_DB_URL로 dev Postgres에 SQL 파일을 순차 적용.
//   브라우저 SQL 에디터가 대량 SQL 입력을 못 받아 이 경로로 전환(2026-07-21).
//
// 안전:
//   - DEV_DB_URL은 화면·로그에 절대 출력하지 않는다. 에러 메시지에서도 스크럽.
//   - dev ref(uiikgqeoxocpvphlmoqp) 포함 + 운영 ref(jclwkvxbvsegmbcnptpi) 미포함을
//     강제. 하나라도 위반하면 연결 전에 중단.
//   - 파일은 인자로 받은 것만 순서대로 실행. 실패 시 즉시 중단(다음 파일 진행 안 함).
//   - 각 파일은 자체 트랜잭션(begin/commit)을 포함하거나, 없으면 단일 배치로 실행.
//
// 사용: node scripts/manual/apply-sql-dev.mjs <file1.sql> [file2.sql ...]
//       node scripts/manual/apply-sql-dev.mjs --preflight     (연결·현황만 확인)
// ============================================================
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const DEV_REF = "uiikgqeoxocpvphlmoqp";
const PROD_REF = "jclwkvxbvsegmbcnptpi";

function loadDevUrl() {
  let raw;
  try {
    raw = readFileSync(resolve(process.cwd(), ".env.dev.local"), "utf8");
  } catch {
    fail(".env.dev.local 파일을 못 찾음 (snue-app 폴더에서 실행하세요)");
  }
  const m = raw.match(/^\s*DEV_DB_URL\s*=\s*(.+)\s*$/m);
  if (!m) fail(".env.dev.local에 DEV_DB_URL= 줄이 없습니다");
  let url = m[1].trim().replace(/^["']|["']$/g, "");
  if (!url) fail("DEV_DB_URL 값이 비었습니다");
  // 안전 가드 — 값은 출력하지 않음
  if (!url.includes(DEV_REF)) fail("DEV_DB_URL에 dev ref가 없음 — 대상이 dev가 맞는지 확인 (중단)");
  if (url.includes(PROD_REF)) fail("DEV_DB_URL이 운영 ref를 가리킴 — 절대 실행 불가 (중단)");
  return url;
}

// 연결문자열이 섞여 들어와도 로그에 남지 않도록 스크럽
function scrub(s, url) {
  if (!s) return s;
  let out = String(s);
  if (url) out = out.split(url).join("[DEV_DB_URL]");
  // 비밀번호 형태(://user:pass@) 제거
  out = out.replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+(@)/gi, "$1[REDACTED]$2");
  return out;
}

function fail(msg) {
  console.error("[fail] " + msg);
  process.exit(1);
}

const url = loadDevUrl();
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const preflightOnly = process.argv.includes("--preflight");

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  try {
    await client.connect();
  } catch (e) {
    fail("연결 실패: " + scrub(e.message, url));
  }

  // 프리플라이트: 연결·현황 확인 (dev임을 재확인)
  const pre = await client.query(`
    select current_database() as db,
           (select count(*) from auth.users) as auth_users,
           (select count(*) from storage.objects) as storage_objs,
           (select count(*) from pg_tables where schemaname='public') as pub_tbl,
           (select count(*) from pg_namespace where nspname in ('private','authz')) as app_ns
  `);
  console.log("[preflight] " + JSON.stringify(pre.rows[0]));

  if (preflightOnly) {
    await client.end();
    console.log("[ok] preflight only — 종료");
    return;
  }

  if (files.length === 0) fail("적용할 .sql 파일 인자가 없습니다");

  for (const f of files) {
    const path = resolve(process.cwd(), f);
    let sql;
    try {
      sql = readFileSync(path, "utf8");
    } catch {
      fail("파일 못 읽음: " + f);
    }
    const t0 = Date.now();
    try {
      await client.query(sql);
      console.log(`[ok] ${f}  (${Date.now() - t0}ms)`);
    } catch (e) {
      console.error(`[FAIL] ${f}  (${Date.now() - t0}ms)`);
      console.error("  " + scrub(e.message, url));
      await client.end();
      process.exit(2);
    }
  }

  await client.end();
  console.log(`[done] ${files.length}개 파일 적용 완료`);
}

main().catch((e) => {
  console.error("[fail] " + scrub(e && e.message, url));
  process.exit(1);
});
