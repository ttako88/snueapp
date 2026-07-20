// 010 강의평가 스키마 행동 검증 (dev, 트랜잭션 안에서만 — 끝나면 전부 ROLLBACK).
// "문법이 통과했다"와 "제약이 의도대로 막는다"는 다른 문제라서 실제로 데이터를 넣어 확인한다.
// v4: 작성자 별칭(무작위) 도입 반영 + GPT 3차 요구 테스트(9→10 실제 경계, 원장 계보) 추가.
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
async function mustFail(name, sql) {
  try {
    await client.query("savepoint sp"); await client.query(sql); await client.query("release savepoint sp");
    rec(name, false, "막혔어야 하는데 통과됨");
  } catch (e) { await client.query("rollback to savepoint sp"); rec(name, true, e.message.split("\n")[0].slice(0, 66)); }
}
async function mustPass(name, sql) {
  try {
    await client.query("savepoint sp"); await client.query(sql); await client.query("release savepoint sp");
    rec(name, true);
  } catch (e) { await client.query("rollback to savepoint sp"); rec(name, false, e.message.split("\n")[0].slice(0, 66)); }
}
const actAs = (u) => client.query(`select set_config('request.jwt.claims','{"sub":${JSON.stringify(u)}}',true)`);
const stats = async (id) => (await client.query(`select public.course_review_stats(${id}) s`)).rows[0].s;

