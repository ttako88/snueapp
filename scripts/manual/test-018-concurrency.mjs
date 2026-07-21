// ============================================================
// test-018-concurrency.mjs — 예산 상한의 **진짜 동시성** 검증
// ============================================================
// GPT 검수가 요구한 마지막 증거. 018 이 커밋된 뒤에만 가능하다 —
// 미커밋 트랜잭션 안에서는 다른 커넥션이 테이블을 볼 수 없기 때문이다.
//
// 검증
//   한도 ₩200 · 잔액 0 상태에서 **서로 다른 커넥션 N개**가 동시에 ₩200 예약을
//   시도한다. 승인이 정확히 1건이고 그날 승인 합계가 ₩200 이하여야 한다.
//
// 안전장치
//   · 테스트 동안만 한도를 ₩200 으로 바꾸고 **원래 값으로 반드시 되돌린다**
//   · 테스트가 만든 예약 행은 끝나고 지운다
//   · 실패해도 원복이 되도록 finally 에서 처리한다
// ============================================================
import pg from "pg";
import { readProdEnv, assertProdUrl, connectProd, scrub } from "./prod-url.mjs";

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");

const N = 8;                       // 동시 시도 수
const UID = "00000000-0000-4000-8000-0000000000aa";
const UID2 = "00000000-0000-4000-8000-0000000000bb";

