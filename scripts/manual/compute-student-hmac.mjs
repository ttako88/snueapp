// ============================================================
// compute-student-hmac.mjs  v2 (P0-4 — GPT 검수 B-5·B-6·B-7 반영, 사용자 로컬 전용)
// ============================================================
// 목적: owner 부트스트랩에 넣을 학번 HMAC(hex 64자)을 "사용자 로컬에서만" 계산.
//   학번 원문·HMAC 키는 이 프로세스 밖(채팅·로그·git·클립보드 공유)으로 내보내지 않는다.
//
// 사용법 (사용자 본인 터미널에서 — 반드시 실제 TTY):
//   1) 키 버전과 키를 env로 주입 (셸 히스토리에 안 남게 프롬프트 입력 권장):
//        PowerShell:  $env:STUDENT_NO_HMAC_CURRENT_VERSION = "1"
//                     $env:STUDENT_NO_HMAC_KEY_V1 = Read-Host -MaskInput "hmac key v1"
//   2) 실행:         node scripts/manual/compute-student-hmac.mjs
//   3) 프롬프트에 학번 8자리 입력(화면 비표시) → "version=N" 과 HMAC hex 출력
//   4) hex → bootstrap-owner.sql __STUDENT_NO_HMAC__, version → __HMAC_KEY_VERSION__
//      (둘의 version이 같은지 직접 대조 — B-5)
//   5) 끝나면 창을 닫아 env를 버린다 ($env:STUDENT_NO_HMAC_KEY_V1 = $null)
//
// 학번은 argv로 받지 않는다(셸 히스토리 방지). TTY가 아니면 즉시 중단(fail-closed).
// 학번 형식: 정확히 숫자 8자리 (^[0-9]{8}$ — SNUE 확정 형식, 서버 인증 경로와 동일 규칙)
// ============================================================
import { createHmac } from "node:crypto";
import { stdin, stdout, exit, env } from "node:process";

// ── 키 버전 결정 (B-5: 하드코딩 금지 — CURRENT_VERSION이 가리키는 키만 사용) ──
const verRaw = env.STUDENT_NO_HMAC_CURRENT_VERSION;
if (!verRaw || !/^[0-9]{1,4}$/.test(verRaw) || parseInt(verRaw, 10) < 1) {
  console.error("[fail] STUDENT_NO_HMAC_CURRENT_VERSION env가 없거나 양의 정수가 아닙니다.");
  exit(1);
}
const version = parseInt(verRaw, 10);
const key = env[`STUDENT_NO_HMAC_KEY_V${version}`];
// 키 길이는 문자 수가 아니라 바이트 길이로 검사 (B-7)
if (!key || Buffer.byteLength(key, "utf8") < 32) {
  console.error(`[fail] STUDENT_NO_HMAC_KEY_V${version} env가 없거나 32바이트 미만입니다.`);
  exit(1);
}

// ── TTY 강제 (B-7: raw mode 불가 환경이면 입력이 화면에 노출될 수 있음 → 중단) ──
if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
  console.error("[fail] 실제 터미널(TTY)에서만 실행할 수 있습니다 (파이프·리다이렉트 금지).");
  exit(1);
}

const MAX_LEN = 8; // 학번 8자리 고정 — 초과 입력은 즉시 거부
let buf = "";
let done = false;

function restoreAndExit(code, msg) {
  if (done) return;
  done = true;
  try { stdin.setRawMode(false); } catch {}
  stdin.pause();
  if (msg) console.error(msg);
  exit(code);
}
process.on("uncaughtException", (e) => restoreAndExit(1, "[fail] 예외: " + e.message));

stdout.write("학번 8자리 입력(화면에 표시되지 않음, Enter로 확정): ");
stdin.setRawMode(true);
stdin.resume();
stdin.setEncoding("utf8");

stdin.on("data", (chunk) => {
  // B-7: 붙여넣기로 "12345678\r"가 한 chunk로 와도 문자 단위로 처리
  for (const ch of chunk) {
    if (ch === "") { // Ctrl+C
      stdout.write("\n");
      restoreAndExit(130, "[중단]");
      return;
    }
    if (ch === "\r" || ch === "\n") {
      stdout.write("\n");
      const studentNo = buf;
      buf = "";
      if (!/^[0-9]{8}$/.test(studentNo)) {
        restoreAndExit(1, "[fail] 학번 형식이 아님(정확히 숫자 8자리). 아무것도 출력하지 않음.");
        return;
      }
      const hmac = createHmac("sha256", key).update(studentNo).digest("hex");
      // 출력은 version과 HMAC hex뿐 — 학번·키는 어디에도 출력하지 않는다.
      console.log(`version=${version}`);
      console.log(hmac);
      restoreAndExit(0);
      return;
    }
    if (ch === "" || ch === "\b") { // Backspace
      buf = buf.slice(0, -1);
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      if (buf.length >= MAX_LEN) { // 과도한 입력 즉시 거부
        restoreAndExit(1, "\n[fail] 8자리를 초과해 입력됨 — 다시 실행하세요.");
        return;
      }
      buf += ch;
    } else {
      // 숫자 외 문자(제어문자 포함)는 즉시 거부 — 잘못 붙여넣은 경우 안전 중단
      restoreAndExit(1, "\n[fail] 숫자가 아닌 입력 감지 — 다시 실행하세요.");
      return;
    }
  }
});
