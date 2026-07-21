// 운영 대상 검증기 — dev-url.mjs의 운영판. 모든 운영 스크립트가 이 로더만 쓴다.
//
// 원칙:
//   · .env.prod.local(git 비추적)에서만 읽는다
//   · project-ref를 구조 파싱해 **운영 ref가 아니면 즉시 중단**(dev면 특히 명확히 거부)
//   · 값은 반환만 하고 출력하지 않는다 — 화면·로그에 찍는 책임은 호출부가 지지 않도록
//     scrub()로 마스킹 헬퍼를 제공한다
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEV_REF, PROD_REF, refOf } from "./dev-url.mjs";

export { DEV_REF, PROD_REF, refOf };
export const PROD_SUPABASE_URL = `https://${PROD_REF}.supabase.co`;

/** 운영 대상임을 강제. dev·불명이면 throw. */
export function assertProdUrl(url, label = "URL") {
  const ref = refOf(url);
  if (!ref) throw new Error(`${label}: project-ref 식별 실패 — 대상 불명 (중단)`);
  if (ref === DEV_REF) throw new Error(`${label}: dev ref 감지 — 운영 스크립트에서 실행 불가`);
  if (ref !== PROD_REF) throw new Error(`${label}: 예상한 운영 ref 아님 — 중단`);
  return url;
}

/** .env.prod.local에서 키를 읽는다. 값은 반환만 하고 출력하지 않는다. */
export function readProdEnv(keys) {
  let raw;
  try {
    raw = readFileSync(resolve(process.cwd(), ".env.prod.local"), "utf8");
  } catch {
    throw new Error(".env.prod.local 없음 — setup-prod-secret.mjs로 먼저 등록하세요");
  }
  const map = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) map[m[1]] = m[2];
  }
  const out = {};
  for (const k of keys) out[k] = map[k];
  return out;
}

/** 오류 메시지 등에서 비밀값을 지운다 (접속문자열·비밀번호가 로그에 새지 않게) */
export function scrub(text, ...secrets) {
  let s = String(text ?? "");
  for (const sec of secrets) {
    if (sec && sec.length > 6) s = s.split(sec).join("[REDACTED]");
  }
  // 접속문자열 형태가 통째로 섞여 나오는 경우도 마스킹
  return s.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgresql://[REDACTED]");
}