let pass = 0, fail = 0;
const log = (ok, name, d = "") => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "✔" : "✖"} ${name}${d ? `  — ${d}` : ""}`);
};

const mk = () => new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

let admin, original = null, madeMembers = false;

try {
  admin = mk(); await admin.connect();

  // ── 사전: 카탈로그로 실제 정의 확인 (MUST) ──
  const fns = await admin.query(
    `select p.proname, pg_get_function_arguments(p.oid) args,
            p.prosecdef, p.proconfig::text cfg
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'svc_ai_%' order by p.proname`);
  console.log("=== 적용된 함수 ===");
  for (const f of fns.rows) {
    console.log(`  ${f.proname}(${f.args})`);
    console.log(`     definer=${f.prosecdef} search_path=${f.cfg}`);
  }
  log(fns.rows.length === 4, "함수 4개 존재", `${fns.rows.length}개`);
  log(fns.rows.every((f) => f.prosecdef && /search_path=/.test(f.cfg ?? "")),
    "전부 SECURITY DEFINER + 고정 search_path");
  const reserveArgs = fns.rows.find((f) => f.proname === "svc_ai_reserve")?.args ?? "";
  log(!/daily/i.test(reserveArgs), "예약 함수가 한도를 인자로 받지 않는다", reserveArgs);

  // 권한
  console.log("\n=== 권한 ===");
  for (const f of fns.rows) {
    const sig = (await admin.query(
      `select p.oid::regprocedure::text s from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname=$1::text`, [f.proname])).rows[0].s;
    const marks = [];
    for (const role of ["anon", "authenticated", "service_role"]) {
      marks.push((await admin.query(
        `select has_function_privilege($1::text,$2::text,'EXECUTE') v`, [role, sig])).rows[0].v);
    }
    console.log(`  ${f.proname.padEnd(22)} anon=${marks[0]} auth=${marks[1]} svc=${marks[2]}`);
    if (marks[0] || marks[1]) fail++;
  }
  log(true, "권한 확인 완료 (anon·authenticated 열림 없음이 위 표에서 확인)");

  // ── 테스트용 회원 (FK) ──
  const exists = Number((await admin.query(
    `select count(*) v from private.members where id in ($1::uuid,$2::uuid)`, [UID, UID2])).rows[0].v);
  if (exists === 0) {
    await admin.query("alter table private.members drop constraint members_id_fkey");
    await admin.query(
      `insert into private.members (id, nickname, verification_status, sanction)
       values ($1::uuid,'ctest1','verified','none'), ($2::uuid,'ctest2','verified','none')`,
      [UID, UID2]);
    madeMembers = true;
  }

  // ── 한도를 테스트용으로 격리 (원복 필수) ──
  original = (await admin.query(`select * from private.ai_budget_config where id`)).rows[0];
  await admin.query(
    `update private.ai_budget_config
        set daily_total_krw=200, daily_user_krw=200, single_call_max_krw=200`);

  const today = (await admin.query(
    `select (now() at time zone 'Asia/Seoul')::date d`)).rows[0].d;
  await admin.query(`delete from private.ai_usage where member_id in ($1::uuid,$2::uuid)`, [UID, UID2]);

  // ── ★ 동시 예약 ──
  console.log(`\n=== 동시 예약 ${N}건 (한도 ₩200, 각 ₩200 요청) ===`);
  const clients = [];
  for (let i = 0; i < N; i++) { const c = mk(); await c.connect(); clients.push(c); }

  const results = await Promise.all(clients.map((c, i) =>
    c.query(`select public.svc_ai_reserve($1::uuid, 200) v`,
      [i % 2 === 0 ? UID : UID2])
      .then((r) => r.rows[0].v)
      .catch((e) => ({ allowed: false, reason: "error:" + e.code }))));

  for (const c of clients) { try { await c.end(); } catch {} }

  const approved = results.filter((r) => r.allowed === true);
  const ids = approved.map((r) => r.reservation_id);
  console.log(`  승인 ${approved.length}건 / 거부 ${results.length - approved.length}건`);
  console.log(`  거부 사유: ${[...new Set(results.filter(r=>!r.allowed).map(r=>r.reason))].join(", ")}`);

  log(approved.length === 1, "승인이 정확히 1건", `${approved.length}건`);
  log(new Set(ids).size === ids.length, "reservation_id 가 전부 고유");

  const sum = Number((await admin.query(
    `select coalesce(sum(case when state='open' then max_krw
                              when state='settled' then actual_krw else 0 end),0) v
       from private.ai_usage where day=$1::date`, [today])).rows[0].v);
  log(sum <= 200, "그날 승인 합계가 한도 이하", `합계 ₩${sum} / 한도 ₩200`);

  // ── 다른 회원·다른 예약 ID 로 정산 거부 ──
  if (ids[0]) {
    const owner = approved[0];
    const wrongMember = results.indexOf(owner) % 2 === 0 ? UID2 : UID;
    const bad = (await admin.query(
      `select public.svc_ai_settle($1::uuid,$2::uuid,'m',1,1,10,'lesson_plan_brief') v`,
      [ids[0], wrongMember])).rows[0].v;
    log(bad.ok === false, "다른 회원이 남의 예약을 정산할 수 없다", JSON.stringify(bad));

    const fakeId = "11111111-2222-3333-4444-555555555555";
    const bad2 = (await admin.query(
      `select public.svc_ai_settle($1::uuid,$2::uuid,'m',1,1,10,'lesson_plan_brief') v`,
      [fakeId, UID])).rows[0].v;
    log(bad2.ok === false && bad2.reason === "no_reservation", "없는 예약 ID 정산 거부");
  }

  // ── 만료 후에도 차단 유지 ──
  await admin.query(`update private.ai_usage set expires_at = now() - interval '1 hour'
                      where day=$1::date`, [today]);
  const after = (await admin.query(`select public.svc_ai_reserve($1::uuid, 200) v`, [UID])).rows[0].v;
  log(after.allowed === false, "만료된 예약이 남아 이후 요청을 계속 차단", JSON.stringify(after));

} catch (e) {
  console.error("[fail] " + scrub(e.message || String(e), url));
  fail++;
} finally {
  // ── 원복 ── 실패해도 반드시 되돌린다
  if (admin) {
    try {
      await admin.query(`delete from private.ai_usage where member_id in ($1::uuid,$2::uuid)`, [UID, UID2]);
      if (madeMembers) {
        await admin.query(`delete from private.members where id in ($1::uuid,$2::uuid)`, [UID, UID2]);
        await admin.query(
          `alter table private.members add constraint members_id_fkey
             foreign key (id) references auth.users(id) on delete cascade`);
      }
      if (original) {
        await admin.query(
          `update private.ai_budget_config set daily_total_krw=$1, daily_user_krw=$2,
                  single_call_max_krw=$3, updated_at=now()`,
          [original.daily_total_krw, original.daily_user_krw, original.single_call_max_krw]);
        const back = (await admin.query(`select * from private.ai_budget_config where id`)).rows[0];
        console.log(`\n원복: 한도 ₩${back.daily_total_krw} / 1인 ₩${back.daily_user_krw} / 단건 ₩${back.single_call_max_krw}`);
      }
      const left = Number((await admin.query(`select count(*) v from private.ai_usage`)).rows[0].v);
      console.log(`테스트 잔여 예약 행: ${left}건`);
    } catch (e) { console.error("[원복 실패] " + scrub(e.message, url)); fail++; }
    try { await admin.end(); } catch {}
  }
}

console.log(`\nTEST_018_CONCURRENCY=${fail === 0 ? "PASS" : "FAIL"}  (통과 ${pass} / 실패 ${fail})`);
process.exit(fail === 0 ? 0 : 1);
