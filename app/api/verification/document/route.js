// ============================================================
// POST /api/verification/document — 심사용 증빙 열람 (60초 signed URL)
// ============================================================
// 설계 근거: GATE3_DESIGN.md §4.3
//
// 버킷은 비공개이고 anon/authenticated 정책이 0개다. 열람은 오직 이 라우트가
// 발급하는 60초 signed URL 로만 이루어진다.
//
// 경로는 클라이언트가 보낼 수 없다. requestId 만 받고 서버가 DB 에서 경로를
// 조회한다. 그리고 발급 사실을 audit 에 남긴다 — 남의 신분증을 열어 보는
// 행위는 흔적이 남아야 한다.
// ============================================================
import { NextResponse } from "next/server";
import { serviceClient, requireUser, requireModerator, NO_STORE } from "../../../lib/server/verification/auth.mjs";
import { VERIFY_BUCKET, VIEW_URL_TTL_SEC, isVerifiedPath } from "../../../lib/server/verification/files.mjs";

export const runtime = "nodejs";

const json = (body, status) => NextResponse.json(body, { status, headers: NO_STORE });

export async function POST(request) {
  let svc;
  try { svc = serviceClient(); }
  catch { return json({ error: "service_unavailable" }, 503); }

  const who = await requireUser(request, svc);
  if (who.error) return json({ error: who.error }, who.status);

  const gate = await requireModerator(svc, who.userId);
  if (gate.error) return json({ error: gate.error }, gate.status);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "bad_request" }, 400); }

  const requestId = String(body?.requestId ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(requestId)) return json({ error: "bad_request" }, 400);

  // 자격 검사는 RPC 안에서 한 번 더 한다 — 위 requireModerator 를 통과했더라도,
  // 이 함수를 쓰는 다른 경로가 생겼을 때 자격 확인을 빠뜨릴 수 없게 하기 위함.
  const { data: req, error: qErr } = await svc.rpc(
    "svc_get_verification_request_for_review",
    { p_request_id: requestId, p_actor_id: who.userId });
  if (qErr) return json({ error: "lookup_failed" }, 500);
  if (!req) return json({ error: "not_found" }, 404);
  if (req.purged) return json({ error: "purged" }, 410);
  // 심사 대상이 아닌 신청의 문서까지 열 이유는 없다.
  if (req.status !== "submitted") return json({ error: "not_reviewable" }, 409);

  // 심사자에게 보여 줄 것은 검증을 통과해 서버가 옮겨 놓은 정본뿐이다.
  // staging 경로는 사용자가 아직 덮어쓸 수 있으므로 열지 않는다.
  if (!isVerifiedPath(req.storage_path)) return json({ error: "not_reviewable" }, 409);

  const { data: signed, error: sErr } = await svc.storage
    .from(VERIFY_BUCKET)
    .createSignedUrl(req.storage_path, VIEW_URL_TTL_SEC);
  if (sErr || !signed?.signedUrl) return json({ error: "storage_unavailable" }, 503);

  // 열람 기록이 남지 않으면 URL 을 주지 않는다 (fail-closed).
  // 경고만 띄우고 열어 주면 "기록되지 않은 접근" 이 가능해진다 — 남의 신분증을
  // 흔적 없이 볼 수 있다는 뜻이다. 여기서 만든 URL 은 전달하지 않으면
  // 60초 뒤 그냥 만료된다.
  //
  // 이름은 DOCUMENT_VIEWED 가 아니라 SIGNED_URL_ISSUED 다. URL 을 발급한
  // 사실과 브라우저가 실제로 바이트를 받아 간 사실은 다르고, 여기서 아는
  // 것은 앞의 것뿐이다. 실제 다운로드까지 감사하려면 서버 프록시가 필요하다.
  let audited = false;
  try {
    const { data, error: aErr } = await svc.rpc("svc_log_verification_access", {
      p_actor_id: who.userId,
      p_action: "verification_document_signed_url_issued",
      p_request_id: requestId,
    });
    audited = !aErr && data === true;
  } catch { audited = false; }
  if (!audited) return json({ error: "audit_unavailable" }, 503);

  return json({ url: signed.signedUrl, expiresInSec: VIEW_URL_TTL_SEC }, 200);
}
