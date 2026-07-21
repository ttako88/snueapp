// ============================================================
// auth.mjs — 라우트 공통: 요청자 신원 확인 (서버 전용)
// ============================================================
// service_role 클라이언트는 RLS 를 우회한다. 그래서 "누가 호출했는지" 는
// 서버가 직접 판정해야 하고, 클라이언트가 보낸 member_id 같은 값은 절대
// 신뢰하지 않는다. Authorization 헤더의 access token 을 Supabase 에
// 검증시켜 얻은 uid 만 쓴다.
// ============================================================
import { createServiceClient } from "../maintenance/serviceClient.mjs";

if (typeof window !== "undefined") {
  throw new Error("verification/auth.mjs는 서버 전용입니다");
}

export function serviceClient(env = process.env) {
  // maintenance 쪽 팩토리는 SUPABASE_URL 을 요구한다. URL 자체는 비밀이 아니고
  // 이미 NEXT_PUBLIC_ 으로 배포돼 있으므로, 둘 중 있는 쪽을 쓴다.
  // 반면 SUPABASE_SECRET_KEY 는 대체값을 만들지 않는다 — 없으면 실패해야 한다.
  return createServiceClient({
    ...env,
    SUPABASE_URL: env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL,
  });
}

/**
 * @returns {{ userId: string } | { error: string, status: number }}
 */
export async function requireUser(request, svc) {
  const header = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return { error: "unauthorized", status: 401 };

  const { data, error } = await svc.auth.getUser(m[1]);
  if (error || !data?.user?.id) return { error: "unauthorized", status: 401 };
  return { userId: data.user.id };
}

/**
 * 심사 권한 확인. 역할 판정을 서버에서 다시 하는 이유는, 관리 화면이
 * 클라이언트 코드라 언제든 우회될 수 있기 때문이다.
 * private.members 를 service_role 로 직접 읽는다.
 */
export async function requireModerator(svc, userId) {
  // ⚠ private 스키마를 직접 읽지 않는다. PostgREST 가 노출하는 스키마는
  //   public·graphql_public 뿐이라 service_role 이라도 406 PGRST106 이 난다.
  //   private 비노출은 이 프로젝트 보안 설계의 전제이므로 노출하는 방향이 아니라
  //   필요한 판정만 함수로 뚫는 방향으로 간다 (017).
  const { data, error } = await svc.rpc("svc_reviewer_role", { p_actor_id: userId });
  if (error) return { error: "forbidden", status: 403 };
  // 자격이 없으면 함수가 아무 행도 반환하지 않는다 → null
  return data ? { role: data } : { error: "forbidden", status: 403 };
}

/** 응답에 공통으로 붙이는 헤더 — 인증 관련 응답은 어디에도 캐시되면 안 된다. */
export const NO_STORE = { "Cache-Control": "no-store" };
