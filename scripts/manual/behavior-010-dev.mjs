// 010 강의평가 스키마 행동 검증 (dev, 트랜잭션 안에서만 — 끝나면 전부 ROLLBACK).
// "문법이 통과했다"와 "제약이 의도대로 막는다"는 다른 문제라서 실제로 데이터를 넣어 확인한다.
// v3: GPT 재검수가 요구한 테스트 범위 보강 (희소셀 억제·정정본 회수·가명화 완전성 등).
import fs from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";
import { readDevEnv, assertDevUrl, scrub } from "./dev-url.mjs";

const { DEV_DB_URL: dbUrl } = readDevEnv(["DEV_DB_URL"]);
assertDevUrl(dbUrl, "DEV_DB_URL");
const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

const results = [];
const rec = (name, pass, detail = "") => {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
async function mustFail(name, sql) {
  try {
    await client.query("savepoint sp"); await client.query(sql); await client.query("release savepoint sp");
    rec(name, false, "막혔어야 하는데 통과됨");
  } catch (e) { await client.query("rollback to savepoint sp"); rec(name, true, e.message.split("\n")[0].slice(0, 68)); }
}
async function mustPass(name, sql) {
  try {
    await client.query("savepoint sp"); await client.query(sql); await client.query("release savepoint sp");
    rec(name, true);
  } catch (e) { await client.query("rollback to savepoint sp"); rec(name, false, e.message.split("\n")[0].slice(0, 68)); }
}
// reviewer_key 계약: hex64
const RK = (s) => `'${createHash("sha256").update(String(s)).digest("hex")}'`;
const actAs = (u) => client.query(`select set_config('request.jwt.claims','{"sub":${JSON.stringify(u)}}',true)`);

const A_UUID = "00000000-0000-0000-0000-0000000010a1";
const A = `'${A_UUID}'`;
const RKA = RK("a");

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    const sql = fs.readFileSync("supabase/migrations/pending/010_course_review.sql", "utf8")
      .replace(/^\s*begin\s*;\s*$/gim, "").replace(/^\s*commit\s*;\s*$/gim, "");
    await client.query(sql);

    await client.query(`insert into auth.users (id, instance_id, aud, role, email) values
      ('${A_UUID}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t010a@example.invalid'),
      ('00000000-0000-0000-0000-0000000010a2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t010b@example.invalid')`);
    await client.query(`update private.members set nickname='평가자1', verification_status='verified'
       where id='${A_UUID}'`);
    await client.query(`insert into private.course_review_subjects (id, course_key, professor_key, course_name_display, professor_display)
      values (9001,'초등도덕교육론','김교수','초등도덕교육론','김교수'),
             (9002,'초등수학교육의이해','박교수','초등수학교육의 이해','박교수')`);

    const mk = (id, st) => `insert into private.course_reviews
      (id, subject_id, member_id, reviewer_key, semester, status, grading)
      values (${id}, 9001, ${A}, ${RKA}, '2025-1', '${st}', '보통')`;

    // ── 활성 슬롯 / 정정 체인 ──
    await mustPass("초안 1건 생성", mk(9101, "draft"));
    await mustFail("같은 수강 건에 활성 평가 2개 금지", mk(9102, "draft"));
    await client.query(`update private.course_reviews set status='corrected' where id=9101`);
    await mustPass("구버전 corrected → 신버전 published 공존(정정 가능)",
      `insert into private.course_reviews (id,subject_id,member_id,reviewer_key,semester,status,grading,published_at,supersedes_id,contribution_id)
       values (9103,9001,${A},${RKA},'2025-1','published','보통',now(),9101,
               (select contribution_id from private.course_reviews where id=9101))`);
    await mustFail("정정 분기 금지",
      `insert into private.course_reviews (id,subject_id,member_id,reviewer_key,semester,status,grading,supersedes_id)
       values (9104,9001,${A},${RKA},'2026-1','draft','보통',9101)`);
    await client.query(`update private.course_reviews set status='hidden_by_moderation' where id=9103`);
    await mustFail("숨김 평가가 있으면 새 평가 불가(모더레이션 우회 차단)", mk(9105, "draft"));
    await client.query(`update private.course_reviews set status='published' where id=9103`);

    // ── 사전검토 강제 ──
    await mustFail("자유서술이 사전검토 없이 공개 불가",
      `insert into private.course_reviews (id,subject_id,member_id,reviewer_key,semester,status,body,published_at)
       values (9106,9001,${A},${RK("b")},'2025-2','published','좋은 수업',now())`);
    await mustFail("시험경향도 reviewed_at 없이 공개 불가",
      `insert into private.exam_tips (id,subject_id,member_id,reviewer_key,semester,status,published_at)
       values (9201,9001,${A},${RKA},'2025-1','published',now())`);

    // ── 원장 기본 제약 ──
    const CONTRIB = `(select contribution_id from private.course_reviews where id=9103)`;
    await mustPass("적립 기록(기여 귀속)",
      `insert into private.ticket_ledger (member_id,delta,reason,ref_type,ref_id,contribution_id,idempotency_key)
       values (${A},20,'review_published','course_review',9101,${CONTRIB},'review_reward:c1')`);
    await mustFail("적립 이유에 음수 금지",
      `insert into private.ticket_ledger (member_id,delta,reason,idempotency_key)
       values (${A},-20,'review_published','k-bad-sign')`);
    await mustFail("clawback은 역분개 대상 필수",
      `insert into private.ticket_ledger (member_id,delta,reason,idempotency_key)
       values (${A},-20,'clawback','k-no-ref')`);
    await mustFail("원장 UPDATE 금지", `update private.ticket_ledger set delta=999 where idempotency_key='review_reward:c1'`);
    await mustFail("원장 DELETE 금지", `delete from private.ticket_ledger where idempotency_key='review_reward:c1'`);

    // ── 역분개 정합성 (신규) ──
    const { rows: [{ id: paidId }] } = await client.query(
      `select id from private.ticket_ledger where idempotency_key='review_reward:c1'`);
    await mustFail("금액이 다른 역분개 거부",
      `insert into private.ticket_ledger (member_id,delta,reason,reverses_entry_id,idempotency_key)
       values (${A},-5,'clawback',${paidId},'rev-wrong-amt')`);
    await mustFail("남의 지급행 역분개 거부",
      `insert into private.ticket_ledger (member_id,delta,reason,reverses_entry_id,idempotency_key)
       values ('00000000-0000-0000-0000-0000000010a2',-20,'clawback',${paidId},'rev-other-member')`);

    // ── 정정본 철회 시 최초 지급이 회수되는가 (GPT가 잡은 구멍) ──
    await actAs(A_UUID);
    await mustPass("정정본(9103) 철회", `select public.withdraw_course_review(9103)`);
    const { rows: [cb] } = await client.query(
      `select count(*)::int n, coalesce(sum(delta),0)::int s from private.ticket_ledger
        where reason='clawback' and reverses_entry_id=${paidId}`);
    rec("정정본을 철회해도 구버전에 준 보상이 회수됨", cb.n === 1 && cb.s === -20, `${cb.n}건 ${cb.s}`);
    await mustFail("이미 역분개된 지급을 또 역분개 불가",
      `insert into private.ticket_ledger (member_id,delta,reason,reverses_entry_id,idempotency_key)
       values (${A},-20,'clawback',${paidId},'rev-dup')`);
    const { rows: [rv] } = await client.query(
      `select id from private.ticket_ledger where reason='clawback' and reverses_entry_id=${paidId}`);
    await mustFail("clawback 자체를 역분개 불가",
      `insert into private.ticket_ledger (member_id,delta,reason,reverses_entry_id,idempotency_key)
       values (${A},20,'clawback',${rv.id},'rev-of-rev')`);

    // ── 통계: 표본 계산과 희소 셀 억제 ──
    await client.query(`delete from private.course_reviews where subject_id=9002`);
    // 한 사람이 여러 학기 10건 → 작성자는 1명
    for (let i = 0; i < 10; i++) {
      const sem = `20${20 + Math.floor(i / 2)}-${(i % 2) + 1}`;
      await client.query(`insert into private.course_reviews
        (subject_id,member_id,reviewer_key,semester,status,grading,published_at)
        values (9002,${A},${RKA},'${sem}','published','보통',now())`);
    }
    let st = (await client.query(`select public.course_review_stats(9002) s`)).rows[0].s;
    rec("한 사람이 10건 써도 작성자 1명으로 계산(통계 비공개)",
      st.n_reviewers === 1 && st.disclosure === "none", JSON.stringify(st).slice(0, 70));

    // 서로 다른 작성자 9명 → 아직 full 아님
    for (let i = 1; i <= 9; i++) {
      await client.query(`insert into private.course_reviews
        (subject_id,member_id,reviewer_key,semester,status,grading,published_at)
        values (9002,${A},${RK("r" + i)},'2025-1','published','보통',now())`);
    }
    st = (await client.query(`select public.course_review_stats(9002) s`)).rows[0].s;
    rec("작성자 9명(+본인1=10)에서 full 공개", st.disclosure === "full", `n_reviewers=${st.n_reviewers}`);

    // 희소 셀: 보통 9 / 깐깐함 1 → grading 항목 전체 비공개여야 한다
    await client.query(`update private.course_reviews set grading='깐깐함'
       where subject_id=9002 and reviewer_key=${RK("r1")}`);
    st = (await client.query(`select public.course_review_stats(9002) s`)).rows[0].s;
    rec("희소 셀(9:1)이면 그 항목 전체를 비공개", st.grading === null, `grading=${JSON.stringify(st.grading)}`);

    // ── 가명화 (탈퇴) ──
    await client.query(`select set_config('request.jwt.claims', null, true)`);
    await mustFail("member_id만 null로 바꾸면서 ref_id를 함께 바꾸는 UPDATE 거부",
      `update private.ticket_ledger set member_id=null, ref_id=99999 where id=${paidId}`);
    await mustPass("회원 탈퇴가 append-only 트리거에 막히지 않음", `delete from auth.users where id = ${A}`);

    const { rows: [rk2] } = await client.query(
      `select count(*)::int n, count(member_id)::int m, count(author_withdrawn_at)::int w
         from private.course_reviews where subject_id=9001`);
    rec("탈퇴해도 강의평 존속 + 탈퇴시각 자동 기록",
      rk2.n > 0 && rk2.m === 0 && rk2.w === rk2.n, `행 ${rk2.n} / member ${rk2.m} / withdrawn ${rk2.w}`);

    const { rows: [lg] } = await client.query(
      `select count(*)::int n, count(member_id)::int m from private.ticket_ledger`);
    rec("탈퇴해도 원장 존속(가명화)", lg.n > 0 && lg.m === 0, `행 ${lg.n} / member 남은 것 ${lg.m}`);

    const { rows: [uuidLeak] } = await client.query(
      `select count(*)::int n from private.ticket_ledger where idempotency_key like '%${A_UUID}%'`);
    rec("원장 키에 회원 UUID가 남지 않음", uuidLeak.n === 0, `${uuidLeak.n}건`);

    // ── 본문 위생 ──
    await mustFail("공백만 있는 본문 거부",
      `insert into private.course_reviews (id,subject_id,reviewer_key,semester,status,body)
       values (9107,9001,${RK("c")},'2025-1','draft','   ')`);
    await mustFail("reviewer_key 형식(hex64) 위반 거부",
      `insert into private.course_reviews (id,subject_id,reviewer_key,semester,status)
       values (9108,9001,'rk-a','2025-1','draft')`);
  } finally {
    await client.query("rollback");
    await client.end();
  }

  const pass = results.filter(Boolean).length;
  console.log(`\n=== 010 행동 검증: ${pass}/${results.length} PASS (dev 스키마 무변경) ===`);
  console.log("※ 2세션 동시 잠금해제 실측은 010을 dev에 실제 적용해야 가능 —");
  console.log("  현재 dev 적용이 금지돼 있어 dev 리허설 단계로 미룸(GPT에 보고).");
  process.exit(pass === results.length ? 0 : 2);
}
main().catch((e) => { console.error("[fail] " + scrub(e.message || String(e), "", dbUrl)); process.exit(1); });
