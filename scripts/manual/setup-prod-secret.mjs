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
//   학번 8자리          → 입력 즉시 HMAC으로 변환, 원문은 저장하지 않음
//   (HMAC 키가 없으면 자동 생성)
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
import { randomBytes, createHmac } from "node:crypto";
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

  // 3) 학번 HMAC 키 — 없으면 조용히 생성 (물어볼 이유가 없다)
  if (!cur.STUDENT_NO_HMAC_KEY_V1) {
    cur.STUDENT_NO_HMAC_KEY_V1 = randomBytes(32).toString("hex");
    cur.STUDENT_NO_HMAC_CURRENT_VERSION = "1";
    console.log("  (학번 HMAC 키가 없어 새로 생성했습니다 — 화면 비표시)");
  }

  // 4) 학번 → 여기서 바로 HMAC까지 만든다.
  //    별도 스크립트를 두 번 돌리게 하지 않는다. 원문은 메모리에서만 쓰고
  //    **파일에도 화면에도 남기지 않으며**, 저장되는 건 hex 64자뿐이다.
  const sid = await askHidden("학번 8자리 (입력 즉시 HMAC으로 변환, 원문 미저장): ");
  if (sid) {
    if (!/^[0-9]{8}$/.test(sid)) {
      console.error("[거부] 학번은 숫자 8자리여야 합니다. 저장하지 않았습니다.");
      exit(2);
    }
    const ver = parseInt(cur.STUDENT_NO_HMAC_CURRENT_VERSION, 10);
    cur.OWNER_STUDENT_NO_HMAC = createHmac("sha256", cur[`STUDENT_NO_HMAC_KEY_V${ver}`])
      .update(sid).digest("hex");
    cur.OWNER_HMAC_KEY_VERSION = String(ver);
    console.log("  → HMAC 생성 완료. 학번 원문은 저장하지 않았습니다.");
  }

  const body = Object.entries(cur).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  writeFileSync(FILE, body, { mode: 0o600 });
  try { chmodSync(FILE, 0o600); } catch {}

  console.log("\n저장 완료: .env.prod.local (git 비추적)");
  for (const k of ["PROD_DB_URL", "OWNER_REAL_NAME", "OWNER_STUDENT_NO_HMAC",
                   "OWNER_HMAC_KEY_VERSION", "STUDENT_NO_HMAC_KEY_V1"]) {
    console.log(`  ${k.padEnd(24)} ${mask(cur[k])}`);
  }
  console.log("\n이걸로 끝입니다. 나머지는 Claude가 이 파일을 읽어 진행합니다.");
  console.log("(학번 원문은 파일·화면·로그 어디에도 남지 않았습니다)");
}

main().catch((e) => { console.error("[fail]", e.message); exit(1); });
