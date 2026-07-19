// [뼈대] 권한 판정의 UX 미러 (감사보고서 12.8).
//
// ⚠️ 보안 집행의 최종 기준은 DB다 (RLS + security definer 함수 + 제약조건).
// 이 파일은 같은 권한표를 화면(버튼 표시·메뉴·안내 문구)과 서버 심층방어에서
// 재사용하기 위한 미러이며, 여기를 통과해도 실제 허용을 의미하지 않는다.
// 불일치가 발견되면 DB 정책이 맞다 — 이 파일을 고친다.
//
// Gate 4a 이후: 확정 권한표(role × verification_status × sanction)를 이곳에
// 구현하고, DB 정책 테스트 결과와 자동화 테스트로 대조한다.
// 지금은 현행 동작(로그인+닉네임 = 쓰기 가능)의 미러만 둔다.

export function canReadBoards(session) {
  return Boolean(session);
}

export function canWrite(session, profile) {
  return Boolean(session && profile);
}
