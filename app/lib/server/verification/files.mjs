// ============================================================
// files.mjs — 증빙 파일 정책과 실검증 (서버 전용)
// ============================================================
// 설계 근거: GATE3_DESIGN.md §4.3
//
// 핵심 원칙 하나: 확장자와 Content-Type 은 클라이언트가 말하는 것이라 믿지
// 않는다. 파일 앞머리 바이트(magic bytes)를 직접 읽어 판정한다. SVG·HTML 은
// 브라우저에서 스크립트가 실행될 수 있으므로 허용 목록에서 제외한다.
// ============================================================
import { randomBytes } from "node:crypto";

if (typeof window !== "undefined") {
  throw new Error("verification/files.mjs는 서버 전용입니다");
}

/** 비공개 버킷. anon/authenticated 정책 0개 — 서버 signed URL 로만 접근 (006). */
export const VERIFY_BUCKET = "verification-docs";

export const MAX_BYTES = 10 * 1024 * 1024; // 10MB
export const UPLOAD_URL_TTL_SEC = 300;     // 업로드 URL 5분
export const VIEW_URL_TTL_SEC = 60;        // 심사 열람 60초

// 허용 형식. bytes 는 파일 선두에서 확인할 (오프셋, 값) 목록.
const SIGNATURES = [
  { mime: "image/jpeg", ext: "jpg",  parts: [[0, [0xff, 0xd8, 0xff]]] },
  { mime: "image/png",  ext: "png",  parts: [[0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]] },
  // WebP 는 RIFF 컨테이너 — 선두 "RIFF" 와 8바이트째 "WEBP" 를 함께 봐야 한다.
  { mime: "image/webp", ext: "webp", parts: [[0, [0x52, 0x49, 0x46, 0x46]], [8, [0x57, 0x45, 0x42, 0x50]]] },
  { mime: "application/pdf", ext: "pdf", parts: [[0, [0x25, 0x50, 0x44, 0x46, 0x2d]]] }, // "%PDF-"
];

export const ACCEPT_ATTR = SIGNATURES.map((s) => s.mime).join(",");

/**
 * 바이트를 보고 형식을 판정한다. 허용 목록에 없으면 null.
 * @param {Uint8Array|Buffer} head 파일 선두 (최소 16바이트 권장)
 */
export function sniffType(head) {
  const b = head instanceof Buffer ? head : Buffer.from(head);
  for (const sig of SIGNATURES) {
    let hit = true;
    for (const [off, bytes] of sig.parts) {
      if (b.length < off + bytes.length) { hit = false; break; }
      for (let i = 0; i < bytes.length; i++) {
        if (b[off + i] !== bytes[i]) { hit = false; break; }
      }
      if (!hit) break;
    }
    if (hit) return { mime: sig.mime, ext: sig.ext };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 경로를 staging 과 verified 로 나눈다 (GPT 보안 검수 반영)
//
// 나누지 않으면 TOCTOU 가 열린다. 사용자가 받은 signed upload token 은
// 그 경로에 대한 쓰기 권한이고, 만료 전까지 유효하다. 한 경로만 쓰면:
//   ① 정상 PDF 업로드 → ② finalize 가 검증 통과 → ③ 같은 토큰으로 악성
//   파일 덮어쓰기 → 심사자는 검증받지 않은 파일을 열게 된다.
//
// 그래서 사용자는 staging 에만 쓸 수 있고, 검증을 통과한 바이트는 서버가
// verified 로 복사한다. verified 경로에 대한 토큰은 아무에게도 주지 않는다.
// ─────────────────────────────────────────────────────────────
export const STAGING_PREFIX = "staging";
export const VERIFIED_PREFIX = "verified";

/**
 * 업로드용(staging) 경로. request id 를 쓰지 않는 이유가 중요하다 —
 * id 를 쓰면 행을 INSERT 한 뒤에야 경로를 알 수 있어 "INSERT 후 UPDATE" 라는
 * 두 단계가 생기고, 그 사이에 서버가 죽으면 경로 없는 uploading 행이 남는다.
 * 무작위 값이면 INSERT 전에 경로가 확정되므로 begin 이 한 번의 쓰기로 끝난다.
 */
export function buildStagingPath(memberId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(memberId))) throw new Error("bad member id");
  return `${STAGING_PREFIX}/${memberId}/${randomBytes(16).toString("hex")}`;
}

/**
 * 검증 완료(verified) 경로. request id 로 결정론적으로 만든다 — finalize 가
 * 중간에 끊겨 재시도되어도 같은 경로에 쓰므로 고아 객체가 늘지 않는다.
 * 경로를 추측할 수 있어도 문제되지 않는다: 버킷은 비공개이고
 * storage.objects 정책이 0개라 접근은 서버 signed URL 로만 가능하다.
 */
export function buildVerifiedPath(requestId) {
  if (!/^[1-9][0-9]*$/.test(String(requestId))) throw new Error("bad request id");
  return `${VERIFIED_PREFIX}/${requestId}/document`;
}

/**
 * staging 경로가 이 회원의 것인지 확인한다. DB 가 준 경로라도 한 번 더 본다.
 * prefix 비교는 반드시 구분자까지 포함해야 한다 — "abc/" 없이 "abc" 로
 * 비교하면 "abcd/..." 가 통과한다.
 */
export function isOwnStagingPath(path, memberId) {
  return typeof path === "string" && path.startsWith(`${STAGING_PREFIX}/${memberId}/`);
}

export function isVerifiedPath(path) {
  return typeof path === "string" && path.startsWith(`${VERIFIED_PREFIX}/`);
}
