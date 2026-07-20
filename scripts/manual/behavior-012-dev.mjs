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
async function mustPass(n, sql) {
  try { await client.query("savepoint s"); await client.query(sql); await client.query("release savepoint s"); rec(n, true); }
  catch (e) { await client.query("rollback to savepoint s"); rec(n, false, e.message.split("\n")[0].slice(0, 55)); }
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
    const { rows: lb } = await client.query(`select * from public.list_my_bookmarks(50, null, null)`);
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

    // ── (012-1) 가시성 우회 ──
    // 접근 불가 게시판(hidden)의 글에는 ID를 알아도 투표·스크랩 불가
    const { rows: [hb] } = await client.query(
      `select id from public.boards where access='hidden' order by sort limit 1`);
    if (hb) {
      await actAs(U(0));
      const { rows: [hp] } = await client.query(
        `insert into public.posts (board_id,title,body,author_nickname) values (${hb.id},'비공개판','본문','회원0') returning id`);
      await actAs(U(1));
      await mustFail("접근 불가 게시판 글에는 투표 불가", `select public.vote_post(${hp.id}, 1::smallint)`);
      await mustFail("접근 불가 게시판 글은 스크랩 불가", `select public.toggle_bookmark(${hp.id})`);
    } else {
      rec("접근 불가 게시판 글 투표/스크랩 차단", true, "hidden 게시판 없음 — 건너뜀");
    }

    // 정지 회원은 북마크 목록으로도 제목을 우회 열람할 수 없다.
    // (앞선 테스트에서 P가 자동숨김됐으므로 새 글을 하나 스크랩해 기준선을 만든다)
    await actAs(U(0));
    const { rows: [pv] } = await client.query(
      `insert into public.posts (board_id,title,body,author_nickname) values (${b.id},'스크랩대상','본문','회원0') returning id`);
    await actAs(U(1));
    await client.query(`select public.toggle_bookmark(${pv.id})`);
    const beforeSusp = (await client.query(`select * from public.list_my_bookmarks(50,null,null)`)).rows.length;
    await client.query(`update private.members set sanction='community_suspended',
      sanction_until = now() + interval '1 day' where id='${U(1)}'`);
    const afterSusp = (await client.query(`select * from public.list_my_bookmarks(50,null,null)`)).rows.length;
    rec("정지 회원은 북마크 목록으로 제목 우회 열람 불가",
      beforeSusp > 0 && afterSusp === 0, `정지 전 ${beforeSusp} → 후 ${afterSusp}`);
    await client.query(`update private.members set sanction='none', sanction_until=null where id='${U(1)}'`);

    // ── (012-3) 긴급 신고 악용 방지 ──
    await actAs(U(0));
    const { rows: [pe] } = await client.query(
      `insert into public.posts (board_id,title,body,author_nickname) values (${b.id},'긴급상세','본문','회원0') returning id`);
    await actAs(U(5));
    await mustFail("긴급 신고는 상세 설명 필수",
      `select public.submit_report('post', ${pe.id}, 'privacy', null)`);

    // 한 신고자의 긴급 자동숨김 24시간 3건 상한
    const madePosts = [];
    for (let i = 0; i < 4; i++) {
      await actAs(U(0));
      const { rows: [pp] } = await client.query(
        `insert into public.posts (board_id,title,body,author_nickname) values (${b.id},'긴급${i}','본문','회원0') returning id`);
      madePosts.push(pp.id);
      await actAs(U(5));
      await client.query(`select public.submit_report('post', ${pp.id}, 'privacy', '개인정보 노출 상세')`);
    }
    const hidden = [];
    for (const id of madePosts) hidden.push((await counts(id)).hidden_at !== null);
    rec("한 신고자의 긴급 자동숨김은 24시간 3건까지",
      hidden.filter(Boolean).length === 3 && hidden[3] === false,
      `숨김 ${hidden.filter(Boolean).length}/4, 4번째=${hidden[3]}`);

    // ── (012-2) 댓글 자동 숨김 + comment_count 1회만 감소 ──
    await actAs(U(0));
    const { rows: [pc] } = await client.query(
      `insert into public.posts (board_id,title,body,author_nickname) values (${b.id},'댓글대상','본문','회원0') returning id`);
    const { rows: [cm] } = await client.query(
      `insert into public.comments (post_id,body,author_nickname) values (${pc.id},'문제 댓글','회원0') returning id`);
    await client.query(`update public.posts set comment_count = 1 where id = ${pc.id}`);
    await actAs(U(1));
    await client.query(`select public.submit_report('comment', ${cm.id}, 'obscene_illegal', '불법 내용 상세')`);
    const { rows: [cc] } = await client.query(
      `select (select hidden_at is not null from public.comments where id=${cm.id}) h,
              (select comment_count from public.posts where id=${pc.id}) n`);
    rec("긴급 신고로 댓글도 자동 숨김 + comment_count 1 감소", cc.h === true && cc.n === 0, `hidden=${cc.h} count=${cc.n}`);

    // ── (012-4) 복구·종결 원자성 ──
    await client.query(`update private.members set role='operator' where id='${U(2)}'`);
    const { rows: [kase] } = await client.query(
      `select id from private.moderation_cases where target_type='comment' and target_id=${cm.id}`);
    await actAs(U(2));
    await mustPass("자동숨김 사건 복구+종결(원자)",
      `select public.resolve_auto_hidden_case(${kase.id}, 'restore', '오신고로 판단')`);
    const { rows: [after] } = await client.query(
      `select (select hidden_at is null from public.comments where id=${cm.id}) h,
              (select comment_count from public.posts where id=${pc.id}) n,
              (select status from private.moderation_cases where id=${kase.id}) s,
              (select emergency from private.moderation_cases where id=${kase.id}) e`);
    rec("복구 시 댓글 노출·카운트 1 증가·사건 종결·긴급 해제",
      after.h === true && after.n === 1 && after.s === "dismissed" && after.e === false,
      `hidden해제=${after.h} count=${after.n} ${after.s} emergency=${after.e}`);
    const again = (await client.query(
      `select public.resolve_auto_hidden_case(${kase.id}, 'restore', '중복 호출')`)).rows[0].resolve_auto_hidden_case;
    rec("이미 처리된 사건은 멱등 수렴", again.status === "already_resolved", again.status);

    // ── (N4) 자동숨김 이력이 남아 있어야 한다 ──
    const { rows: [hist] } = await client.query(
      `select auto_hidden_at is not null a, auto_hide_kind k,
              auto_hide_reviewed_at is not null r, auto_hide_decision d
         from private.moderation_cases where id=${kase.id}`);
    rec("복구해도 자동숨김 이력 보존 + 검토결과 기록",
      hist.a === true && hist.k === "emergency" && hist.r === true && hist.d === "restored",
      `kind=${hist.k} decision=${hist.d}`);

    // ── (N6) get_case가 자동숨김 정보를 돌려주는가 ──
    const { rows: [gc] } = await client.query(`select * from public.get_case(${kase.id})`);
    rec("get_case에 자동숨김 정보 노출(신고자 ID는 미노출)",
      gc.auto_hidden === true && gc.auto_hide_kind === "emergency" &&
      gc.auto_hide_decision === "restored" && gc.review_required === false &&
      !JSON.stringify(gc.reports).includes("reporter"),
      `auto_hidden=${gc.auto_hidden} review_required=${gc.review_required}`);

    // ── (N2) 일반 사건에는 적용되지 않아야 한다 ──
    await actAs(U(1));
    const { rows: [pn] } = await client.query(
      `insert into public.posts (board_id,title,body,author_nickname) values (${b.id},'일반사건','본문','회원1') returning id`);
    await actAs(U(3));
    await client.query(`select public.submit_report('post', ${pn.id}, 'off_topic', null)`);
    const { rows: [nk] } = await client.query(
      `select id from private.moderation_cases where target_type='post' and target_id=${pn.id}`);
    await actAs(U(2));
    const na = (await client.query(
      `select public.resolve_auto_hidden_case(${nk.id}, 'restore', '일반 사건에 호출')`)).rows[0].resolve_auto_hidden_case;
    rec("자동숨김이 아닌 일반 사건은 not_applicable", na.status === "not_applicable", na.status);

    // ── (N3) 자기 사건 처리 금지 ──
    // 운영자(U2)가 쓴 글이 자동숨김되면, 그 사건을 본인이 처리할 수 없어야 한다
    await actAs(U(2));
    const { rows: [pOwn] } = await client.query(
      `insert into public.posts (board_id,title,body,author_nickname) values (${b.id},'운영자글','본문','회원2') returning id`);
    await actAs(U(3));
    await client.query(`select public.submit_report('post', ${pOwn.id}, 'obscene_illegal', '불법 내용 상세')`);
    const { rows: [ok2] } = await client.query(
      `select id from private.moderation_cases where target_type='post' and target_id=${pOwn.id}`);
    await actAs(U(2));
    await mustFail("자기 사건은 본인이 처리 불가",
      `select public.resolve_auto_hidden_case(${ok2.id}, 'restore', '내 글이라 복구')`);
  } finally {
    await client.query("rollback");
    await client.end();
  }
  const pass = results.filter(Boolean).length;
  console.log(`\n=== 012 행동 검증: ${pass}/${results.length} PASS (dev 스키마 무변경) ===`);
  process.exit(pass === results.length ? 0 : 2);
}
main().catch((e) => { console.error("[fail] " + scrub(e.message || String(e), "", dbUrl)); process.exit(1); });
