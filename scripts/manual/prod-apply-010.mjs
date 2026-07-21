// ============================================================
// prod-apply-010.mjs — 010 적용 + 실효성·부작용 검증
// ============================================================
// 적용만 하고 끝내지 않는다. 트리거가 실제로 막는지, 그리고 막지 말아야 할
// 것을 막지 않는지 둘 다 확인한다. 특히 도메인 제한 도입 이전에 만들어진
// 기존 계정(운영에 1건)이 잠기면 안 된다 — 그 계정이 소유자 본인이다.
//
// 실행: node scripts/manual/prod-apply-010.mjs --execute
// ============================================================
import pg from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readProdEnv, assertProdUrl, PROD_REF, scrub } from "./prod-url.mjs";

const SQL = join(process.cwd(), "supabase/migrations/010_enforce_email_domain.sql");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(46)} ${v}`);
const fails = [];
const rec = (n, ok, d) => { if (!ok) fails.push(n); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

if (!process.argv.includes("--execute")) {
  console.error("[중단] 운영 DDL 이다. --execute 를 명시하라.");
  process.exit(2);
}

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

let spn = 0;
async function attempt(fn) {
  const sp = `a${++spn}`;
  await c.query(`savepoint ${sp}`);
  try { const v = await fn(); await c.query(`release savepoint ${sp}`); return { ok: true, value: v }; }
  catch (e) { await c.query(`rollback to savepoint ${sp}`); await c.query(`release savepoint ${sp}`);
    return { ok: false, code: e.code, message: (e.message || "").slice(0, 120) }; }
}

async function main() {
  await c.connect();
  const q = async (s, p = []) => (await c.query(s, p)).rows;

  head("0. 소스");
  const buf = readFileSync(SQL);
  line("010 크기", `${buf.length}B`);
  line("sha256", createHash("sha256").update(buf).digest("hex"));

  head("1. 적용 전 상태");
  const trgBefore = (await q(`select count(*) v from pg_trigger
     where tgrelid='auth.users'::regclass and tgname='enforce_snue_email'`))[0].v;
  line("기존 트리거", trgBefore === "0" ? "없음" : "이미 있음");
  const users = await q(`select email from auth.users order by created_at`);
  for (const u of users) line("  기존 계정", u.email);

  head("2. 적용");
  try {
    await c.query(buf.toString("utf8"));
    line("실행", "완료 (스크립트 자체 트랜잭션)");
  } catch (e) {
    console.error(`\n⛔ 적용 실패: ${scrub(e.message || String(e), url).slice(0, 300)}`);
    return 3;
  }
  const trgAfter = (await q(`select tgname, tgenabled from pg_trigger
     where tgrelid='auth.users'::regclass and tgname='enforce_snue_email'`));
  rec("트리거 생성됨", trgAfter.length === 1, trgAfter.length ? `enabled=${trgAfter[0].tgenabled}` : "없음");

  head("3. 실효성 — 막아야 할 것을 막는가 (전부 ROLLBACK)");
  await c.query("begin");
  try {
    const bad = await attempt(() => c.query(
      `insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated','authenticated',
               $2, now(), now())`, [randomUUID(), "attacker@example.com"]));
    rec("비허용 도메인 가입 차단", !bad.ok && /not allowed/i.test(bad.message || ""),
      bad.ok ? "삽입됨 — 위험" : bad.message);

    const good = await attempt(() => c.query(
      `insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated','authenticated',
               $2, now(), now())`, [randomUUID(), "someone@snue.ac.kr"]));
    rec("허용 도메인 가입 통과", good.ok, good.ok ? "" : good.message);

    const sub = await attempt(() => c.query(
      `insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated','authenticated',
               $2, now(), now())`, [randomUUID(), "x@dept.snue.ac.kr"]));
    rec("서브도메인 허용", sub.ok, sub.ok ? "" : sub.message);

    const esc = await attempt(() => c.query(
      `insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated','authenticated',
               $2, now(), now())`, [randomUUID(), "x@snue.ac.kr.evil.com"]));
    rec("유사 도메인 차단 (snue.ac.kr.evil.com)", !esc.ok, esc.ok ? "통과됨 — 위험" : "차단");
  } finally { await c.query("rollback"); }

  head("4. 부작용 — 막으면 안 되는 것을 막지 않는가 (전부 ROLLBACK)");
  await c.query("begin");
  try {
    // 기존 gmail 계정의 일상적 갱신(로그인 시 GoTrue 가 하는 것)
    const upd = await attempt(() => c.query(
      `update auth.users set updated_at = now(), last_sign_in_at = now()
        where email not like '%@snue.ac.kr'`));
    rec("기존 비허용도메인 계정의 일반 UPDATE 통과", upd.ok, upd.ok ? "" : upd.message);

    // email 컬럼을 포함하되 값은 그대로인 UPDATE
    const same = await attempt(() => c.query(
      `update auth.users set email = email where email not like '%@snue.ac.kr'`));
    rec("email 값 불변 UPDATE 통과", same.ok, same.ok ? "" : same.message);

    // 기존 계정을 다른 비허용 도메인으로 바꾸는 시도는 막혀야 한다
    const move = await attempt(() => c.query(
      `update auth.users set email = 'moved@example.com' where email not like '%@snue.ac.kr'`));
    rec("비허용 도메인으로 email 변경 차단", !move.ok, move.ok ? "허용됨 — 위험" : move.message);
  } finally { await c.query("rollback"); }

  head("5. 최종 상태");
  const finalUsers = await q(`select email from auth.users order by created_at`);
  for (const u of finalUsers) line("  계정", u.email);
  line("트리거", trgAfter.length === 1 ? "enforce_snue_email 활성" : "없음");

  console.log(`\nPROD_APPLY_010=${fails.length ? "FAIL" : "PASS"}`);
  if (fails.length) for (const f of fails) console.log(`  · ${f}`);
  return fails.length ? 3 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
process.exit(code);
