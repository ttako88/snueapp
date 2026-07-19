// [뼈대 — Gate 5+에서 구현] 서버 전용 Supabase 클라이언트 (service_role).
//
// 용도(감사보고서 12.6): 비회원 미리보기 판정, 운영자 명령, 신원조회 등
// "요청자를 신뢰할 수 없거나 RLS의 의도적 예외가 필요한" 서버 경계 전용.
//
// 규칙:
//  - 이 파일은 Route Handler·서버 코드에서만 import 한다 (클라이언트 번들 유입 금지).
//  - 키는 SUPABASE_SECRET_KEY (서버 전용 env) — NEXT_PUBLIC_ 접두사 절대 금지.
//  - 사용 지점을 최소화하고, 호출부마다 자체 권한 검사를 심층 방어로 둔다.
//
// 실제 구현은 secret 키가 필요해지는 Gate 5에서 추가한다. 지금은 자리만.

if (typeof window !== "undefined") {
  // 클라이언트 번들에 섞여 들어오면 즉시 알아차리도록
  throw new Error("supabase/server.js는 서버 전용입니다 — 클라이언트에서 import 금지");
}

export function getServiceClient() {
  throw new Error("server-only Supabase 클라이언트는 Gate 5에서 구현됩니다");
}
