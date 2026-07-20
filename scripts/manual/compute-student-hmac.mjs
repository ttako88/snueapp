// ============================================================
// compute-student-hmac.mjs  (P0-4 — 사용자 로컬 전용 도구)
// ============================================================
// 목적: owner 부트스트랩에 넣을 학번 HMAC(hex 64자)을 "사용자 로컬에서만" 계산.
//   학번 원문·HMAC 키는 이 프로세스 밖(채팅·로그·git·클립보드 공유)으로 내보내지 않는다.
//
// 사용법 (사용자 본인 터미널에서):
//   1) 키를 env로 주입 (셸 히스토리에 안 남게 프롬프트 입력 권장):
//        PowerShell:  $env:STUDENT_NO_HMAC_KEY_V1 = Read-Host -MaskInput "hmac key"
//   2) 실행:         node scripts/manual/compute-student-hmac.mjs
//   3) 프롬프트에 학번 입력(화면 비표시) → HMAC hex 64자만 출력됨
//   4) 출력된 hex를 bootstrap-owner.sql의 __STUDENT_NO_HMAC__ 자리에 붙여넣기
//   5) 끝나면 창을 닫아 env를 버린다 ($env:STUDENT_NO_HMAC_KEY_V1 = $null)
//
// 학번은 argv로 받지 않는다(셸 히스토리 방지). stdin raw 모드로 비에코 입력.
// ============================================================
import { createHmac } from "node:crypto";
import { stdin, stdout, exit, env } from "node:process";

const key = env.STUDENT_NO_HMAC_KEY_V1;
if (!key || key.length < 32) {
  console.error("[fail] STUDENT_NO_HMAC_KEY_V1 env가 없거나 32자 미만입니다.");
  exit(1);
}

stdout.write("학번 입력(화면에 표시되지 않음, Enter로 확정): ");
stdin.setRawMode?.(true);
stdin.resume();
stdin.setEncoding("utf8");

let buf = "";
stdin.on("data", (ch) => {
  if (ch === "\r" || ch === "\n") {
    stdin.setRawMode?.(false);
    stdin.pause();
    stdout.write("\n");
    const studentNo = buf.trim();
    if (!/^[0-9]{6,12}$/.test(studentNo)) {
      console.error("[fail] 학번 형식이 아님(숫자 6~12자리). 아무것도 출력하지 않음.");
      exit(1);
    }
    const hmac = createHmac("sha256", key).update(studentNo).digest("hex");
    // 출력은 HMAC hex 하나뿐 — 학번·키는 어디에도 출력하지 않는다.
    console.log(hmac);
    exit(0);
  } else if (ch === "") { // Ctrl+C
    stdin.setRawMode?.(false);
    stdout.write("\n[중단]\n");
    exit(130);
  } else if (ch === "" || ch === "\b") {
    buf = buf.slice(0, -1);
  } else {
    buf += ch;
  }
});
