// ============================================================
// hmac.mjs — 학번 정규화와 HMAC 계산 (서버 전용)
// ============================================================
// 설계 근거: GATE3_DESIGN.md §4.1 / §4.2
//
// 이 파일이 지키는 것 세 가지.
//   1. 학번 원문은 이 모듈 밖으로 나가지 않는다. 반환값·오류메시지·로그 어디에도
//      원문을 담지 않는다. 오류는 사유 코드만 준다.
//   2. 중복 대조는 "현재 키" 하나로는 부족하다. 키를 교체하면 같은 학번이 다른
//      HMAC 이 되므로, 보존 중인 과거 키 버전 전부로 계산해서 전부 대조해야
//      중복 가입을 막을 수 있다 (§4.2). 그래서 배열을 반환한다.
//   3. 키는 서버 env 에서만 온다. NEXT_PUBLIC_ 접두사가 붙은 값은 클라이언트
//      번들에 실려 나가므로 애초에 읽지 않는다.
//
// env 규약
//   VERIFY_HMAC_KEY_V1, VERIFY_HMAC_KEY_V2, ...  버전별 키 (hex 또는 임의 문자열)
//   VERIFY_HMAC_CURRENT_VER                      신규 저장에 쓸 버전 번호 (예: "1")
// 버전 번호는 1 이상 정수. 과거 버전 키는 그 버전으로 저장된 행이 남아 있는
// 동안 지우지 않는다 — 지우면 그 버전에 대한 중복 대조가 조용히 사라진다.
// ============================================================
import { createHmac, timingSafeEqual } from "node:crypto";

if (typeof window !== "undefined") {
  throw new Error("verification/hmac.mjs는 서버 전용입니다 — 클라이언트에서 import 금지");
}

// 키 버전은 smallint 로 DB 에 들어간다. 상한을 두어 오타로 만든 거대 버전이
// 배열 스캔을 늘리지 못하게 한다.
const MAX_KEY_VERSION = 32;

/**
 * 학번 정규화. 실패하면 사유 코드를 던진다 — 입력값은 절대 메시지에 넣지 않는다.
 * SNUE 학번 = 8자리 (입학년도 4 + 학과코드 2 + 개인번호 2), 예: 20251423
 */
export function normalizeStudentNo(input, now = new Date()) {
  if (typeof input !== "string") throw new VerifyInputError("student_no_format");
  // 공백·하이픈만 제거한다. 다른 문자를 지우면 "정규화" 를 빌미로 잘못된 입력을
  // 통과시키게 된다 — 지우지 말고 거부해야 한다.
  const s = input.trim().replace(/[\s-]/g, "");
  if (!/^\d{8}$/.test(s)) throw new VerifyInputError("student_no_format");

  const year = Number(s.slice(0, 4));
  // 상한을 현재+1 로 두는 이유: 수시 합격자가 입학 전 해에 가입할 수 있다.
  if (year < 1980 || year > now.getFullYear() + 1) throw new VerifyInputError("student_no_year");
  return s;
}

/**
 * env 에서 보존 중인 키 전부를 읽는다. 반환값에 키 자체를 담지 않도록
 * 호출부가 곧바로 computeHmacs 로 넘기는 형태만 쓴다.
 */
function readKeys(env) {
  const currentVer = Number(env.VERIFY_HMAC_CURRENT_VER);
  if (!Number.isInteger(currentVer) || currentVer < 1 || currentVer > MAX_KEY_VERSION) {
    throw new VerifyConfigError("VERIFY_HMAC_CURRENT_VER");
  }
  const keys = [];
  for (let v = 1; v <= MAX_KEY_VERSION; v++) {
    const raw = env[`VERIFY_HMAC_KEY_V${v}`];
    if (!raw) continue;
    // 짧은 키는 HMAC 을 실질적으로 무력화한다. 32바이트 이상을 강제한다.
    if (raw.length < 32) throw new VerifyConfigError(`VERIFY_HMAC_KEY_V${v}_too_short`);
    keys.push({ version: v, secret: raw });
  }
  if (!keys.length) throw new VerifyConfigError("VERIFY_HMAC_KEY_V*");
  if (!keys.some((k) => k.version === currentVer)) {
    // 현재 버전 키가 없으면 신규 저장이 불가능하다. 조용히 다른 버전으로
    // 넘어가면 저장된 key_version 과 실제 키가 어긋나 영구히 대조 불능이 된다.
    throw new VerifyConfigError("current_key_missing");
  }
  return { currentVer, keys };
}

