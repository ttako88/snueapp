// ============================================================
// set-prod-pooler.mjs — PROD_DB_URL 을 Session pooler 주소로 교체
// ============================================================
// 왜 필요한가:
//   Supabase 직결 호스트 db.<ref>.supabase.co 는 **IPv4 A 레코드가 없다**(IPv6 전용).
//   IPv6 경로가 없는 회선에서는 ETIMEDOUT 으로 접속 자체가 불가능하다.
//   대시보드가 안내하는 대안이 Session pooler(IPv4 지원)다.
//   Transaction pooler(:6543)가 아니라 **Session pooler(:5432)** 여야 한다 —
//   인벤토리·마이그레이션이 SAVEPOINT·SET LOCAL·다중문 트랜잭션을 쓰기 때문이다.
//
// 하는 일:
//   기존 PROD_DB_URL 에서 **비밀번호만 그대로 재사용**해 pooler URL을 조립한다.
//   비밀번호를 새로 입력받지 않고, 화면·로그 어디에도 출력하지 않는다.
//   기존 직결 주소는 PROD_DB_URL_DIRECT 로 보존한다(IPv4 애드온 구매 시 복귀용).
//
// 사용:
//   node scripts/manual/set-prod-pooler.mjs \
//     --host=aws-1-ap-northeast-2.pooler.supabase.com --port=5432 \
//     --user=postgres.jclwkvxbvsegmbcnptpi
//
// host·port·user 는 비밀값이 아니다(대시보드 Connect 모달에 그대로 표시된다).
// ============================================================
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { PROD_REF, refOf } from "./dev-url.mjs";

const FILE = resolve(process.cwd(), ".env.prod.local");
const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || "").split("=").slice(1).join("=");

const host = arg("host"), port = arg("port") || "5432", user = arg("user");
if (!host || !user) { console.error("[사용법] --host=... --user=... [--port=5432]"); process.exit(2); }
if (!/\.pooler\.supabase\.com$/.test(host)) { console.error("[거부] pooler 호스트가 아닙니다."); process.exit(2); }
if (port !== "5432") {
  console.error("[거부] Session pooler(5432)만 허용합니다. 6543은 Transaction pooler로,");
  console.error("       SAVEPOINT·SET LOCAL 을 쓰는 인벤토리·마이그레이션에 부적합합니다.");
  process.exit(2);
}

// 기존 파일 로드
const cur = {};
let raw;
try { raw = readFileSync(FILE, "utf8"); }
catch { console.error("[중단] .env.prod.local 없음"); process.exit(1); }
for (const line of raw.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) cur[m[1]] = m[2];
}
if (!cur.PROD_DB_URL) { console.error("[중단] PROD_DB_URL 없음"); process.exit(1); }

// 기존 URL에서 비밀번호만 뽑는다. u.password 는 퍼센트 인코딩된 형태 그대로다.
let old;
try { old = new URL(cur.PROD_DB_URL); }
catch { console.error("[중단] 기존 PROD_DB_URL 형식 오류"); process.exit(1); }
if (!old.password) { console.error("[중단] 기존 URL에 비밀번호가 없습니다."); process.exit(1); }

const next = `postgresql://${user}:${old.password}@${host}:${port}/postgres`;

// 대상이 정말 운영인지 구조 검증. pooler 형식은 username 에서 ref를 읽는다.
const ref = refOf(next);
if (ref !== PROD_REF) {
  console.error(`[거부] 조립한 URL의 project-ref 가 운영이 아닙니다. 저장하지 않았습니다.`);
  process.exit(2);
}

// 직결 주소 보존 후 교체
if (!cur.PROD_DB_URL_DIRECT) cur.PROD_DB_URL_DIRECT = cur.PROD_DB_URL;
cur.PROD_DB_URL = next;

writeFileSync(FILE, Object.entries(cur).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
try { chmodSync(FILE, 0o600); } catch {}

console.log("PROD_DB_URL 을 Session pooler 주소로 교체했습니다 (비밀값 미출력).\n");
console.log(`  host              ${host}`);
console.log(`  port              ${port} (Session pooler)`);
console.log(`  user              ${user}`);
console.log(`  project-ref 검증  ${ref} ✅ 운영`);
console.log(`  비밀번호          기존 값 재사용 (재입력·출력 없음)`);
console.log(`  직결 주소         PROD_DB_URL_DIRECT 로 보존`);
