// ============================================================
// POST /api/verification/finalize — 인증 제출 2단계
// ============================================================
// 설계 근거: GATE3_DESIGN.md §4.1
//
// 불변조건: 파일이 서버 검증을 통과하기 전에는 어떤 경로로도 submitted 가
// 되지 않는다. 그래서 이 라우트는 Storage 에서 객체를 직접 내려받아
// 존재·소유·크기·magic bytes 를 스스로 확인한 뒤에만 RPC 를 부른다.
//
// 클라이언트가 보내는 것은 requestId 하나뿐이다. 경로는 서버가 DB 에서
// 조회한다 — 클라이언트가 경로를 지정할 수 있으면 남의 파일을 자기 신청에
// 붙일 수 있다.
// ============================================================
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { serviceClient, requireUser, NO_STORE } from "../../../lib/server/verification/auth.mjs";
import {
  VERIFY_BUCKET, MAX_BYTES, sniffType,
  isOwnStagingPath, buildVerifiedPath,
} from "../../../lib/server/verification/files.mjs";

export const runtime = "nodejs";

const json = (body, status) => NextResponse.json(body, { status, headers: NO_STORE });

// 모든 외부 I/O 에 명시적 timeout (GPT 020 MUST5). try/catch 와 플랫폼 maxDuration
// 만으로는 "이미 시작된 Storage 작업이 언제 끝나는가" 를 못 막는다. 초과하면 reject
// 되어 바깥 catch 가 선점을 자기 token 으로 해제한다.
const IO_TIMEOUT_MS = 20000;   // Storage 왕복
const RPC_TIMEOUT_MS = 10000;  // DB RPC
function withTimeout(thenable, ms, label) {
  return Promise.race([
    Promise.resolve(thenable),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout:${label}`)), ms)),
  ]);
}

export async function POST(request) {
  let svc;
  try { svc = serviceClient(); }
  catch { return json({ error: "service_unavailable" }, 503); }

  const who = await requireUser(request, svc);
  if (who.error) return json({ error: who.error }, who.status);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "bad_request" }, 400); }

  // bigint 는 JS Number 로 다루면 정밀도를 잃는다. 문자열 그대로 검증해서 넘긴다.
  const requestId = String(body?.requestId ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(requestId)) return json({ error: "bad_request" }, 400);

  // --- 신청 조회: 반드시 본인 것 + uploading 상태만 ---
  // 소유자 대조는 RPC 안에서 한다 — 여기서 조건을 빠뜨려도 남의 신청이 오지 않는다.
  const { data: req, error: qErr } = await svc.rpc("svc_get_own_verification_request", {
    p_request_id: requestId, p_member_id: who.userId,
  });
  if (qErr) return json({ error: "finalize_failed" }, 500);
  if (!req) return json({ error: "not_found" }, 404);
  if (req.status !== "uploading") return json({ error: "not_uploading" }, 409);

  // --- 선점 (token-fenced lease) ------------------------------------------
  // ★ 파일을 건드리기 **전에** 이 요청을 선점하고 **선점 토큰**을 받는다.
  //   선점이 없으면 동시 finalize 두 개가 각자 staging 을 검증한 뒤 같은 경로에
  //   쓴다. 시각만 있는 선점(rev1)은 지연된 stale 작업자를 막지 못했다(GPT BLOCKER).
  //   그래서 이 토큰을 아래 모든 무결성 지점(고유 경로·결합·해제)에 묶는다.
  //
  //   ⚠️ 020_finalize_claim.sql 이 적용돼 있어야 동작한다. 없으면 이 RPC 가
  //      없어 clErr → 503 으로 안전하게 멈춘다(구형 비선점 경로로 fallback 금지).
  let claim, clErr;
  try {
    ({ data: claim, error: clErr } = await withTimeout(
      svc.rpc("svc_claim_verification_finalize", {
        p_request_id: requestId, p_member_id: who.userId,
      }), RPC_TIMEOUT_MS, "claim"));
  } catch {
    // claim 자체가 timeout/throw. 아직 선점 전이라 해제할 것이 없다.
    return json({ error: "verification_unavailable" }, 503);
  }
  // capability fail-closed: 020 RPC 부재/오류면 503. 배포 전 prod-verify-020-applied
  // 로도 막지만 런타임에서도 이중으로 막는다. 절대 구형 경로로 내려가지 않는다.
  if (clErr) return json({ error: "verification_unavailable" }, 503);
  if (claim?.claimed !== true) {
    // 파일을 아무것도 건드리지 않고 끝낸다.
    if (claim?.reason === "in_progress") {
      return json({ error: "already_processing",
                    retryAfterSeconds: claim?.retry_after_seconds ?? 120 }, 409);
    }
    return json({ error: "not_uploading" }, 409);
  }
  const claimToken = claim.claim_token;

  // 선점한 뒤 실패로 끝나는 모든 경로는 **자기 token 으로** 선점을 푼다. token 을
  // 넘겨야 그 사이 재인수한 다른 작업자의 선점을 실수로 풀지 않는다(GPT 020 MUST).
  // 해제 실패는 TTL 이 덮는다.
  const releaseClaim = async () => {
    try {
      await withTimeout(svc.rpc("svc_release_verification_finalize", {
        p_request_id: requestId, p_member_id: who.userId, p_claim_token: claimToken,
      }), RPC_TIMEOUT_MS, "release");
    } catch { /* TTL 이 덮는다 */ }
  };
  const fail = async (body, status) => { await releaseClaim(); return json(body, status); };

  // ★ throw·timeout·예외로 빠지는 경로도 반드시 해제한다(GPT 020 MUST). 알려진
  //   실패는 fail() 이 이미 해제 후 return 하므로 catch 로 오지 않는다. catch 는
  //   fail() 을 거치지 않은 예기치 못한 throw·timeout 만 잡아 token 조건부 해제한다.
  try {
    const path = req.storage_path;
    // 경로는 staging 이어야 한다. 원자적 finalize 라 "storage_path 는 verified 인데
    // status 는 uploading" 인 중간 상태는 **존재할 수 없다**(경로 결합과 상태 전이가
    // 한 트랜잭션이라 둘 다 되거나 둘 다 안 된다). 그래서 verified 재시도 분기가 없다.
    if (!path || !isOwnStagingPath(path, who.userId)) {
      return await fail({ error: "no_file" }, 409);
    }

    // --- 객체 실검증 (staging 다운로드) ----------------------------------
    // ★ 바이트를 **한 번만** 읽어 메모리에 고정한다. "검증한 바이트" 와 "저장하는
    //   바이트" 가 같아야 TOCTOU 가 닫힌다. 검증도 업로드도 이 buf 하나만 쓴다.
    const { data: blob, error: dlErr } = await withTimeout(
      svc.storage.from(VERIFY_BUCKET).download(path), IO_TIMEOUT_MS, "download-staging");
    if (dlErr || !blob) return await fail({ error: "no_file" }, 409);

    const buf = Buffer.from(await blob.arrayBuffer());

    // 잘못된 파일은 staging 을 손대지 않고 실패만 한다(동시 finalize 가 같은 staging 을
    // 읽을 수 있어 인라인 삭제는 위험). 남은 객체는 고아 정리(§9)가 치운다.
    if (buf.length === 0 || buf.length > MAX_BYTES) {
      return await fail({ error: buf.length > MAX_BYTES ? "file_too_large" : "no_file" }, 400);
    }

    // 앞머리 32바이트만 있으면 판정에 충분하다 (WebP 가 12바이트로 가장 길다).
    const kind = sniffType(buf.subarray(0, 32));
    if (!kind) return await fail({ error: "file_type_not_allowed" }, 400);

    // 검증 대상 바이트의 지문. 저장 후 대조해 "검증한 그 바이트가 저장됐다" 를
    // 증거로 남긴다. 지문 자체는 파일 내용을 역산할 수 없어 응답에 담아도 된다.
    const digest = createHash("sha256").update(buf).digest("hex");

    // --- 검증한 바이트를 **자기 token 경로**로 (upsert:false) ------------
    // 각 claimant 는 verified/<id>/<token>/document 라는 자기만의 경로에 쓴다.
    // 그래서 지연된 stale 작업자의 늦은 write 는 자기 경로에만 떨어지고 승자의
    // 정본을 덮지 못한다. Content-Type 도 서버 판정값으로 다시 쓴다.
    const verifiedPath = buildVerifiedPath(requestId, claimToken);
    const { error: cpErr } = await withTimeout(
      svc.storage.from(VERIFY_BUCKET)
        .upload(verifiedPath, buf, { contentType: kind.mime, upsert: false }),
      IO_TIMEOUT_MS, "upload-verified");
    if (cpErr) return await fail({ error: "storage_unavailable" }, 503);

    // 저장된 것이 검증한 바로 그 바이트인지 되읽어 대조한다.
    const { data: back, error: reErr } = await withTimeout(
      svc.storage.from(VERIFY_BUCKET).download(verifiedPath), IO_TIMEOUT_MS, "reread-verified");
    if (reErr || !back) return await fail({ error: "storage_unavailable" }, 503);
    const stored = createHash("sha256")
      .update(Buffer.from(await back.arrayBuffer())).digest("hex");
    if (stored !== digest) return await fail({ error: "integrity_mismatch" }, 500);

    // --- 원자적 결합 + 상태 전이 (token 게이트) -------------------------
    // 경로 결합과 finalize 상태 전이를 **하나의 RPC=하나의 트랜잭션**에서 한다.
    // 현재 token 이 내 token 과 같을 때만(재인수 안 당함) 정본으로 채택하고 전이한다.
    // 재인수당한 stale 은 finalized=false(claim_lost) → 자기 업로드는 고아로 남아
    // 021 이 정리, 승자 정본은 건드리지 못한다.
    const { data: fin, error: finErr } = await withTimeout(
      svc.rpc("svc_finalize_verified", {
        p_request_id: requestId, p_member_id: who.userId, p_claim_token: claimToken,
      }), RPC_TIMEOUT_MS, "finalize");
    if (finErr) return await fail({ error: "finalize_failed" }, 500);
    if (fin?.finalized !== true) {
      // claim_lost 등. staging 은 손대지 않는다(승자가 쓸 수 있다). 선점은 이미
      // 내 것이 아니므로 fail() 의 release 는 no-op 이 된다.
      return await fail({ error: fin?.reason === "claim_lost" ? "claim_lost" : "not_uploading" }, 409);
    }
    if (fin?.path !== verifiedPath) return await fail({ error: "integrity_mismatch" }, 500);

    // 성공. 이제서야 staging 을 정리한다(승자만). 실패해도 응답을 바꾸지 않는다 —
    // 이미 정본이 있고 남은 staging 은 고아 정리 배치(§9)가 치운다.
    await removeObject(svc, path);
    return json({ ok: true, requestId, detectedType: kind.mime }, 200);
  } catch {
    // 예기치 못한 throw·timeout. 선점을 자기 token 으로 풀고 500. (fail() 을 거친
    // 경로는 여기 오지 않으므로 이중 해제가 아니다.)
    await releaseClaim();
    return json({ error: "finalize_failed" }, 500);
  }
}

// 정리 실패는 사용자 응답을 바꾸지 않는다 — 고아 객체는 배치(§9)가 치운다.
async function removeObject(svc, path) {
  try { await svc.storage.from(VERIFY_BUCKET).remove([path]); } catch { /* 배치가 정리 */ }
}
