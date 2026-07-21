// 서버 라우트를 부를 때 쓰는 얇은 래퍼.
//
// service_role 이 필요한 작업(학번 HMAC 계산, signed URL 발급)은 브라우저에서
// RPC 로 못 부른다. 대신 라우트를 부르되, 라우트가 "누가 불렀는지" 알 수 있게
// 세션 access token 을 Authorization 으로 실어 보낸다. 서버는 이 토큰을
// 검증해서 얻은 uid 만 신뢰하고, 본문에 든 사용자 식별값은 믿지 않는다.

import { supabase } from "../supabase/client";

export async function authedPost(path, body) {
  if (!supabase) return { error: { code: "service_unavailable" } };
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return { error: { code: "unauthorized" } };

  let res;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    return { error: { code: "network" } };
  }
  // 라우트가 없거나 서버가 죽으면 JSON 이 아닐 수 있다.
  let payload = null;
  try { payload = await res.json(); } catch { /* 아래에서 처리 */ }
  if (!res.ok) {
    // code 가 더 구체적이면 그쪽을 쓴다 (invalid_input + code: student_no_format).
    return { error: { code: payload?.code || payload?.error || "unknown" } };
  }
  return { data: payload };
}
