// 010 강의평가 스키마 행동 검증 (dev, 트랜잭션 안에서만 — 끝나면 전부 ROLLBACK).
// "문법이 통과했다"와 "제약이 의도대로 막는다"는 다른 문제라서, GPT가 지적한
// REQUIRED 항목들이 실제로 동작하는지 데이터를 넣어 확인한다.
import fs from "node:fs";
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
// 실패해야 정상인 것들: 에러가 나면 통과
async function mustFail(name, sql) {
  try {
    await client.query("savepoint sp");
    await client.query(sql);
    await client.query("release savepoint sp");
    rec(name, false, "막혔어야 하는데 통과됨");
  } catch (e) {
    await client.query("rollback to savepoint sp");
    rec(name, true, e.message.split("\n")[0].slice(0, 70));
  }
}
async function mustPass(name, sql) {
  try {
    await client.query("savepoint sp");
    await client.query(sql);
    await client.query("release savepoint sp");
    rec(name, true);
  } catch (e) {
    await client.query("rollback to savepoint sp");
    rec(name, false, e.message.split("\n")[0].slice(0, 70));
  }
}

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    // 스키마 올리기 (파일의 begin/commit 제거 — 우리 트랜잭션 안에서 돌린다)
    const sql = fs.readFileSync("supabase/migrations/pending/010_course_review.sql", "utf8")
      .replace(/^\s*begin\s*;\s*$/gim, "").replace(/^\s*commit\s*;\s*$/gim, "");
    await client.query(sql);

    // 합성 회원 2명 (실데이터 없음)
    await client.query(`insert into auth.users (id, instance_id, aud, role, email)
      values ('00000000-0000-0000-0000-0000000010a1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t010a@example.invalid'),
             ('00000000-0000-0000-0000-0000000010a2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t010b@example.invalid')`);
    // auth.users insert 시 트리거가 private.members 행을 자동 생성한다 → 갱신만 한다
    await client.query(`update private.members set nickname='평가자1', verification_status='verified'
       where id='00000000-0000-0000-0000-0000000010a1'`);
    await client.query(`update private.members set nickname='평가자2', verification_status='verified'
       where id='00000000-0000-0000-0000-0000000010a2'`);

    await client.query(`insert into private.course_review_subjects (id, course_key, professor_key, course_name_display, professor_display)
      values (9001,'초등도덕교육론','김교수','초등도덕교육론','김교수')`);

    const A = "'00000000-0000-0000-0000-0000000010a1'";
    const mk = (id, st, extra = "") => `insert into private.course_reviews
      (id, subject_id, member_id, reviewer_key, semester, status, grading ${extra ? "," + extra.k : ""})
      values (${id}, 9001, ${A}, 'rk-a', '2025-1', '${st}', '보통' ${extra ? "," + extra.v : ""})`;

    // ── REQUIRED-1: 활성 슬롯 ──
    await mustPass("초안 1건 생성", mk(9101, "draft"));
    await mustFail("같은 수강 건에 활성 평가 2개 금지", mk(9102, "draft"));

    // 정정 시나리오: 구버전을 corrected로 내리면 신버전(published)이 공존 가능해야 한다
    await client.query(`update private.course_reviews set status='corrected' where id=9101`);
    await mustPass("구버전 corrected → 신버전 published 공존 가능(정정 가능)",
      `insert into private.course_reviews (id,subject_id,member_id,reviewer_key,semester,status,grading,published_at,supersedes_id)
       values (9103,9001,${A},'rk-a','2025-1','published','보통',now(),9101)`);
    await mustFail("정정 분기 금지(같은 구버전을 둘이 대체 불가)",
      `insert into private.course_reviews (id,subject_id,member_id,reviewer_key,semester,status,grading,supersedes_id)
       values (9104,9001,${A},'rk-a','2026-1','draft','보통',9101)`);

    // hidden 상태가 활성 슬롯에 포함되어 모더레이션 우회를 막는지
    await client.query(`update private.course_reviews set status='hidden_by_moderation' where id=9103`);
    await mustFail("숨김 처리된 평가가 있으면 같은 수강 건 새 평가 불가(우회 차단)",
      `insert into private.course_reviews (id,subject_id,member_id,reviewer_key,semester,status,grading)
       values (9105,9001,${A},'rk-a','2025-1','draft','보통')`);

    // ── 사전검토 강제 ──
    await mustFail("자유서술이 사전검토 없이 공개될 수 없다",
      `insert into private.course_reviews (id,subject_id,member_id,reviewer_key,semester,status,body,published_at)
       values (9106,9001,${A},'rk-b','2025-2','published','좋은 수업이었습니다',now())`);
    await mustFail("시험경향도 reviewed_at 없이 공개 불가",
      `insert into private.exam_tips (id,subject_id,member_id,reviewer_key,semester,status,published_at)
       values (9201,9001,${A},'rk-a','2025-1','published',now())`);

    // ── 원장 제약 ──
    await mustPass("적립 기록",
      `insert into private.ticket_ledger (member_id,delta,reason,ref_type,ref_id,idempotency_key)
       values (${A},20,'review_published','course_review',9103,'k-review-9103')`);
    await mustFail("적립 이유에 음수 금지",
      `insert into private.ticket_ledger (member_id,delta,reason,idempotency_key)
       values (${A},-20,'review_published','k-bad-sign')`);
    await mustFail("clawback은 역분개 대상이 있어야 함",
      `insert into private.ticket_ledger (member_id,delta,reason,idempotency_key)
       values (${A},-20,'clawback','k-no-ref')`);
    await mustFail("원장 UPDATE 금지(append-only)",
      `update private.ticket_ledger set delta = 999 where idempotency_key='k-review-9103'`);
    await mustFail("원장 DELETE 금지(append-only)",
      `delete from private.ticket_ledger where idempotency_key='k-review-9103'`);

    const { rows: [{ id: paidId }] } = await client.query(
      `select id from private.ticket_ledger where idempotency_key='k-review-9103'`);
    await mustPass("역분개 1건",
      `insert into private.ticket_ledger (member_id,delta,reason,reverses_entry_id,idempotency_key)
       values (${A},-20,'clawback',${paidId},'reverse:ledger:${paidId}')`);
    await mustFail("같은 지급을 두 번 역분개 금지",
      `insert into private.ticket_ledger (member_id,delta,reason,reverses_entry_id,idempotency_key)
       values (${A},-20,'clawback',${paidId},'reverse:ledger:${paidId}:dup')`);

    // ── 탈퇴 (REQUIRED-4) ──
    // 원장이 CASCADE면 append-only 트리거에 걸려 탈퇴 자체가 실패한다 → 반드시 통과해야 함
    await mustPass("회원 탈퇴가 원장 append-only 트리거에 막히지 않는다",
      `delete from auth.users where id = ${A}`);
    const { rows: [rk] } = await client.query(
      `select count(*)::int n, count(member_id)::int m from private.course_reviews where subject_id=9001`);
    rec("탈퇴해도 강의평 존속(member_id만 null)", rk.n > 0 && rk.m === 0, `행 ${rk.n}개, member_id 남은 것 ${rk.m}개`);
    const { rows: [lg] } = await client.query(
      `select count(*)::int n, count(member_id)::int m from private.ticket_ledger
        where idempotency_key like 'k-review-9103%' or idempotency_key like 'reverse:ledger:%'`);
    rec("탈퇴해도 원장 존속(가명화)", lg.n === 2 && lg.m === 0, `행 ${lg.n}개, member_id 남은 것 ${lg.m}개`);

    // ── 제어문자·공백 본문 거부 ──
    await mustFail("공백만 있는 본문 거부",
      `insert into private.course_reviews (id,subject_id,reviewer_key,semester,status,body)
       values (9107,9001,'rk-c','2025-1','draft','   ')`);
  } finally {
    await client.query("rollback");           // 무슨 일이 있어도 되돌린다
    await client.end();
  }

  const pass = results.filter(Boolean).length;
  console.log(`\n=== 010 행동 검증: ${pass}/${results.length} PASS (dev 스키마 무변경) ===`);
  process.exit(pass === results.length ? 0 : 2);
}
main().catch((e) => { console.error("[fail] " + scrub(e.message || String(e), "", dbUrl)); process.exit(1); });
