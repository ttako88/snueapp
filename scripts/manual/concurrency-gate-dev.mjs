// dev 승격 게이트 — 동시성 실측 (010/011/012)
//
// 왜 별도 파일인가:
//   behavior-0*-dev.mjs는 트랜잭션 안에서 스키마를 올리고 롤백하므로 **두 번째 세션이
//   그 테이블을 볼 수 없다.** 진짜 동시성은 스키마가 실제로 커밋돼 있어야 검증된다.
//   → 이 스크립트는 010~012가 **dev에 실제 적용된 뒤에만** 동작한다(미적용이면 즉시 중단).
//
// GPT 공동검수가 dev 승격 차단 조건으로 지정한 4종:
//   1. 010 잔액 5로 서로 다른 과목 동시 잠금해제 → 정확히 1건 성공, 원장 -5 1건, 잔액 0
//   2. 011 남은 1자리에 동시 2핀 → 정확히 1건 성공, 활성 공지 정확히 5개
//   3. 012 서로 다른 3명 동시 신고 → 정확히 1회 숨김
//   4. 012 같은 글 동시 투표 → 카운터가 실제 행 수와 일치
//
// 사용: node scripts/manual/concurrency-gate-dev.mjs
// ⚠️ dev에 실제 데이터를 쓴다. 합성 fixture만 쓰고 끝에 스스로 전부 지운다.
import pg from "pg";
import { readDevEnv, assertDevUrl, scrub } from "./dev-url.mjs";

const { DEV_DB_URL: dbUrl } = readDevEnv(["DEV_DB_URL"]);
assertDevUrl(dbUrl, "DEV_DB_URL");

const results = [];
const rec = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const conn = () => new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
const ok = (r) => r.status === "fulfilled";
const val = (r) => (ok(r) ? r.value : null);

// 두 세션이 같은 지점을 동시에 치도록
const race = (a, b) => Promise.allSettled([a(), b()]);
const actAs = (c, u) => c.query(`select set_config('request.jwt.claims','{"sub":"${u}"}',true)`);

// 이 실행에서 만든 합성 데이터만 지우기 위한 태그
const TAG = "cgate";
const uid = (n) => `00000000-0000-0000-0000-${String(90000 + n).padStart(12, "0")}`;

async function preflight(c) {
  const { rows: [r] } = await c.query(`
    select to_regclass('private.course_reviews') is not null m010,
           to_regclass('private.review_unlocks') is not null m010b,
           to_regprocedure('public.set_post_notice(bigint,boolean,timestamptz,text)') is not null m011,
           to_regprocedure('public.vote_post(bigint,smallint)') is not null m012`);
  if (!(r.m010 && r.m010b && r.m011 && r.m012)) {
    console.error("[중단] 010~012가 dev에 적용돼 있지 않습니다. 이 게이트는 실제 적용 후에만 의미가 있습니다.");
    console.error(`       현재: 010=${r.m010 && r.m010b} 011=${r.m011} 012=${r.m012}`);
    process.exit(3);
  }
}

async function mkMember(c, n, nick, role = "member") {
  await c.query(`insert into auth.users (id,instance_id,aud,role,email) values
    ('${uid(n)}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','${TAG}${n}@example.invalid')
    on conflict do nothing`);
  await c.query(`update private.members set nickname='${nick}', verification_status='verified',
    sanction='none', role='${role}' where id='${uid(n)}'`);
  return uid(n);
}

