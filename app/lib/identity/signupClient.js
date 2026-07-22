// 회원가입·아이디 로그인 클라이언트 헬퍼.
// 중복확인은 RPC(anon 허용), 가입/로그인은 서버 라우트(학번 HMAC·이메일 비노출).

import { supabase } from "../supabase/client";

export async function checkUsername(username) {
  if (!supabase) return { available: false, error: "unavailable" };
  const { data, error } = await supabase.rpc("username_available", { p_username: username });
  return { available: data === true, error };
}

export async function checkNickname(nick) {
  if (!supabase) return { available: false, error: "unavailable" };
  const { data, error } = await supabase.rpc("nickname_available", { p_nick: nick });
  return { available: data === true, error };
}

// 학번 중복확인 — HMAC 이 서버 전용이라 라우트로. 원문은 응답에 안 담김.
export async function checkHakbeon(hakbeon) {
  let res, data;
  try {
    res = await fetch("/api/auth/check-hakbeon", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hakbeon }),
    });
    data = await res.json().catch(() => null);
  } catch { return { available: false, error: "network" }; }
  if (!res.ok) return { available: false, error: data?.error || "check_failed" };
  return { available: data?.available === true, reason: data?.reason || null };
}

export async function submitSignup(payload) {
  let res, data;
  try {
    res = await fetch("/api/auth/signup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    data = await res.json().catch(() => null);
  } catch { return { error: "network" }; }
  if (!res.ok || data?.ok !== true) return { error: data?.error || "signup_failed" };
  return { ok: true, email: data.email };
}

// 아이디+비번 로그인 → 서버가 토큰 반환 → 로컬 세션에 심는다.
export async function loginWithUsername(username, password) {
  let res, data;
  try {
    res = await fetch("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    data = await res.json().catch(() => null);
  } catch { return { error: "network" }; }
  if (!res.ok || data?.ok !== true) return { error: data?.error || "login_failed" };
  if (!supabase) return { error: "unavailable" };
  const { error } = await supabase.auth.setSession({
    access_token: data.access_token, refresh_token: data.refresh_token,
  });
  if (error) return { error: error.message };
  return { ok: true };
}