/**
 * 정규화된 학번을 보존 중인 전 키 버전으로 HMAC 계산한다.
 * @returns {{ hmacs: string[], keyVers: number[], currentVer: number }}
 *   hmacs[i] 와 keyVers[i] 가 짝. DB 의 begin_verification 이 이 짝을 그대로 받는다.
 */
export function computeHmacs(normalizedStudentNo, env) {
  const { currentVer, keys } = readKeys(env);
  const hmacs = [];
  const keyVers = [];
  for (const k of keys) {
    hmacs.push(createHmac("sha256", k.secret).update(normalizedStudentNo, "utf8").digest("hex"));
    keyVers.push(k.version);
  }
  return { hmacs, keyVers, currentVer };
}

/** 실명 — DB 는 길이만 보므로 서버에서 최소 형태 검사를 한다. */
export function normalizeRealName(input) {
  if (typeof input !== "string") throw new VerifyInputError("real_name_format");
  // 내부 연속 공백은 하나로 (표기 흔들림 흡수). 그 외 문자는 손대지 않는다.
  const s = input.trim().replace(/\s+/g, " ");
  if (s.length < 2 || s.length > 40) throw new VerifyInputError("real_name_format");
  // 제어문자 거부. 정규식 리터럴에 제어문자를 직접 쓰면 편집기·도구마다
  // 다르게 보이므로 코드포인트로 검사한다.
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f) throw new VerifyInputError("real_name_format");
  }
  return s;
}

// 서버가 허용하는 증빙 종류. 클라이언트 값을 그대로 믿지 않는다.
// ⚠ private.verification_requests 의 doc_type CHECK 제약과 정확히 같아야 한다
//   (002_foundation.sql). 어긋나면 begin 이 DB 에서 튕기고, 사용자에게는
//   원인을 알 수 없는 실패로 보인다. diag-verification-ready.mjs 가 대조한다.
export const DOC_TYPES = ["student_card", "smart_id", "enrollment_cert", "leave_cert"];

export function normalizeDocType(input) {
  if (!DOC_TYPES.includes(input)) throw new VerifyInputError("doc_type");
  return input;
}

// 오류를 두 종류로 나눈다. 입력 오류는 사용자에게 안내해도 되지만,
// 설정 오류는 서버 문제이므로 사용자에게 상세를 보이지 않는다.
export class VerifyInputError extends Error {
  constructor(code) { super(code); this.name = "VerifyInputError"; this.code = code; }
}
export class VerifyConfigError extends Error {
  constructor(what) { super(`verify config missing: ${what}`); this.name = "VerifyConfigError"; }
}

/** 준비 상태 점검용 — 키 값은 반환하지 않고 버전 목록만 준다. */
export function hmacReadiness(env) {
  try {
    const { currentVer, keys } = readKeys(env);
    return { ok: true, currentVer, versions: keys.map((k) => k.version) };
  } catch (e) {
    return { ok: false, reason: e instanceof VerifyConfigError ? e.message : "unknown" };
  }
}

// timingSafeEqual 은 지금 쓰지 않지만, 향후 서명 검증을 붙일 때 이 모듈이
// 자연스러운 자리다. 미사용 import 로 남기지 않도록 명시적으로 내보낸다.
export function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