async function main() {
  const c = conn(); await c.connect();
  await preflight(c);
  const s1 = conn(), s2 = conn(), s3 = conn();
  await s1.connect(); await s2.connect(); await s3.connect();

  console.log("=== dev 동시성 게이트 (실제 다중 세션) ===\n");
  try {
    const M = [];
    for (let i = 0; i < 6; i++) M.push(await mkMember(c, i, `동시성${i}`, i === 5 ? "operator" : "member"));

    // ── 1. 010 동시 잠금해제 ──────────────────────────────
    const { rows: [sa] } = await c.query(`insert into private.course_review_subjects
      (course_key, professor_key, course_name_display, professor_display)
      values ('${TAG}과목가','${TAG}교수','${TAG} 과목가','${TAG}교수') returning id`);
    const { rows: [sb] } = await c.query(`insert into private.course_review_subjects
      (course_key, professor_key, course_name_display, professor_display)
      values ('${TAG}과목나','${TAG}교수','${TAG} 과목나','${TAG}교수') returning id`);
    for (const [sid, who] of [[sa.id, 1], [sb.id, 2]]) {
      const { rows: [al] } = await c.query(`insert into private.course_review_actor_aliases (subject_id, member_id)
        values (${sid}, '${M[who]}') returning id`);
      await c.query(`insert into private.course_reviews
        (subject_id,member_id,actor_alias_id,semester,status,grading,published_at)
        values (${sid},'${M[who]}','${al.id}','2025-1','published','보통',now())`);
    }
    // 해제 1회분(5)만 지급
    await c.query(`insert into private.ticket_ledger (member_id,delta,reason,idempotency_key)
      values ('${M[0]}',5,'verification_bonus','${TAG}-bonus')`);

    await actAs(s1, M[0]); await actAs(s2, M[0]);
    const r1 = await race(
      () => s1.query(`select public.unlock_course_reviews(${sa.id}) r`),
      () => s2.query(`select public.unlock_course_reviews(${sb.id}) r`));
    const statuses = r1.map((x) => (ok(x) ? x.value.rows[0].r.status : "error:" + x.reason.message.slice(0, 30)));
    const unlocked = statuses.filter((s) => s === "unlocked").length;
    const { rows: [ul] } = await c.query(
      `select count(*)::int n from private.ticket_ledger where member_id='${M[0]}' and reason='unlock_subject'`);
    const { rows: [bal] } = await c.query(
      `select coalesce(sum(delta),0)::int b from private.ticket_ledger where member_id='${M[0]}'`);
    rec("010 동시 잠금해제: 정확히 1건 성공·원장 1건·잔액 0",
      unlocked === 1 && ul.n === 1 && bal.b === 0,
      `${JSON.stringify(statuses)} 원장=${ul.n} 잔액=${bal.b}`);

    // ── 2. 011 남은 1자리에 동시 2핀 ───────────────────────
    const { rows: [bd] } = await c.query(`select id from public.boards where access='members' order by sort limit 1`);
    await actAs(c, M[5]);
    const posts = [];
    for (let i = 0; i < 6; i++) {
      const { rows: [p] } = await c.query(`insert into public.posts (board_id,title,body,author_nickname)
        values (${bd.id},'${TAG}공지${i}','본문','동시성5') returning id`);
      posts.push(p.id);
    }
    for (let i = 0; i < 4; i++) await c.query(`select public.set_post_notice(${posts[i]}, true, null, '사전 공지')`);

    await actAs(s1, M[5]); await actAs(s2, M[5]);
    const r2 = await race(
      () => s1.query(`select public.set_post_notice(${posts[4]}, true, null, '동시 시도 A')`),
      () => s2.query(`select public.set_post_notice(${posts[5]}, true, null, '동시 시도 B')`));
    const pinOk = r2.filter(ok).length;
    const { rows: [pinned] } = await c.query(
      `select count(*)::int n from public.posts where board_id=${bd.id} and pinned_at is not null
        and deleted_at is null and hidden_at is null`);
    rec("011 상한 경합: 1건만 성공·활성 공지 정확히 5개",
      pinOk === 1 && pinned.n === 5, `성공=${pinOk} 활성공지=${pinned.n}`);

    // ── 3. 012 서로 다른 3명 동시 신고 ──────────────────────
    await actAs(c, M[5]);
    const { rows: [rp] } = await c.query(`insert into public.posts (board_id,title,body,author_nickname)
      values (${bd.id},'${TAG}신고대상','본문','동시성5') returning id`);
    await actAs(s1, M[1]); await actAs(s2, M[2]); await actAs(s3, M[3]);
    const r3 = await Promise.allSettled([
      s1.query(`select public.submit_report('post', ${rp.id}, 'off_topic', null)`),
      s2.query(`select public.submit_report('post', ${rp.id}, 'off_topic', null)`),
      s3.query(`select public.submit_report('post', ${rp.id}, 'off_topic', null)`)]);
    const { rows: [hid] } = await c.query(`select hidden_at is not null h from public.posts where id=${rp.id}`);
    const { rows: [ah] } = await c.query(
      `select count(*)::int n from private.audit_logs where action like 'auto_hide:%' and target_id='${rp.id}'`);
    rec("012 신고 임계 경합: 3명 동시 신고 → 정확히 1회 숨김",
      hid.h === true && ah.n === 1, `hidden=${hid.h} 자동숨김로그=${ah.n}건 (신고성공 ${r3.filter(ok).length}/3)`);

    // ── 4. 012 동시 투표 ───────────────────────────────────
    await actAs(c, M[5]);
    const { rows: [vp] } = await c.query(`insert into public.posts (board_id,title,body,author_nickname)
      values (${bd.id},'${TAG}투표대상','본문','동시성5') returning id`);
    await actAs(s1, M[1]); await actAs(s2, M[2]);
    await race(
      () => s1.query(`select public.vote_post(${vp.id}, 1::smallint)`),
      () => s2.query(`select public.vote_post(${vp.id}, -1::smallint)`));
    const { rows: [vc] } = await c.query(`
      select p.vote_count up, p.down_count down,
             (select count(*) from public.post_votes v where v.post_id=p.id and v.value=1)::int rup,
             (select count(*) from public.post_votes v where v.post_id=p.id and v.value=-1)::int rdown
        from public.posts p where p.id=${vp.id}`);
    rec("012 동시 투표: 카운터가 실제 행 수와 일치",
      vc.up === vc.rup && vc.down === vc.rdown, `up ${vc.up}/${vc.rup} down ${vc.down}/${vc.rdown}`);

    // ── 정리 ───────────────────────────────────────────────
    await c.query(`delete from public.posts where title like '${TAG}%'`);
    await c.query(`delete from private.course_review_subjects where course_key like '${TAG}%'`);
    await c.query(`delete from auth.users where email like '${TAG}%'`);
    console.log("\n정리 완료 (합성 fixture 삭제)");
  } finally {
    await s1.end(); await s2.end(); await s3.end(); await c.end();
  }

  const pass = results.filter(Boolean).length;
  console.log(`\n=== 동시성 게이트: ${pass}/${results.length} PASS ===`);
  process.exit(pass === results.length ? 0 : 2);
}
main().catch((e) => { console.error("[fail] " + scrub(e.message || String(e), "", dbUrl)); process.exit(1); });
