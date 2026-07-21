// 가입·로그인 정책 스위치.
//
// 이 파일 하나로 "누가 가입할 수 있는가" 를 바꾼다. 화면 여러 곳에 조건이
// 흩어져 있으면 DB 는 열었는데 화면이 막는(또는 그 반대) 상태가 생긴다.
//
// ⚠️ 이건 UX 스위치일 뿐 보안 경계가 아니다. 진짜 잠금은 DB 트리거
//    (private.enforce_snue_email, 010) 이고, 여기서 열어도 DB 가 막으면 막힌다.
//    **둘을 반드시 함께 바꿔야 한다** — 한쪽만 바꾸면 "왜 안 되는지 알 수 없는"
//    상태가 된다.
//
// 전환 순서 (015 적용 시):
//   1. supabase/migrations/pending/015_drop_email_domain_gate.sql 적용
//   2. 이 파일의 OPEN_SIGNUP 을 true 로
//   3. 같은 배포에 둘 다 포함
//   순서를 바꾸면 열린 줄 알았는데 DB 가 막거나, 화면이 막는데 DB 는 열린다.

/**
 * false = 서울교대 이메일만 신규 가입 (010 트리거가 서버에서도 막는다)
 * true  = 모든 이메일 가입 허용 (015 로 트리거를 뗀 뒤에만)
 *
 * 소유자 결정 2026-07-22: 소속 증명은 이메일 도메인이 아니라 학생 인증
 * (재학증명서·학생증)이 맡는다. 도메인 제한은 학교 메일을 안 쓰는 재학생을
 * 배제하고 증명력도 약하다.
 */
export const OPEN_SIGNUP = false;

/** 비밀번호 가입 경로를 여는가. 지금은 메일 링크(OTP)만 쓴다. */
export const ALLOW_PASSWORD_SIGNUP = false;

export const SNUE_EMAIL_RE = /^[^\s@]+@([a-zA-Z0-9-]+\.)*snue\.ac\.kr$/;

/** 이 이메일로 **신규 가입**이 되는가. 기존 계정 로그인은 항상 허용된다. */
export function canSignUp(email) {
  if (OPEN_SIGNUP) return true;
  return SNUE_EMAIL_RE.test(String(email ?? "").trim());
}

/** 가입이 막혔을 때 사용자에게 보일 문구. 정책이 바뀌면 여기만 고친다. */
export function signUpBlockedMessage() {
  return OPEN_SIGNUP
    ? "가입에 실패했어요. 잠시 뒤 다시 시도해 주세요."
    : "서울교대 이메일(@snue.ac.kr 계열)로만 새로 가입할 수 있어요. 기존 계정이라면 다시 시도해 주세요.";
}

/** 로그인 화면 안내 문구. */
export function signUpHint() {
  return OPEN_SIGNUP
    ? "처음이면 자동으로 가입돼요. 가입 뒤 학생 인증을 하면 모든 기능을 쓸 수 있어요."
    : "처음이면 자동으로 가입돼요. 지금은 서울교대 이메일만 가입할 수 있어요.";
}
