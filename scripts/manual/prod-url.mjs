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

// ============================================================
// 접속 헬퍼 — 기본이 읽기 전용이다
// ============================================================
// 왜 필요한가 (COLLAB_PROTOCOL §3-1):
//   PROD_DB_URL 은 postgres 역할로 접속한다. 즉 모든 스크립트가 쓰기 능력을
//   갖고 있고, 지금까지는 각 스크립트가 `begin read only` 를 **직접 적어야만**
//   막혔다. 실측해 보니 prod-url 을 쓰는 40개 중 24개에 그 문장이 없었고,
//   그중에는 읽기만 하는 diag 도구도 섞여 있었다.
//   "실행자가 기억해야 지켜지는 규칙은 지켜지지 않는다" 의 교과서적 사례다.
//
//   그래서 기본값을 뒤집는다. connectProd() 는 세션 자체를 읽기 전용으로
//   고정하므로, 스크립트가 실수로 UPDATE 를 보내면 **DB 가 거부한다**.
//   쓰기가 필요하면 의도를 밝혀 명시적으로 열어야 한다.
import pg from "pg";

/**
 * @param {object} opts
 * @param {boolean} [opts.write=false] 쓰기를 하려면 true. 이유를 함께 적어야 한다.
 * @param {string}  [opts.reason]      write:true 일 때 필수 — 무엇을 왜 바꾸는가.
 * @returns {Promise<pg.Client>}
 */
export async function connectProd(url, opts = {}) {
  assertProdUrl(url, "PROD_DB_URL");
  const write = opts.write === true;
  if (write && !opts.reason) {
    throw new Error("쓰기 접속에는 reason 이 필요합니다 (무엇을 왜 바꾸는가)");
  }

  const client = new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  if (write) {
    // 사람이 로그에서 알아볼 수 있게 남긴다. 조용한 쓰기 접속을 만들지 않는다.
    console.log(`  [쓰기 접속] ${opts.reason}`);
  } else {
    // 세션 전체를 읽기 전용으로. 이후 어떤 트랜잭션도 쓰기를 못 한다
    // (SQLSTATE 25006). 스크립트가 begin read only 를 빠뜨려도 안전하다.
    await client.query("set session characteristics as transaction read only");
  }
  return client;
}

/** 읽기 전용임을 실제로 확인한다 — 도구가 스스로를 검증하게 둔다. */
export async function assertReadOnly(client) {
  const { rows } = await client.query("show default_transaction_read_only");
  if (rows[0]?.default_transaction_read_only !== "on") {
    throw new Error("읽기 전용 세션이 아닙니다 — 중단");
  }
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
