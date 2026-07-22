// maintenance Route 요청 검증 (순수 함수 — DB·네트워크 없음, node:test로 검증 가능).
// GPT 검수 §5 인증·환경 검증 순서 근거. 서버 전용이지만 외부 IO가 없어 mock 없이 단위 테스트 가능.
import { createHash, timingSafeEqual } from "node:crypto";

// ── job allowlist (정적 문자열 4종 — 동적 해석 금지) ──
export const JOB_NAMES = [
  "purge-verification-docs",
  "delete-accounts",
  "expire-uploads",
  "stale-reviews",
  "prune-analytics",
];
export const isKnownJob = (job) => JOB_NAMES.includes(job);

// ── CRON_SECRET 검증 (상수시간) ──
// Vercel이 Authorization: Bearer <secret>으로 전송. secret 미설정·16자 미만이면 fail closed.
// 길이가 다르면 timingSafeEqual이 예외를 던지므로 양쪽을 SHA-256 고정 길이 digest 후 비교.
export function verifyCronSecret(authHeader, secret) {
  if (typeof secret !== "string" || secret.length < 16) return false; // fail closed
  if (typeof authHeader !== "string") return false;
  const m = /^Bearer (.+)$/.exec(authHeader);
  if (!m) return false;
  const a = createHash("sha256").update(m[1]).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

// ── project ref 검증 (dev/prod 대상 오적용 방지) ──
// https://<ref>.supabase.co 에서 ref 추출.
export function parseProjectRef(url) {
  try {
    const h = new URL(url).hostname;
    const m = /^([a-z0-9]+)\.supabase\.(co|in|net)$/.exec(h);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
// APP_ENV(dev|prod)에 맞는 EXPECTED_PROJECT_REF_*와 SUPABASE_URL의 ref 대조.
export function validateProjectRef(env) {
  if (env.APP_ENV !== "dev" && env.APP_ENV !== "prod") return { ok: false, reason: "app_env" };
  const ref = parseProjectRef(env.SUPABASE_URL);
  if (!ref) return { ok: false, reason: "url" };
  const expected = env.APP_ENV === "dev" ? env.EXPECTED_PROJECT_REF_DEV : env.EXPECTED_PROJECT_REF_PROD;
  if (!expected || ref !== expected) return { ok: false, reason: "ref_mismatch" };
  return { ok: true, ref };
}
