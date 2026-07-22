// ============================================================
// POST /api/auth/login — 아이디(username) + 비밀번호 로그인
// ============================================================
// Supabase 는 email 기반이라 아이디→이메일을 서버에서 내부 조회한 뒤 인증한다.
// 이메일은 클라이언트에 노출하지 않는다(계정 열거 방지). 세션 토큰만 돌려주고,
// 클라이언트가 setSession 으로 로컬에 심는다.
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { serviceClient, NO_STORE } from "../../../lib/server/verification/auth.mjs";

export const runtime = "nodejs";
const json = (b, s) => NextResponse.json(b, { status: s, headers: NO_STORE });

export async function POST(request) {
  let svc;
  try { svc = serviceClient(); } catch { return json({ error: "service_unavailable" }, 503); }

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }
  const { username, password } = body || {};
  if (typeof username !== "string" || typeof password !== "string" || !username.trim() || !password)
    return json({ error: "bad_request" }, 400);

  // 아이디 → 이메일 (내부 조회)
  const { data: email, error: e1 } = await svc.rpc("svc_email_for_username", { p_username: username.trim() });
  if (e1) return json({ error: "login_failed" }, 503);

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anon) return json({ error: "service_unavailable" }, 503);

  // 존재하지 않는 아이디도 실제 인증실패와 같은 응답으로 통일(열거 방지).
  if (!email) return json({ error: "invalid_login" }, 401);

  const authClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: signed, error: e2 } = await authClient.auth.signInWithPassword({ email, password });
  if (e2 || !signed?.session) return json({ error: "invalid_login" }, 401);

  return json({
    ok: true,
    access_token: signed.session.access_token,
    refresh_token: signed.session.refresh_token,
  }, 200);
}
