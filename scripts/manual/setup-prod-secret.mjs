// ============================================================
// setup-prod-secret.mjs — 운영 비밀값을 로컬에 안전하게 등록
// ============================================================
// 왜 이 도구가 필요한가:
//   운영 접속문자열을 채팅에 붙이면 대화 기록에 영구히 남고, git에 넣으면 파일을
//   지워도 커밋 이력에 남는다. 이 스크립트는 **화면에 찍지 않고** 로컬
//   .env.prod.local(git 비추적)에만 기록한다.
//
// 사용 (본인 터미널에서 — 반드시 실제 TTY):
//   node scripts/manual/setup-prod-secret.mjs
//
// 입력받는 값 (엔터만 치면 건너뜀 — 나중에 다시 실행해 채워도 됨):
//   PROD_DB_URL          운영 Postgres 접속문자열
//   OWNER_REAL_NAME      owner 부트스트랩용 실명
//   STUDENT_NO_HMAC_KEY_V1  학번 HMAC 키 (없으면 이 스크립트가 생성 제안)
//
// 안전장치:
//   · TTY가 아니면 즉시 중단(파이프·CI로 흘리지 못하게)
//   · 입력은 화면에 표시하지 않음
//   · PROD_DB_URL은 구조 검증 후 **운영 ref가 맞을 때만** 저장, dev ref면 거부
//   · 값은 어디에도 출력하지 않고 길이·마스킹만 보여줌
//   · 파일 권한을 소유자 전용으로 제한 시도
// ============================================================
import { writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { stdin, stdout, exit } from "node:process";
import { randomBytes } from "node:crypto";
import { PROD_REF, DEV_REF, refOf } from "./dev-url.mjs";

const FILE = resolve(process.cwd(), ".env.prod.local");

if (!stdin.isTTY) {
  console.error("[중단] 실제 터미널에서만 실행할 수 있습니다 (파이프·리다이렉트 금지).");
  exit(1);
}

// 화면에 찍지 않는 입력
function askHidden(label) {
  return new Promise((res) => {
    stdout.write(label);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    let buf = "";
    const onData = (ch) => {
      const s = ch.toString("utf8");
      if (s === "\r" || s === "\n") {
        stdin.setRawMode(wasRaw);
        stdin.pause();
        stdin.off("data", onData);
        stdout.write("\n");
        res(buf.trim());
      } else if (s === "") {           // Ctrl+C
        stdout.write("\n중단\n");
        exit(130);
      } else if (s === "" || s === "\b") {
        buf = buf.slice(0, -1);
      } else {
        buf += s;
      }
    };
    stdin.on("data", onData);
  });
}

const mask = (v) => (v ? `설정됨 (${v.length}자)` : "건너뜀");

function loadExisting() {
  if (!existsSync(FILE)) return {};
  const out = {};
  for (const line of readFileSync(FILE, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function main() {
  console.log("운영 비밀값 등록 — 입력은 화면에 표시되지 않습니다.");
  console.log("엔터만 치면 그 항목은 건너뜁니다.\n");

  const cur = loadExisting();

  // 1) 운영 DB 접속문자열
  const dbUrl = await askHidden("PROD_DB_URL (운영 Postgres 접속문자열): ");
  if (dbUrl) {
    let ref;
    try {
      ref = refOf(dbUrl);
    } catch {
      console.error("[거부] 접속문자열 형식이 아닙니다. 저장하지 않았습니다.");
      exit(2);
    }
    if (ref === DEV_REF) {
      console.error("[거부] dev 프로젝트 주소입니다. 운영 값이 필요합니다.");
      exit(2);
    }
    if (ref !== PROD_REF) {
      console.error(`[거부] 예상한 운영 프로젝트가 아닙니다. 저장하지 않았습니다.`);
      exit(2);
    }
    cur.PROD_DB_URL = dbUrl;
  }

  // 2) owner 실명
  const name = await askHidden("OWNER_REAL_NAME (owner 부트스트랩용 실명): ");
  if (name) cur.OWNER_REAL_NAME = name;

  // 3) 학번 HMAC 키 — 없으면 생성해 준다
  if (!cur.STUDENT_NO_HMAC_KEY_V1) {
    const ans = await askHidden("학번 HMAC 키가 없습니다. 새로 생성할까요? (y 입력): ");
    if (ans.toLowerCase() === "y") {
      cur.STUDENT_NO_HMAC_KEY_V1 = randomBytes(32).toString("hex");
      cur.STUDENT_NO_HMAC_CURRENT_VERSION = "1";
      console.log("  → 새 키를 생성해 저장했습니다(화면 비표시).");
    }
  }

  const body = Object.entries(cur).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  writeFileSync(FILE, body, { mode: 0o600 });
  try { chmodSync(FILE, 0o600); } catch {}

  console.log("\n저장 완료: .env.prod.local (git 비추적)");
  for (const k of ["PROD_DB_URL", "OWNER_REAL_NAME", "STUDENT_NO_HMAC_KEY_V1", "STUDENT_NO_HMAC_CURRENT_VERSION"]) {
    console.log(`  ${k.padEnd(30)} ${mask(cur[k])}`);
  }
  console.log("\n다음: 학번은 이 파일에 넣지 말고, 아래를 본인 터미널에서 실행해 HMAC만 만들어 주세요.");
  console.log("  node scripts/manual/compute-student-hmac.mjs");
  console.log("  (학번 원문은 그 프로세스 밖으로 나가지 않고, 결과 hex만 남습니다)");
}

main().catch((e) => { console.error("[fail]", e.message); exit(1); });
