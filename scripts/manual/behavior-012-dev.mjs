// 012 추천/반대 · 스크랩 · 신고 행동 검증 (dev, 트랜잭션 롤백).
// 특히 카운터 산술(추천↔반대 전환 시 두 카운터가 함께 움직이는지)과
// 자동 임시 숨김 임계값을 실제로 굴려서 확인한다.
import fs from "node:fs";
import pg from "pg";
import { readDevEnv, assertDevUrl, scrub } from "./dev-url.mjs";

const { DEV_DB_URL: dbUrl } = readDevEnv(["DEV_DB_URL"]);
assertDevUrl(dbUrl, "DEV_DB_URL");
const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

const results = [];
const rec = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
async function mustFail(n, sql) {
  try { await client.query("savepoint s"); await client.query(sql); await client.query("release savepoint s"); rec(n, false, "막혔어야 함"); }
  catch (e) { await client.query("rollback to savepoint s"); rec(n, true, e.message.split("\n")[0].slice(0, 55)); }
}
const actAs = (u) => client.query(`select set_config('request.jwt.claims','{"sub":"${u}"}',true)`);
const U = (i) => `00000000-0000-0000-0000-0000000012${String(i).padStart(2, "0")}`;
const counts = async (id) => (await client.query(
  `select vote_count up, down_count down, hidden_at from public.posts where id=${id}`)).rows[0];

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    const sql = fs.readFileSync("supabase/migrations/pending/012_vote_bookmark_report.sql", "utf8")
      .replace(/^\s*begin\s*;\s*$/gim, "").replace(/^\s*commit\s*;\s*$/gim, "");
    await client.query(sql);

    // 회원 6명 (작성자 1 + 투표·신고자 5)
    for (let i = 0; i < 6; i++) {
      await client.query(`insert into auth.users (id,instance_id,aud,role,email) values
        ('${U(i)}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','u12${i}@example.invalid')`);
      await client.query(`update private.members set nickname='회원${i}', verification_status='verified',
        sanction='none' where id='${U(i)}'`);
    }
    const { rows: [b] } = await client.query(`select id from public.boards where access='members' order by sort limit 1`);

    await actAs(U(0));
    const { rows: [p] } = await client.query(
      `insert into public.posts (board_id,title,body,author_nickname) values (${b.id},'투표대상','본문','회원0') returning id`);
    const P = p.id;

    // ── 추천/반대 ──
    await mustFail("자기 글에는 투표 불가", `select public.vote_post(${P}, 1::smallint)`);

    await actAs(U(1));
    await client.query(`select public.vote_post(${P}, 1::smallint)`);
    let c = await counts(P);
    rec("추천 1", c.up === 1 && c.down === 0, `up=${c.up} down=${c.down}`);

    // 추천 → 반대로 전환: 두 카운터가 함께 움직여야 한다 (여기서 산술 버그가 잘 난다)
    await client.query(`select public.vote_post(${P}, -1::smallint)`);
    c = await counts(P);
    rec("추천→반대 전환 시 up 감소·down 증가", c.up === 0 && c.down === 1, `up=${c.up} down=${c.down}`);

    // 같은 값 재클릭 = 토글 취소
    await client.query(`select public.vote_post(${P}, -1::smallint)`);
    c = await counts(P);
    rec("같은 값 재클릭은 취소", c.up === 0 && c.down === 0, `up=${c.up} down=${c.down}`);

    // 여러 명 투표
    await actAs(U(1)); await client.query(`select public.vote_post(${P}, 1::smallint)`);
    await actAs(U(2)); await client.query(`select public.vote_post(${P}, 1::smallint)`);
    await actAs(U(3)); await client.query(`select public.vote_post(${P}, -1::smallint)`);
    c = await counts(P);
    rec("여러 명 투표 집계", c.up === 2 && c.down === 1, `up=${c.up} down=${c.down}`);

    const { rows: [vr] } = await client.query(`select count(*)::int n from public.post_votes where post_id=${P}`);
    rec("1인 1행 유지", vr.n === 3, `${vr.n}행`);
    await mustFail("잘못된 투표값 거부", `select public.vote_post(${P}, 5::smallint)`);

    // ── 스크랩 ──
    await actAs(U(1));
    const bm1 = (await client.query(`select public.toggle_bookmark(${P}) r`)).rows[0].r;
    const bm2 = (await client.query(`select public.toggle_bookmark(${P}) r`)).rows[0].r;
    rec("스크랩 토글 on/off", bm1.bookmarked === true && bm2.bookmarked === false);
    await client.query(`select public.toggle_bookmark(${P})`);
    const { rows: lb } = await client.query(`select * from public.list_my_bookmarks(50, null)`);
    rec("내 스크랩 목록에 나옴", lb.length === 1 && String(lb[0].post_id) === String(P), `${lb.length}건`);

    // ── 신고: 임계 미만은 숨기지 않는다 ──
    await actAs(U(1)); await client.query(`select public.submit_report('post', ${P}, 'off_topic', null)`);
    c = await counts(P);
    rec("일반 신고 1건으로는 숨기지 않음(보복신고 방지)", c.hidden_at === null);

    await actAs(U(2)); await client.query(`select public.submit_report('post', ${P}, 'off_topic', null)`);
    c = await counts(P);
    rec("일반 신고 2건도 아직 숨기지 않음", c.hidden_at === null);

    await actAs(U(3)); await client.query(`select public.submit_report('post', ${P}, 'off_topic', null)`);
    c = await counts(P);
    rec("서로 다른 3명이면 임시 숨김", c.hidden_at !== null);

    const { rows: [al] } = await client.query(
      `select count(*)::int n from private.audit_logs where action='auto_hide:threshold' and target_id='${P}'`);
    rec("자동 숨김이 감사로그에 남음", al.n === 1);

    // ── 신고: 긴급 사유는 1건으로 즉시 숨김 ──
    await actAs(U(0));
    const { rows: [p2] } = await client.query(
      `insert into public.posts (board_id,title,body,author_nickname) values (${b.id},'긴급대상','본문','회원0') returning id`);
    await actAs(U(4));
    await client.query(`select public.submit_report('post', ${p2.id}, 'privacy', '개인정보 노출')`);
    const c2 = await counts(p2.id);
    rec("긴급 사유(개인정보)는 1건으로 즉시 숨김", c2.hidden_at !== null);
    const { rows: [al2] } = await client.query(
      `select count(*)::int n from private.audit_logs where action='auto_hide:emergency' and target_id='${p2.id}'`);
    rec("긴급 숨김도 감사로그에 남음", al2.n === 1);

    // ── 카운터 직접 조작 차단 ──
    await mustFail("authenticated의 vote_count 직접 수정 권한 없음",
      `set local role authenticated; update public.posts set vote_count = 999 where id = ${P}`);
    await client.query("reset role");
  } finally {
    await client.query("rollback");
    await client.end();
  }
  const pass = results.filter(Boolean).length;
  console.log(`\n=== 012 행동 검증: ${pass}/${results.length} PASS (dev 스키마 무변경) ===`);
  process.exit(pass === results.length ? 0 : 2);
}
main().catch((e) => { console.error("[fail] " + scrub(e.message || String(e), "", dbUrl)); process.exit(1); });
