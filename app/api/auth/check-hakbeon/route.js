// ============================================================
// POST /api/auth/check-hakbeon — 학번 중복확인 (가입 전, 원문 미저장)
// ============================================================
// 학번 HMAC 은 서버 키로만 계산되므로 아이디·닉네임처럼 클라 RPC 로 못 한다.
// 이 라우트가 원문을 받아 정규화·HMAC 후 중복만 판정한다. 원문·HMAC 은
// 응답에 담지 않는다(available 불리언 + 사유코드만).
import { NextResponse } from "next/server";
import { serviceClient, NO_STORE } from "../../../lib/server/verification/auth.mjs";
import {
  normalizeStudentNo, computeHmacs, VerifyInputError,
} from "../../../lib/server/verification/hmac.mjs";

export const runtime = "nodejs";
const json = (b, s) => NextResponse.json(b, { status: s, headers: NO_STORE });

export async function POST(request) {
  let svc;
  try { svc = serviceClient(); } catch { return json({ error: "service_unavailable" }, 503); }

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }

  let hmacs, keyVers;
  try {
    const normalized = normalizeStudentNo(body?.hakbeon);
    ({ hmacs, keyVers } = computeHmacs(normalized, process.env));
  } catch (e) {
    // 형식 오류는 200 + available:false 로 준다(폼이 사유를 표시하게).
    if (e instanceof VerifyInputError) return json({ available: false, reason: e.code }, 200);
    return json({ error: "server_config" }, 503);
  }

  const { data, error } = await svc.rpc("svc_hakbeon_exists", { p_hmacs: hmacs, p_key_vers: keyVers });
  if (error) return json({ error: "check_failed" }, 503);
  return json({ available: data !== true, reason: data === true ? "hakbeon_taken" : null }, 200);
}
