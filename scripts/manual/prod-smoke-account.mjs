// ============================================================
// prod-smoke-account.mjs — 브라우저 경로 검증용 임시 계정 (생성/삭제)
// ============================================================
// 왜 필요한가
//   앱 로그인은 이메일 OTP 라 스크립트로 대신할 수 없다. 그래서 React
//   클라이언트의 인증 경로가 검증되지 않은 채 남아 있었다.
//   비밀번호 계정을 임시로 만들면 password grant 로 실제 JWT 를 받아
//   브라우저 세션에 넣고 진짜 클라이언트 코드를 끝까지 돌려볼 수 있다.
//
//   상호님이 테스트 계정 생성을 명시적으로 승인했다.
//   ("테스트 게정도 니가 알아서 생성해")
//
// 안전
//   · 이메일에 명확한 표식을 넣어 실사용자와 구분한다
//   · --drop 으로 흔적을 전부 지운다 (members·owners 는 FK cascade)
//   · 삭제 전후 행수를 대조해 잔여물 0 을 증명한다
//   · 비밀번호는 실행 때마다 무작위 생성하고 화면에만 잠깐 쓴다
//
// 실행
//   node scripts/manual/prod-smoke-account.mjs --create
//   node scripts/manual/prod-smoke-account.mjs --drop
// ============================================================
import pg from "pg";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { readProdEnv, assertProdUrl, PROD_REF, scrub } from "./prod-url.mjs";

const OUT = join(homedir(), "prod-runs", "PROD_SMOKE");
const STATE = join(OUT, "smoke-account.json");
const MARK = "zz-smoke-";                       // 실사용자와 구분되는 표식
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(44)} ${v}`);

const mode = process.argv.includes("--drop") ? "drop"
  : process.argv.includes("--create") ? "create" : null;
if (!mode) { console.error("[중단] --create 또는 --drop"); process.exit(2); }

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();
  mkdirSync(OUT, { recursive: true });
  const q = async (s, p = []) => (await c.query(s, p)).rows;
  const count = async () => ({
    users: Number((await q(`select count(*) v from auth.users`))[0].v),
    members: Number((await q(`select count(*) v from private.members`))[0].v),
    posts: Number((await q(`select count(*) v from public.posts`))[0].v),
    comments: Number((await q(`select count(*) v from public.comments`))[0].v),
  });

  head("0. 대상");
  line("ref", PROD_REF);
  line("모드", mode);
  const before = await count();
  line("현재 행수", JSON.stringify(before));

  if (mode === "drop") {
    head("1. 표식 계정 제거");
    const victims = await q(`select id, email from auth.users where email like $1`, [MARK + "%"]);
    line("대상", victims.length);
    for (const v of victims) console.log(`    ${v.email}`);
    if (victims.length) {
      await c.query("begin");
      try {
        // 이 계정들이 만든 콘텐츠부터 지운다. FK cascade 에만 기대지 않는다.
        await c.query(`delete from public.comments where id in (
            select comment_id from public.comment_owners where user_id = any($1::uuid[]))`,
          [victims.map((v) => v.id)]);
        await c.query(`delete from public.posts where id in (
            select post_id from public.post_owners where user_id = any($1::uuid[]))`,
          [victims.map((v) => v.id)]);
        await c.query(`delete from auth.users where id = any($1::uuid[])`, [victims.map((v) => v.id)]);
        await c.query("commit");
      } catch (e) { await c.query("rollback"); throw e; }
    }
    const after = await count();
    line("사후 행수", JSON.stringify(after));
    const leftover = Number((await q(`select count(*) v from auth.users where email like $1`, [MARK + "%"]))[0].v);
    console.log(`\nSMOKE_ACCOUNT_DROP=${leftover === 0 ? "PASS" : "FAIL"}`);
    console.log(`잔여 표식 계정=${leftover}`);
    console.log(`행수 ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    if (existsSync(STATE)) writeFileSync(STATE, JSON.stringify({ dropped_at: new Date().toISOString() }, null, 2));
    return leftover === 0 ? 0 : 3;
  }

  head("1. 계정 생성 (비밀번호 방식 — OTP 를 스크립트로 대신할 수 없어서)");
  const id = randomUUID();
  const email = `${MARK}${Date.now()}@snue.ac.kr`;
  const password = randomBytes(18).toString("base64url");
  await c.query("begin");
  try {
    await c.query(
      `insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
          email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated',
          $2, extensions.crypt($3, extensions.gen_salt('bf')), now(), now(), now(),
          '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb)`,
      [id, email, password]);
    // 최신 Supabase 는 password grant 에 identities 행을 요구한다
    // provider_id 는 text, user_id 는 uuid 다. 같은 파라미터를 캐스트 없이
    // 두 자리에 쓰면 "inconsistent types deduced" 로 죽는다.
    await c.query(
      `insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
       values ($1::text, $1::uuid, $2::jsonb, 'email', now(), now())`,
      [id, JSON.stringify({ sub: id, email, email_verified: true })]);
    await c.query(`update private.members set verification_status='verified' where id=$1`, [id]);
    await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; }

  const after = await count();
  line("생성됨", email);
  line("사후 행수", JSON.stringify(after));
  const memberOk = Number((await q(`select count(*) v from private.members where id=$1`, [id]))[0].v) === 1;
  line("회원 행 생성(트리거)", memberOk ? "예" : "아니오");

  writeFileSync(STATE, JSON.stringify({ id, email, created_at: new Date().toISOString() }, null, 2));
  console.log(`\nSMOKE_ACCOUNT_CREATE=${memberOk ? "PASS" : "FAIL"}`);
  console.log(`EMAIL=${email}`);
  console.log(`PASSWORD=${password}`);
  console.log(`\n검증이 끝나면 반드시 --drop 으로 지운다.`);
  return memberOk ? 0 : 3;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
process.exit(code);
