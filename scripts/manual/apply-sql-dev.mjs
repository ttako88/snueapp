// ============================================================
// apply-sql-dev.mjs  (P0-6 실행기 — dev 전용, 로컬) — R4 하드닝 반영
// ============================================================
// 목적: .env.dev.local의 DEV_DB_URL로 dev Postgres에 SQL 파일을 순차 적용.
//   브라우저 SQL 에디터가 대량 SQL 입력을 못 받아 이 경로로 전환(2026-07-21).
//
// 안전(R4):
//   - DEV_DB_URL은 화면·로그에 절대 출력하지 않는다. 에러 메시지에서도 스크럽.
//   - URL을 new URL()로 파싱해 hostname이 (a)직접연결 db.<DEV_REF>.supabase.co 또는
//     (b)pooler hostname + username의 project-ref가 DEV_REF와 정확 일치하는 경우만 통과.
//     비밀번호·query·임의 문자열에 DEV_REF가 든 것만으로는 통과 금지. PROD_REF 발견 시 중단.
//   - SQL 파일은 저장소 내부 .sql만 허용(resolve 후 루트 밖·심볼릭 링크·비-.sql 거부).
//   - 기본 동작은 행 내용 비출력(HMAC·Storage path·UUID 유출 방지). --print-rows에서만 출력.
//     --print-rows는 합성 fixture·비민감 검증 전용.
//
// 사용: node scripts/manual/apply-sql-dev.mjs <repo내부.sql> [...]
//       node scripts/manual/apply-sql-dev.mjs --preflight
//       node scripts/manual/apply-sql-dev.mjs --print-rows <검증.sql>
// ============================================================
import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { resolve, extname, sep } from "node:path";
import pg from "pg";

const DEV_REF = "uiikgqeoxocpvphlmoqp";
const PROD_REF = "jclwkvxbvsegmbcnptpi";
const REPO_ROOT = realpathSync(process.cwd());

function fail(msg) {
  console.error("[fail] " + msg);
  process.exit(1);
}

// 연결문자열/비밀번호가 로그에 남지 않도록 스크럽
function scrub(s, url) {
  if (!s) return s;
  let out = String(s);
  if (url) out = out.split(url).join("[DEV_DB_URL]");
  out = out.replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+(@)/gi, "$1[REDACTED]$2");
  return out;
}

function loadDevUrl() {
  let raw;
  try {
    raw = readFileSync(resolve(REPO_ROOT, ".env.dev.local"), "utf8");
  } catch {
    fail(".env.dev.local 파일을 못 찾음 (snue-app 폴더에서 실행하세요)");
  }
  const m = raw.match(/^\s*DEV_DB_URL\s*=\s*(.+)\s*$/m);
  if (!m) fail(".env.dev.local에 DEV_DB_URL= 줄이 없습니다");
  const url = m[1].trim().replace(/^["']|["']$/g, "");
  if (!url) fail("DEV_DB_URL 값이 비었습니다");

  // R4-2: 구조적 파싱으로 대상 검증 (문자열 포함 검사 금지)
  let u;
  try {
    u = new URL(url);
  } catch {
    fail("DEV_DB_URL이 유효한 URL 형식이 아님");
  }
  const host = (u.hostname || "").toLowerCase();
  const user = decodeURIComponent(u.username || "");
  // (a) 직접 연결: db.<ref>.supabase.co
  const direct = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(host);
  // (b) pooler: *.pooler.supabase.com + username에 project-ref (postgres.<ref>)
  const pooler = /\.pooler\.supabase\.com$/.test(host);
  const userRef = /(?:^|\.)([a-z0-9]{20})$/.exec(user); // postgres.<ref>
  let ref = null;
  if (direct) ref = direct[1];
  else if (pooler && userRef) ref = userRef[1];
  if (!ref) fail("DEV_DB_URL 대상 식별 실패 — hostname/username에서 project-ref를 확인할 수 없음");
  if (ref === PROD_REF || host.includes(PROD_REF) || user.includes(PROD_REF)) fail("DEV_DB_URL이 운영을 가리킴 — 실행 불가");
  if (ref !== DEV_REF) fail("DEV_DB_URL의 project-ref가 dev가 아님 — 중단");
  return url;
}

// R4-4: 저장소 내부 .sql 실경로만 허용
function safeSqlPath(f) {
  if (extname(f).toLowerCase() !== ".sql") fail(".sql 파일만 허용: " + f);
  const abs = resolve(REPO_ROOT, f);
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    fail("파일 없음/접근 불가: " + f);
  }
  if (real !== abs) fail("심볼릭 링크/경로 정규화 불일치 거부: " + f);
  if (real !== REPO_ROOT && !real.startsWith(REPO_ROOT + sep)) fail("저장소 루트 밖 경로 거부: " + f);
  if (!lstatSync(real).isFile()) fail("일반 파일 아님: " + f);
  return real;
}

const url = loadDevUrl();
const printRows = process.argv.includes("--print-rows");
const preflightOnly = process.argv.includes("--preflight");
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  try {
    await client.connect();
  } catch (e) {
    fail("연결 실패: " + scrub(e.message, url));
  }

  const pre = await client.query(`
    select current_database() as db,
           (select count(*) from auth.users) as auth_users,
           (select count(*) from storage.objects) as storage_objs,
           (select count(*) from pg_tables where schemaname='public') as pub_tbl,
           (select count(*) from pg_namespace where nspname in ('private','authz')) as app_ns,
           (select md5(coalesce(string_agg(id::text, ',' order by id), '')) from auth.users) as auth_fp,
           (select md5(coalesce(string_agg(bucket_id||'/'||name, ',' order by bucket_id, name), '')) from storage.objects) as storage_fp,
           (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='rls_auto_enable') as rls_ae
  `);
  console.log("[preflight] " + JSON.stringify(pre.rows[0]));

  if (preflightOnly) {
    await client.end();
    console.log("[ok] preflight only — 종료");
    return;
  }
  if (files.length === 0) fail("적용할 .sql 파일 인자가 없습니다");
  if (printRows) console.warn("[warn] --print-rows 활성 — 합성 fixture·비민감 검증 전용. 실데이터/HMAC/path 반환 금지.");

  for (const f of files) {
    const real = safeSqlPath(f);
    const sql = readFileSync(real, "utf8");
    const t0 = Date.now();
    try {
      const res = await client.query(sql);
      console.log(`[ok] ${f}  (${Date.now() - t0}ms)`);
      // R4-3: 기본은 행 비출력. --print-rows일 때만 결과 출력.
      if (printRows) {
        const results = Array.isArray(res) ? res : [res];
        for (const r of results) {
          if (r && r.rows && r.rows.length) for (const row of r.rows) console.log("  " + JSON.stringify(row));
        }
      }
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
