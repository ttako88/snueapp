// ============================================================
// POST /api/verification/begin — 인증 제출 1단계
// ============================================================
// 설계 근거: GATE3_DESIGN.md §4.1
//
// 이 단계에서 회원 상태는 바뀌지 않는다. request 만 'uploading' 으로 생기고
// 삭제 시계는 계속 간다. signed URL 만 받고 업로드하지 않는 악용으로 기한을
// 동결시킬 수 없게 하려는 것이 2단계 분리의 이유다.
//
// 응답에 담지 않는 것: HMAC, key_version, storage_path, 기존 계정 정보.
// 학번 원문은 계산 직후 버리며 로그·오류 어디에도 남기지 않는다.
// ============================================================
import { NextResponse } from "next/server";
import { serviceClient, requireUser, NO_STORE } from "../../../lib/server/verification/auth.mjs";
import {
  normalizeStudentNo, normalizeRealName, normalizeDocType,
  computeHmacs, VerifyInputError, VerifyConfigError,
} from "../../../lib/server/verification/hmac.mjs";
import { VERIFY_BUCKET, buildStagingPath, UPLOAD_URL_TTL_SEC } from "../../../lib/server/verification/files.mjs";

export const runtime = "nodejs";

const json = (body, status) =>
  NextResponse.json(body, { status, headers: NO_STORE });

export async function POST(request) {
  let svc;
  try { svc = serviceClient(); }
  catch { return json({ error: "service_unavailable" }, 503); }

  const who = await requireUser(request, svc);
  if (who.error) return json({ error: who.error }, who.status);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "bad_request" }, 400); }

  // --- 입력 정규화 ---------------------------------------------------------
  let realName, docType, hmacs, keyVers, currentVer;
  try {
    realName = normalizeRealName(body?.realName);
    docType = normalizeDocType(body?.docType);
    const studentNo = normalizeStudentNo(body?.studentNo);
    ({ hmacs, keyVers, currentVer } = computeHmacs(studentNo, process.env));
    // studentNo 는 여기서 스코프를 벗어난다. 이 아래로 원문을 옮기지 않는다.
  } catch (e) {
    if (e instanceof VerifyInputError) return json({ error: "invalid_input", code: e.code }, 400);
    if (e instanceof VerifyConfigError) return json({ error: "service_unavailable" }, 503);
    return json({ error: "bad_request" }, 400);
  }

  // --- 1) request 생성 (쓰기 한 번) ---
  // staging 경로는 request id 를 쓰지 않고 무작위로 만든다. 그래서 INSERT 전에
  // 경로가 확정되고, "INSERT 뒤 경로 UPDATE" 라는 창이 아예 없다. 그 창이
  // 있으면 사이에 서버가 죽었을 때 경로 없는 uploading 행이 남는다.
  const stagingPath = buildStagingPath(who.userId);
  const { data: newId, error: rpcErr } = await svc.rpc("begin_verification", {
    p_member_id: who.userId,
    p_hmacs: hmacs,
    p_key_vers: keyVers,
    p_current_ver: currentVer,
    p_real_name: realName,
    p_doc_type: docType,
    p_storage_path: stagingPath,
  });

  if (rpcErr) {
    const msg = String(rpcErr.message || "");
    // DB 가 구분해 주는 사유만 사용자에게 전달한다. 그 외는 뭉뚱그린다 —
    // "이미 가입된 계정이 있다" 같은 정보가 새 나가면 안 된다.
    if (/unverifiable student number/.test(msg)) return json({ error: "student_no_unverifiable" }, 409);
    if (/not eligible/.test(msg)) return json({ error: "not_eligible" }, 409);
    if (/duplicate key|unique/i.test(msg)) return json({ error: "already_in_progress" }, 409);
    return json({ error: "begin_failed" }, 500);
  }

  const requestId = String(newId);

  // --- 2) 업로드용 signed URL ---
  const { data: signed, error: signErr } = await svc.storage
    .from(VERIFY_BUCKET)
    .createSignedUploadUrl(stagingPath, { upsert: true });
  if (signErr || !signed) {
    // 서명 실패는 아직 사용자에게 쓰기 권한이 나가기 **전**이다. 이 시점의
    // 되돌리기는 단순 withdrawn 으로 충분하다 — 올라간 객체가 있을 수 없다.
    // (권한이 이미 나간 뒤라면 객체 정리까지 해야 한다. finalize 쪽 참조.)
    await svc.rpc("svc_abort_uploading_request", {
      p_request_id: requestId, p_member_id: who.userId,
    });
    return json({ error: "storage_unavailable" }, 503);
  }

  // token/path 는 업로드에 반드시 필요하므로 반환한다. 이 토큰은 staging
  // 경로에만 유효하고, 심사자가 보는 verified 경로는 서버만 쓸 수 있다.
  return json({
    requestId,
    bucket: VERIFY_BUCKET,
    path: signed.path ?? stagingPath,
    token: signed.token,
    expiresInSec: UPLOAD_URL_TTL_SEC,
  }, 200);
}
