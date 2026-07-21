// ============================================================
// diag-signup-path.mjs — 실제 가입 경로 검증 (GoTrue → 트리거 → members)
// ============================================================
// 왜 필요한가
//   앞선 스모크는 SQL 로 auth.users 에 직접 넣어 트리거를 postgres 권한으로
//   발화시켰다. 실제 가입은 GoTrue 가 supabase_auth_admin 으로 넣는다.
//   그런데 그 역할은 private USAGE 도 members INSERT 도 트리거 함수
//   EXECUTE 도 없다. PostgreSQL 은 트리거 함수 EXECUTE 를 CREATE TRIGGER
//   시점에 검사하고 발화 시점에는 검사하지 않으므로 이론상 동작해야 하지만,
//   "이론상" 과 "확인함" 은 다르다. 가입이 막히면 아무도 서비스를 못 쓴다.
//
// 무엇을 하는가
//   공개키로 /auth/v1/signup 을 호출해 진짜 경로로 계정을 만들고,
//   private.members 에 행이 생겼는지 DB 에서 확인한다.
//   확인 후 만든 계정을 지운다.
//
// 부수적으로 앞서 SQL 로 만든 테스트 행의 NULL 토큰 컬럼도 고친다.
// GoTrue 는 그 컬럼들을 non-nullable 문자열로 읽어서 NULL 이면
// "Database error querying schema" 로 죽는다.
// ============================================================
import pg from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readProdEnv, assertProdUrl, scrub } from "./prod-url.mjs";

const env = readFileSync(join(process.cwd(), ".env.local"), "utf8");
const pick = (k) => (new RegExp(`^${k}=(.*)$`, "m").exec(env) || [])[1]?.trim();
const base = pick("NEXT_PUBLIC_SUPABASE_URL");
const key = pick("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const head = (t) => console.log(`\n=== ${t} ===`);
const rec = (n, ok, d) => console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);

async function main() {
  await c.connect();
  const q = async (s, p = []) => (await c.query(s, p)).rows;

  head("1. 앞서 SQL 로 만든 행의 NULL 토큰 컬럼 보정");
  // GoTrue 가 만든 행은 '' 인데 내 행은 NULL 이라 스캔이 깨진다.
  const fixed = await c.query(
    `update auth.users set
       confirmation_token = coalesce(confirmation_token, ''),
       recovery_token = coalesce(recovery_token, ''),
       email_change_token_new = coalesce(email_change_token_new, ''),
       email_change = coalesce(email_change, ''),
       email_change_token_current = coalesce(email_change_token_current, ''),
       phone_change = coalesce(phone_change, ''),
       phone_change_token = coalesce(phone_change_token, ''),
       reauthentication_token = coalesce(reauthentication_token, '')
     where email like 'zz-smoke-%'`);
  rec("토큰 컬럼 보정", true, `${fixed.rowCount}행`);

  head("2. 실제 가입 경로 — GoTrue /auth/v1/signup");
  const email = `zz-smoke-signup-${Date.now()}@snue.ac.kr`;
  const password = randomBytes(18).toString("base64url");
  const r = await fetch(`${base}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json().catch(() => null);
  rec("signup HTTP 성공", r.status === 200,
    `HTTP ${r.status}${body?.msg ? ` — ${body.msg}` : ""}${body?.error_code ? ` (${body.error_code})` : ""}`);

  if (r.status === 200) {
    const uid = body?.user?.id ?? body?.id;
    const member = Number((await q(
      `select count(*) v from private.members where id = $1::uuid`, [uid]))[0].v);
    rec("트리거가 private.members 행 생성", member === 1,
      `${member}건 (uid ${String(uid).slice(0, 8)}…)`);
    rec("세션 발급 여부", true, body?.access_token ? "즉시 세션" : "이메일 확인 대기(정상 설정일 수 있음)");
  } else {
    console.log("\n  ⛔ 실제 가입 경로가 막혔다. 이건 운영 차단 사유다.");
    console.log("     supabase_auth_admin 이 트리거 경로에서 실패하는지 확인해야 한다.");
  }

  head("3. 비밀번호 로그인 재시도 (보정 후)");
  const state = JSON.parse(readFileSync(
    join(process.env.HOME || process.env.USERPROFILE, "prod-runs", "PROD_SMOKE", "smoke-account.json"), "utf8"));
  console.log(`  대상 ${state.email}`);
  console.log("  (비밀번호는 이 스크립트가 모른다 — 생성 시 출력된 값을 쓴다)");

  head("4. 현재 행수");
  const cnt = (await q(`select
      (select count(*) from auth.users) users,
      (select count(*) from private.members) members`))[0];
  console.log(`  auth.users=${cnt.users}  private.members=${cnt.members}`);
  console.log(`  표식 계정은 prod-smoke-account.mjs --drop 으로 일괄 제거한다.`);
}

try { await main(); }
catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
