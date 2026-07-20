// 공용 dev 대상 검증기 — apply-sql-dev·maintenance-e2e·http-boundary가 동일 코드 사용.
// new URL() 구조 파싱으로 hostname/username의 project-ref를 정확 검증(문자열 포함 검사 폐기).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DEV_REF = "uiikgqeoxocpvphlmoqp";
export const PROD_REF = "jclwkvxbvsegmbcnptpi";
export const DEV_SUPABASE_URL = `https://${DEV_REF}.supabase.co`;

// URL의 실제 project-ref 추출: (a)직접연결 db.<ref>.supabase.co (b)pooler+username postgres.<ref>
export function refOf(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = (u.hostname || "").toLowerCase();
  const user = decodeURIComponent(u.username || "");
  const direct = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(host);
  if (direct) return direct[1];
  if (/\.pooler\.supabase\.com$/.test(host)) {
    const m = /(?:^|\.)([a-z0-9]{20})$/.exec(user);
    if (m) return m[1];
  }
  // 표준 supabase URL: <ref>.supabase.co
  const std = /^([a-z0-9]{20})\.supabase\.(co|in|net)$/.exec(host);
  if (std) return std[1];
  return null;
}

// dev 대상임을 강제(운영 ref 발견 시 throw). 통과 시 url 반환.
export function assertDevUrl(url, label = "URL") {
  const ref = refOf(url);
  if (!ref) throw new Error(`${label}: project-ref 식별 실패 — 대상 불명 (중단)`);
  if (ref === PROD_REF) throw new Error(`${label}: 운영 ref 감지 — 실행 불가`);
  if (ref !== DEV_REF) throw new Error(`${label}: dev ref 아님 — 중단`);
  return url;
}

// .env.dev.local에서 키 읽기(값은 반환만, 호출부가 비출력 책임). PROD ref 섞이면 즉시 throw.
export function readDevEnv(keys) {
  let raw;
  try { raw = readFileSync(resolve(process.cwd(), ".env.dev.local"), "utf8"); }
  catch { throw new Error(".env.dev.local 없음 (snue-app 폴더에서 실행)"); }
  if (raw.includes(PROD_REF)) throw new Error(".env.dev.local에 운영 ref가 섞여 있음 — 중단");
  const out = {};
  for (const k of keys) {
    const m = raw.match(new RegExp("^\\s*" + k + "\\s*=\\s*(.+)\\s*$", "m"));
    out[k] = m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
  }
  return out;
}

// 로그에 연결문자열·secret이 남지 않도록 스크럽
export function scrub(s, ...secrets) {
  if (!s) return s;
  let out = String(s);
  for (const sec of secrets) if (sec) out = out.split(sec).join("[REDACTED]");
  out = out.replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+(@)/gi, "$1[REDACTED]$2");
  return out;
}