const A_UUID = "00000000-0000-0000-0000-0000000010a1";
const B_UUID = "00000000-0000-0000-0000-0000000010a2";
const A = `'${A_UUID}'`;

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    const sql = fs.readFileSync("supabase/migrations/pending/010_course_review.sql", "utf8")
      .replace(/^\s*begin\s*;\s*$/gim, "").replace(/^\s*commit\s*;\s*$/gim, "");
    await client.query(sql);

    await client.query(`insert into auth.users (id, instance_id, aud, role, email) values
      ('${A_UUID}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t010a@example.invalid'),
      ('${B_UUID}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','t010b@example.invalid')`);
    await client.query(`update private.members set nickname='평가자1', verification_status='verified' where id='${A_UUID}'`);
    await client.query(`insert into private.course_review_subjects (id, course_key, professor_key, course_name_display, professor_display)
      values (9001,'초등도덕교육론','김교수','초등도덕교육론','김교수'),
             (9002,'초등수학교육의이해','박교수','초등수학교육의 이해','박교수')`);

    // 합성 회원 생성 (별칭은 반드시 주인이 있어야 하므로 통계 테스트용으로 필요)
    let memberSeq = 0;
    const mkMember = async (tag) => {
      const id = `00000000-0000-0000-0000-1000000${String(++memberSeq).padStart(5, "0")}`;
      await client.query(`insert into auth.users (id,instance_id,aud,role,email) values
        ('${id}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','${tag}010@example.invalid')`);
      await client.query(`update private.members set nickname='${tag}', verification_status='verified' where id='${id}'`);
      return id;
    };

    // subject 범위 별칭 (주인 필수)
    const alias = async (subjectId, memberId) => {
      const { rows: [a] } = await client.query(
        `insert into private.course_review_actor_aliases (subject_id, member_id)
         values (${subjectId}, ${memberId ? `'${memberId}'` : "null"}) returning id`);
      return `'${a.id}'`;
    };
    const AL1 = await alias(9001, A_UUID);

    const mk = (id, st) => `insert into private.course_reviews
      (id, subject_id, member_id, actor_alias_id, semester, status, grading)
      values (${id}, 9001, ${A}, ${AL1}, '2025-1', '${st}', '보통')`;

    // ── 별칭 규칙 (REQUIRED-010-1~3) ──
    await mustFail("한 과목에서 같은 회원의 별칭 2개 금지",
      `insert into private.course_review_actor_aliases (subject_id, member_id) values (9001, '${A_UUID}')`);
    await mustFail("주인 없는 별칭 생성 금지(가짜 작성자 수 방지)",
      `insert into private.course_review_actor_aliases (subject_id, member_id) values (9001, null)`);
    await mustFail("별칭의 소유자 변경 금지",
      `update private.course_review_actor_aliases set member_id='${B_UUID}' where id=${AL1}`);
    await mustFail("별칭의 과목 변경 금지",
      `update private.course_review_actor_aliases set subject_id=9002 where id=${AL1}`);
    // (REQUIRED-010-N1) 가드가 실제로 좁은지 — 예전엔 아래가 전부 통과했다
    await mustFail("created_at 단독 변경 거부",
      `update private.course_review_actor_aliases set created_at=now() - interval '1 day' where id=${AL1}`);
    await mustFail("detached_at 임의 설정 거부",
      `update private.course_review_actor_aliases set detached_at=now() where id=${AL1}`);
    // now()는 트랜잭션 시각이라 같은 값이 되어 "변경 없음"이 된다 → 확실히 다른 값으로
    await mustFail("탈퇴 전이에 다른 컬럼 변경을 끼워넣기 거부",
      `update private.course_review_actor_aliases
          set member_id=null, created_at=timestamptz '2000-01-01' where id=${AL1}`);
    await mustFail("생성 시 detached_at 미리 설정 거부",
      `insert into private.course_review_actor_aliases (subject_id, member_id, detached_at)
       values (9002, '${B_UUID}', now())`);

    // 다른 과목의 별칭을 빌려 쓰면 복합 FK가 막아야 한다
    const alOther = await alias(9002, A_UUID);
    await mustFail("다른 과목의 별칭으로 리뷰 작성 금지(과목 간 연결 차단)",
      `insert into private.course_reviews (subject_id,member_id,actor_alias_id,semester,status,grading)
       values (9001,${A},${alOther},'2025-1','draft','보통')`);

    // (REQUIRED-010-N2) 리뷰 소유자와 별칭 소유자가 다르면 안 된다.
    // DEFERRABLE 제약이라 평소엔 커밋 시점에 검사된다 → 테스트에서는
    // set constraints all immediate로 그 자리에서 터뜨린다.
    await mustFail("남의 별칭으로 리뷰 작성 금지(소유자 불일치)",
      `insert into private.course_reviews (subject_id,member_id,actor_alias_id,semester,status,grading)
       values (9002,'${B_UUID}',${alOther},'2025-2','draft','보통');
       set constraints all immediate;`);
    await client.query("set constraints all deferred");

    // 격리: anon/authenticated는 별칭 테이블에 직접 접근할 수 없어야 한다
    const { rows: [priv] } = await client.query(`
      select coalesce(sum(case when has_table_privilege(r, 'private.course_review_actor_aliases', p)
                               then 1 else 0 end), 0)::int n
        from unnest(array['anon','authenticated']) r,
             unnest(array['select','insert','update','delete']) p`);
    const { rows: [rls] } = await client.query(
      `select relrowsecurity from pg_class where oid='private.course_review_actor_aliases'::regclass`);
    rec("별칭 테이블 RLS 활성 + anon/authenticated 권한 0",
      rls.relrowsecurity === true && priv.n === 0, `rls=${rls.relrowsecurity} 권한=${priv.n}`);

    // ── 활성 슬롯 / 정정 체인 ──
    await mustPass("초안 1건 생성", mk(9101, "draft"));
    await mustFail("같은 수강 건에 활성 평가 2개 금지", mk(9102, "draft"));
    await client.query(`update private.course_reviews set status='corrected' where id=9101`);
    await mustPass("구버전 corrected → 신버전 published 공존(정정 가능)",
      `insert into private.course_reviews (id,subject_id,member_id,actor_alias_id,semester,status,grading,published_at,supersedes_id,contribution_id)
       values (9103,9001,${A},${AL1},'2025-1','published','보통',now(),9101,
               (select contribution_id from private.course_reviews where id=9101))`);
    await mustFail("정정 분기 금지",
      `insert into private.course_reviews (id,subject_id,member_id,actor_alias_id,semester,status,grading,supersedes_id)
       values (9104,9001,${A},${AL1},'2026-1','draft','보통',9101)`);
    await client.query(`update private.course_reviews set status='hidden_by_moderation' where id=9103`);
    await mustFail("숨김 평가가 있으면 새 평가 불가(모더레이션 우회 차단)", mk(9105, "draft"));
    await client.query(`update private.course_reviews set status='published' where id=9103`);

    // ── 사전검토 강제 ──
    const AL_B = await alias(9001, B_UUID);
    await mustFail("자유서술이 사전검토 없이 공개 불가",
      `insert into private.course_reviews (id,subject_id,member_id,actor_alias_id,semester,status,body,published_at)
       values (9106,9001,${A},${AL_B},'2025-2','published','좋은 수업',now())`);
    await mustFail("시험경향도 reviewed_at 없이 공개 불가",
      `insert into private.exam_tips (id,subject_id,member_id,actor_alias_id,semester,status,published_at)
       values (9201,9001,${A},${AL1},'2025-1','published',now())`);
    await mustFail("시험경향 서술에 제어문자 거부",
      `insert into private.exam_tips (id,subject_id,member_id,actor_alias_id,semester,status,study_tip)
       values (9202,9001,${A},${AL1},'2025-2','draft', 'a' || chr(7) || 'b')`);

    // ── 원장 ──
    const CONTRIB = `(select contribution_id from private.course_reviews where id=9103)`;
    await mustFail("주인 없는(member_id null) 지급행 생성 금지",
      `insert into private.ticket_ledger (member_id,delta,reason,idempotency_key)
       values (null,20,'review_published','k-orphan')`);
    await mustPass("적립 기록(기여 귀속)",
      `insert into private.ticket_ledger (member_id,delta,reason,ref_type,ref_id,contribution_id,idempotency_key)
       values (${A},20,'review_published','course_review',9101,${CONTRIB},'review_reward:c1')`);
    await mustFail("적립 이유에 음수 금지",
      `insert into private.ticket_ledger (member_id,delta,reason,idempotency_key) values (${A},-20,'review_published','k-bad-sign')`);
    await mustFail("clawback은 역분개 대상 필수",
      `insert into private.ticket_ledger (member_id,delta,reason,idempotency_key) values (${A},-20,'clawback','k-no-ref')`);
    await mustFail("원장 UPDATE 금지", `update private.ticket_ledger set delta=999 where idempotency_key='review_reward:c1'`);
    await mustFail("원장 DELETE 금지", `delete from private.ticket_ledger where idempotency_key='review_reward:c1'`);

    const { rows: [{ id: paidId }] } = await client.query(
      `select id from private.ticket_ledger where idempotency_key='review_reward:c1'`);
    await mustFail("금액이 다른 역분개 거부",
      `insert into private.ticket_ledger (member_id,delta,reason,ref_type,ref_id,contribution_id,reverses_entry_id,idempotency_key)
       values (${A},-5,'clawback','course_review',9101,${CONTRIB},${paidId},'rev-wrong-amt')`);
    await mustFail("남의 지급행 역분개 거부",
      `insert into private.ticket_ledger (member_id,delta,reason,ref_type,ref_id,contribution_id,reverses_entry_id,idempotency_key)
       values ('${B_UUID}',-20,'clawback','course_review',9101,${CONTRIB},${paidId},'rev-other')`);
    await mustFail("참조정보를 안 베낀 역분개 거부(계보 보존)",
      `insert into private.ticket_ledger (member_id,delta,reason,ref_type,ref_id,reverses_entry_id,idempotency_key)
       values (${A},-20,'clawback','course_review',99999,${paidId},'rev-badref')`);

    // ── 정정본 철회 시 최초 지급 회수 ──
    await actAs(A_UUID);
    await mustPass("정정본(9103) 철회", `select public.withdraw_course_review(9103)`);
    const { rows: [cb] } = await client.query(
      `select count(*)::int n, coalesce(sum(delta),0)::int s from private.ticket_ledger
        where reason='clawback' and reverses_entry_id=${paidId}`);
    rec("정정본을 철회해도 구버전 보상이 회수됨", cb.n === 1 && cb.s === -20, `${cb.n}건 ${cb.s}`);
    const { rows: [rv] } = await client.query(
      `select id from private.ticket_ledger where reason='clawback' and reverses_entry_id=${paidId}`);
    await mustFail("clawback 자체를 역분개 불가",
      `insert into private.ticket_ledger (member_id,delta,reason,reverses_entry_id,idempotency_key)
       values (${A},20,'clawback',${rv.id},'rev-of-rev')`);

    // ── 정정본 RPC (correction) ──
    // 새 대상에서 깨끗하게: 발행된 리뷰 하나를 만들고 정정해 본다
    await client.query(`insert into private.course_review_subjects (id, course_key, professor_key, course_name_display, professor_display)
      values (9004,'정정테스트','정교수','정정 테스트','정교수')`);
    const alC2 = await alias(9004, A_UUID);
    const { rows: [pubR] } = await client.query(
      `insert into private.course_reviews (subject_id,member_id,actor_alias_id,semester,status,grading,published_at)
       values (9004,${A},${alC2},'2025-1','published','보통',now()) returning id, contribution_id`);

    await actAs(A_UUID);
    const corr = (await client.query(
      `select public.correct_course_review(${pubR.id}, null, null, null, null, '깐깐함') r`)).rows[0].r;
    rec("정정본 생성(구조화 항목만 → 바로 공개)", corr.status === "ok" && corr.new_status === "published",
      JSON.stringify(corr).slice(0, 60));

    const { rows: [chain] } = await client.query(
      `select (select status from private.course_reviews where id=${pubR.id}) old_status,
              (select contribution_id from private.course_reviews where id=${corr.new_review_id}) new_contrib,
              (select supersedes_id from private.course_reviews where id=${corr.new_review_id}) sup,
              (select grading from private.course_reviews where id=${corr.new_review_id}) g`);
    rec("구버전 corrected + contribution 승계 + supersedes 연결",
      chain.old_status === "corrected" && chain.new_contrib === pubR.contribution_id &&
      String(chain.sup) === String(pubR.id) && chain.g === "깐깐함",
      `old=${chain.old_status} sup=${chain.sup}`);

    const { rows: [noPay] } = await client.query(
      `select count(*)::int n from private.ticket_ledger where contribution_id = '${pubR.contribution_id}'`);
    rec("정정에는 보상을 다시 주지 않음", noPay.n === 0, `${noPay.n}건`);

    const again2 = (await client.query(
      `select public.correct_course_review(${pubR.id}, null, null, null, null, '보통') r`)).rows[0].r;
    rec("이미 corrected된 구버전은 재정정 불가", again2.status === "not_correctable", again2.status);

    // 자유서술을 고치면 재검토 대기로 간다
    const corr2 = (await client.query(
      `select public.correct_course_review(${corr.new_review_id}, null, null, null, null, null, '설명을 보탭니다') r`)).rows[0].r;
    rec("자유서술 정정은 검토 대기(submitted)", corr2.status === "ok" && corr2.new_status === "submitted",
      corr2.new_status);

    // 사건 보존 중인 평가는 정정 금지
    await client.query(`update private.course_reviews set status='preserved_for_case' where id=${corr2.new_review_id}`);
    const corr3 = (await client.query(
      `select public.correct_course_review(${corr2.new_review_id}, null, null, null, null, '보통') r`)).rows[0].r;
    rec("사건 보존 중(preserved_for_case)인 평가는 정정 불가", corr3.status === "not_correctable", corr3.status);
    await client.query(`update private.course_reviews set status='withdrawn_by_author', withdrawn_at=now()
       where id=${corr2.new_review_id}`);

    // ── 통계: 표본은 '서로 다른 작성자' ──
    const ALS = alOther;  // 위에서 만든 9002·A의 별칭 재사용 (한 과목 한 회원 1개)
    for (let i = 0; i < 10; i++) {
      const sem = `20${20 + Math.floor(i / 2)}-${(i % 2) + 1}`;
      await client.query(`insert into private.course_reviews
        (subject_id,member_id,actor_alias_id,semester,status,grading,published_at)
        values (9002,${A},${ALS},'${sem}','published','보통',now())`);
    }
    let st = await stats(9002);
    rec("한 사람이 10건 써도 작성자 1명(통계 비공개)",
      st.n_reviewers === 1 && st.disclosure === "none", JSON.stringify(st).slice(0, 60));

    // ★ 실제 9→10 경계 (GPT 요구): 8명 추가 → 9명(full 아님), 1명 더 → 10명(full)
    for (let i = 1; i <= 8; i++) {
      const al = await alias(9002, await mkMember(`s${i}`));
      await client.query(`insert into private.course_reviews
        (subject_id,actor_alias_id,semester,status,grading,published_at)
        values (9002,${al},'2025-1','published','보통',now())`);
    }
    const st9 = await stats(9002);
    rec("작성자 9명에서는 full 아님", st9.n_reviewers === 9 && st9.disclosure !== "full",
      `n=${st9.n_reviewers} ${st9.disclosure}`);

    const al10 = await alias(9002, await mkMember("s10"));
    await client.query(`insert into private.course_reviews
      (subject_id,actor_alias_id,semester,status,grading,published_at)
      values (9002,${al10},'2025-1','published','보통',now())`);
    const st10 = await stats(9002);
    rec("작성자 10명에서 full 공개", st10.n_reviewers === 10 && st10.disclosure === "full",
      `n=${st10.n_reviewers} ${st10.disclosure}`);

    // 희소 셀: 보통 9 / 깐깐함 1 → grading 항목 전체 비공개
    await client.query(`update private.course_reviews set grading='깐깐함'
       where subject_id=9002 and actor_alias_id=${al10}`);
    const stSparse = await stats(9002);
    rec("희소 셀(9:1)이면 그 항목 전체 비공개", stSparse.grading === null,
      `grading=${JSON.stringify(stSparse.grading)}`);

    // ── 빈 페이지 과금 금지 ──
    await client.query(`insert into private.course_review_subjects (id, course_key, professor_key, course_name_display, professor_display)
      values (9003,'평가없는과목','최교수','평가 없는 과목','최교수')`);
    await client.query(`insert into private.ticket_ledger (member_id,delta,reason,idempotency_key)
      values (${A},50,'verification_bonus','k-verification-bonus')`);
    const { rows: [ul] } = await client.query(`select public.unlock_course_reviews(9003) r`);
    const { rows: [ulCnt] } = await client.query(
      `select count(*)::int n from private.ticket_ledger where reason='unlock_subject'`);
    rec("공개 평가 0건인 페이지는 과금하지 않음",
      ul.r.status === "unavailable" && ulCnt.n === 0, `${ul.r.status}, 원장 ${ulCnt.n}건`);

    // ── 가명화 (탈퇴) ──
    await client.query(`select set_config('request.jwt.claims', null, true)`);
    await mustFail("member_id만 null로 바꾸며 ref_id도 바꾸는 UPDATE 거부",
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
    const { rows: [leak] } = await client.query(
      `select count(*)::int n from private.ticket_ledger where idempotency_key like '%${A_UUID}%'`);
    rec("원장 키에 회원 UUID 미잔존", leak.n === 0, `${leak.n}건`);

    // ── 본문 위생 ──
    const alC = AL_B;
    await mustFail("공백만 있는 본문 거부",
      `insert into private.course_reviews (id,subject_id,actor_alias_id,semester,status,body)
       values (9107,9001,${alC},'2025-1','draft','   ')`);
  } finally {
    await client.query("rollback");
    await client.end();
  }

  const pass = results.filter(Boolean).length;
  console.log(`\n=== 010 행동 검증: ${pass}/${results.length} PASS (dev 스키마 무변경) ===`);
  console.log("※ 2세션 동시 잠금해제는 010을 dev에 실제 적용해야 가능 — dev 승격 게이트로 등록(GPT 승인).");
  process.exit(pass === results.length ? 0 : 2);
}
main().catch((e) => { console.error("[fail] " + scrub(e.message || String(e), "", dbUrl)); process.exit(1); });
