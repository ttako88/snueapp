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
  isOwnStagingPath, isVerifiedPath, buildVerifiedPath,
} from "../../../lib/server/verification/files.mjs";

export const runtime = "nodejs";

const json = (body, status) => NextResponse.json(body, { status, headers: NO_STORE });

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

  const path = req.storage_path;
  // 이 시점의 경로는 staging 이어야 한다. verified 라면 앞선 finalize 가
  // 복사까지 마치고 상태 전이에서만 끊긴 것이므로 그대로 재시도한다.
  const alreadyCopied = isVerifiedPath(path);
  if (!path || (!alreadyCopied && !isOwnStagingPath(path, who.userId))) {
    return json({ error: "no_file" }, 409);
  }

  // --- 객체 실검증 -------------------------------------------------------
  // ★ 바이트를 **한 번만** 읽어 메모리에 고정한다. 이게 왜 중요하냐면,
  //   "검증한 바이트" 와 "저장하는 바이트" 가 같아야 TOCTOU 가 닫히기 때문이다.
  //   Storage 의 copy API 로 staging→verified 를 복사하면 그 순간 staging 을
  //   다시 읽게 되고, 검증과 복사 사이에 아직 유효한 업로드 토큰으로
  //   사용자가 내용을 바꿔치기할 수 있다. 아래는 그 창이 존재하지 않는다 —
  //   검증도 업로드도 이 buf 하나만 쓴다.
  const { data: blob, error: dlErr } = await svc.storage.from(VERIFY_BUCKET).download(path);
  if (dlErr || !blob) return json({ error: "no_file" }, 409);

  const buf = Buffer.from(await blob.arrayBuffer());

  if (buf.length === 0 || buf.length > MAX_BYTES) {
    await removeObject(svc, path);
    return json({ error: buf.length > MAX_BYTES ? "file_too_large" : "no_file" }, 400);
  }

  // 앞머리 32바이트만 있으면 판정에 충분하다 (WebP 가 12바이트로 가장 길다).
  const kind = sniffType(buf.subarray(0, 32));
  if (!kind) {
    // 허용 목록 밖 — 남겨 둘 이유가 없다. 지우고 다시 올리게 한다.
    await removeObject(svc, path);
    return json({ error: "file_type_not_allowed" }, 400);
  }

  // 검증 대상 바이트의 지문. 저장 후 대조해 "검증한 그 바이트가 저장됐다" 를
  // 증거로 남긴다. 지문 자체는 파일 내용을 역산할 수 없으므로 응답에 담아도 된다.
  const digest = createHash("sha256").update(buf).digest("hex");

  // --- 검증한 바이트를 사용자가 못 건드리는 곳으로 옮긴다 ------------------
  // 여기가 TOCTOU 를 닫는 지점이다. staging 경로에 대한 signed upload token 은
  // 만료 전까지 살아 있으므로, 검증한 자리에 그대로 두면 검증 직후 다른
  // 파일로 덮어쓸 수 있다. verified 경로에 대한 토큰은 아무에게도 주지 않는다.
  // 이때 Content-Type 도 서버 판정값으로 다시 쓴다 — 업로드 시 값은 클라이언트
  // 것이라, 실제 PDF 를 text/html 로 올려두면 심사자 브라우저가 HTML 로 렌더한다.
  const verifiedPath = buildVerifiedPath(requestId);
  if (!alreadyCopied) {
    // copy API 를 쓰지 않는다 — 그건 staging 을 다시 읽는다. 검증한 buf 를 올린다.
    const { error: cpErr } = await svc.storage
      .from(VERIFY_BUCKET)
      .upload(verifiedPath, buf, { contentType: kind.mime, upsert: true });
    if (cpErr) return json({ error: "storage_unavailable" }, 503);

    // 저장된 것이 검증한 바로 그 바이트인지 되읽어 대조한다. 어긋나면 정본을
    // 쓰지 않고 멈춘다 — 심사자에게 검증되지 않은 바이트를 보이느니 실패가 낫다.
    const { data: back, error: reErr } = await svc.storage
      .from(VERIFY_BUCKET).download(verifiedPath);
    if (reErr || !back) return json({ error: "storage_unavailable" }, 503);
    const stored = createHash("sha256")
      .update(Buffer.from(await back.arrayBuffer())).digest("hex");
    if (stored !== digest) return json({ error: "integrity_mismatch" }, 500);

    // 경로 확정. **경로를 넘기지 않는다** — RPC 가 request_id 로 직접 만든다.
    // 넘기면 신청 123 에 verified/999/document 를 붙이는 실수가 가능해진다.
    // status 조건은 RPC 안에 있어 그 사이 철회된 신청을 되살리지 않는다.
    const { data: moved, error: mvErr } = await svc.rpc("svc_set_verification_storage_path", {
      p_request_id: requestId, p_member_id: who.userId,
    });
    if (mvErr) return json({ error: "finalize_failed" }, 500);
    // 0건이면 그 사이 상태가 변한 것이다. 성공으로 응답하면 안 된다.
    if (Number(moved?.updated) !== 1) return json({ error: "not_uploading" }, 409);
    // DB 가 정한 경로와 내가 바이트를 올린 경로가 같은지 대조한다.
    // 어긋나면 심사자가 빈 자리를 열게 되므로 성공으로 넘기지 않는다.
    if (moved?.path !== verifiedPath) return json({ error: "integrity_mismatch" }, 500);

    // staging 정리. 실패해도 사용자 응답을 바꾸지 않는다 — 이미 verified 가
    // 정본이고, 남은 staging 객체는 고아 정리 배치(§9)가 치운다.
    await removeObject(svc, path);
  }

  // --- 통과했을 때만 상태 전이 ---
  const { error: rpcErr } = await svc.rpc("finalize_verification", {
    p_member_id: who.userId,
    p_request_id: requestId,
  });
  if (rpcErr) {
    const msg = String(rpcErr.message || "");
    if (/not uploading/.test(msg)) return json({ error: "not_uploading" }, 409);
    return json({ error: "finalize_failed" }, 500);
  }

  return json({ ok: true, requestId, detectedType: kind.mime }, 200);
}

// 정리 실패는 사용자 응답을 바꾸지 않는다 — 고아 객체는 배치(§9)가 치운다.
async function removeObject(svc, path) {
  try { await svc.storage.from(VERIFY_BUCKET).remove([path]); } catch { /* 배치가 정리 */ }
}
