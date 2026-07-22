// ============================================================
// POST /api/auth/signup — 아이디·이메일·비번·학번·닉네임 회원가입
// ============================================================
// 보안·개인정보 경계: 학번 원문은 이 라우트 밖으로 나가지 않는다(HMAC 만 저장).
// 순서: 검증 → 학번 HMAC → 중복검사(학번·아이디·닉네임) → 계정생성 →
//       원자적 확정(username·nickname·account_identity·동의) → 실패 시 계정 정리.
// on_auth_user_created 트리거가 members 행을 만들므로 여기선 확정(update/insert)만.
import { NextResponse } from "next/server";
import { serviceClient, NO_STORE } from "../../../lib/server/verification/auth.mjs";
import {
  normalizeStudentNo, computeHmacs, VerifyInputError,
} from "../../../lib/server/verification/hmac.mjs";

export const runtime = "nodejs";
const json = (b, s) => NextResponse.json(b, { status: s, headers: NO_STORE });

// 동의 문구 버전 — 문구를 바꾸면 올린다(어느 버전에 동의했는지 남기기 위해).
const CONSENT_VERSION = "2026-07-23";

export async function POST(request) {
  let svc;
  try { svc = serviceClient(); } catch { return json({ error: "service_unavailable" }, 503); }

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }
  const { username, email, password, hakbeon, nickname, analyticsConsent, hakbeonConsent } = body || {};

  // 학번 수집동의는 필수 — 없으면 가입 자체를 진행하지 않는다.
  if (hakbeonConsent !== true) return json({ error: "hakbeon_consent_required" }, 400);

  // 형식 검증 (서버가 최종 판정 — 클라 값 신뢰하지 않음)
  if (typeof username !== "string" || !/^[A-Za-z0-9_]{4,20}$/.test(username))
    return json({ error: "username_format" }, 400);
  if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()))
    return json({ error: "email_format" }, 400);
  if (typeof password !== "string" || password.length < 6)
    return json({ error: "password_format" }, 400);
  const nick = typeof nickname === "string" ? nickname.trim() : "";
  if (nick.length < 2 || nick.length > 16)
    return json({ error: "nickname_format" }, 400);

  // 학번 정규화 + HMAC (원문은 여기서만, 밖으로 안 나감)
  let hmacs, keyVers, currentVer;
  try {
    const normalized = normalizeStudentNo(hakbeon);
    ({ hmacs, keyVers, currentVer } = computeHmacs(normalized, process.env));
  } catch (e) {
    if (e instanceof VerifyInputError) return json({ error: e.code }, 400);
    // VerifyConfigError 등 — 서버 설정 문제(HMAC 키 미등록). 원인 상세는 감춘다.
    return json({ error: "server_config" }, 503);
  }
  const currentHmac = hmacs[keyVers.indexOf(currentVer)];

  // 학번 중복(전 키버전 대조) — 1인1계정
  {
    const { data, error } = await svc.rpc("svc_hakbeon_exists", { p_hmacs: hmacs, p_key_vers: keyVers });
    if (error) return json({ error: "check_failed" }, 503);
    if (data === true) return json({ error: "hakbeon_taken" }, 409);
  }
  // 아이디·닉네임 사전 중복확인(빠른 거절)
  {
    const { data } = await svc.rpc("username_available", { p_username: username });
    if (data !== true) return json({ error: "username_taken" }, 409);
  }
  {
    const { data } = await svc.rpc("nickname_available", { p_nick: nick });
    if (data !== true) return json({ error: "nickname_taken" }, 409);
  }

  // 계정 생성 (email 즉시 사용 — v1. 실메일 클릭인증은 후속.)
  const { data: created, error: cErr } = await svc.auth.admin.createUser({
    email: email.trim(), password, email_confirm: true,
  });
  if (cErr || !created?.user?.id) {
    const m = String(cErr?.message || "").toLowerCase();
    if (/already|registered|exists|duplicate/.test(m)) return json({ error: "email_taken" }, 409);
    return json({ error: "signup_failed" }, 400);
  }
  const uid = created.user.id;

  // 원자적 확정 (username·nickname·account_identity·동의)
  const { data: fin, error: fErr } = await svc.rpc("svc_finalize_signup", {
    p_member_id: uid, p_username: username, p_nickname: nick,
    p_hakbeon_hmac: currentHmac, p_key_ver: currentVer,
    p_analytics_granted: analyticsConsent === true, p_consent_version: CONSENT_VERSION,
  });
  if (fErr || fin?.ok !== true) {
    // 확정 실패(경합 등) → 방금 만든 계정을 지워 고아를 남기지 않는다.
    try { await svc.auth.admin.deleteUser(uid); } catch { /* 정리 실패는 운영 확인 대상 */ }
    return json({ error: fErr ? "signup_failed" : (fin?.reason || "signup_failed") }, 409);
  }

  // 세션은 클라이언트가 이메일·비번으로 곧바로 로그인해 받는다(라우트가 토큰을 쥐지 않음).
  return json({ ok: true, email: email.trim() }, 200);
}
