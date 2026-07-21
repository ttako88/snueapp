// 013 버그제보 행동 검증 (dev, 트랜잭션 롤백).
// 권한 경계(제재 중에도 제보 가능한가) · 도배 제한 · 상태 정합성 · 탈퇴 후 존속을 실측.
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
  catch (e) { await client.query("rollback to savepoint s"); rec(n, true, e.message.split("\n")[0].slice(0, 60)); }
}
async function mustPass(n, sql) {
  try { await client.query("savepoint s"); await client.query(sql); await client.query("release savepoint s"); rec(n, true); }
  catch (e) { await client.query("rollback to savepoint s"); rec(n, false, e.message.split("\n")[0].slice(0, 60)); }
}
const actAs = (u) => client.query(`select set_config('request.jwt.claims','{"sub":"${u}"}',true)`);
const U = (s) => `00000000-0000-0000-0000-00000000013${s}`;
const OP = U("1"), ME = U("2"), RESTRICTED = U("3"), BANNED = U("4");

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    const sql = fs.readFileSync("supabase/migrations/pending/013_bug_report.sql", "utf8")
      .replace(/^\s*begin\s*;\s*$/gim, "").replace(/^\s*commit\s*;\s*$/gim, "");
    await client.query(sql);

    for (const [id, nick] of [[OP, "운영자"], [ME, "학생"], [RESTRICTED, "제한회원"], [BANNED, "차단회원"]]) {
      await client.query(`insert into auth.users (id,instance_id,aud,role,email) values
        ('${id}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','${nick}13@example.invalid')`);
      await client.query(`update private.members set nickname='${nick}', verification_status='verified' where id='${id}'`);
    }
    await client.query(`update private.members set role='operator' where id='${OP}'`);
    await client.query(`update private.members set sanction='write_restricted',
      sanction_until = now() + interval '1 day' where id='${RESTRICTED}'`);
    await client.query(`update private.members set sanction='banned' where id='${BANNED}'`);

    const sub = (cat, title, detail, path = null) =>
      `select public.submit_bug_report('${cat}','${title}','${detail}'${path ? `,'${path}'` : ""})`;

    // ── 제보 권한 ──
    await actAs(ME);
    await mustPass("일반 회원 제보", sub("crash", "앱이 꺼져요", "강의 검색에서 학기를 바꾸면 종료됩니다", "/courses/search"));

    await actAs(RESTRICTED);
    await mustPass("글쓰기 제한 중에도 버그 제보는 가능",
      sub("login", "로그인 오류", "제재 안내 화면에서 버튼이 안 눌립니다"));

    await actAs(BANNED);
    await mustFail("영구정지 회원은 제보 불가", sub("other", "테스트", "차단된 회원입니다"));

    // ── 입력 검증 ──
    await actAs(ME);
    await mustFail("잘못된 분류 거부", sub("nonsense", "제목", "내용이 충분히 깁니다"));
    await mustFail("너무 짧은 내용 거부", sub("other", "제목", "짧"));
    await mustFail("공백만 있는 제목 거부", sub("other", "   ", "내용이 충분히 깁니다"));
    await mustFail("앱 경로 형식 위반 거부",
      `select public.submit_bug_report('other','제목','내용이 충분히 깁니다','javascript:alert(1)')`);

    // ── 도배 제한 (10분 3건) ──
    await client.query(sub("other", "두번째", "내용이 충분히 깁니다"));
    const r3 = (await client.query(sub("other", "세번째", "내용이 충분히 깁니다"))).rows[0].submit_bug_report;
    const r4 = (await client.query(sub("other", "네번째", "내용이 충분히 깁니다"))).rows[0].submit_bug_report;
    rec("10분 3건 초과는 rate_limited", r3.status === "received" && r4.status === "rate_limited",
      `3번째=${r3.status} 4번째=${r4.status}`);

    // ── 내 제보 목록 ──
    const mine = (await client.query(`select * from public.list_my_bug_reports()`)).rows;
    rec("내 제보만 보인다", mine.length === 3 && mine.every((x) => x.status === "open"), `${mine.length}건`);

    // ── 운영자 처리 ──
    const { rows: [b] } = await client.query(`select id from private.bug_reports order by id limit 1`);
    await actAs(ME);
    await mustFail("일반 회원은 처리 불가", `select public.triage_bug_report(${b.id}, 'resolved', '고침')`);

    await actAs(OP);
    await mustFail("duplicate인데 원본 미지정 거부", `select public.triage_bug_report(${b.id}, 'duplicate', null, null)`);
    await mustPass("운영자 처리(resolved)", `select public.triage_bug_report(${b.id}, 'resolved', '수정 완료')`);
    const { rows: [h] } = await client.query(
      `select status, handled_by, handled_at is not null hd from private.bug_reports where id=${b.id}`);
    rec("처리자·처리시각 기록", h.status === "resolved" && h.handled_by === OP && h.hd === true);
    const { rows: [al] } = await client.query(
      `select count(*)::int n from private.audit_logs where action='bug_report:resolved' and target_id='${b.id}'`);
    rec("처리가 감사로그에 남음", al.n === 1);

    // ── (R2) 문자열 검증 확대 ──
    // ME는 앞선 도배 테스트로 rate limit에 걸려 있어 검증 전에 rate_limited로 빠진다
    // → 아직 제보하지 않은 회원으로 검사한다
    await actAs(OP);
    await mustFail("제목에 줄바꿈·제어문자 거부",
      `select public.submit_bug_report('other', '제목' || chr(10) || '두줄', '내용이 충분히 깁니다')`);
    await mustFail("앱 버전 형식 위반 거부",
      `select public.submit_bug_report('other','제목','내용이 충분히 깁니다','/settings','v1 ; drop')`);

    // ── (R4) 상태·처리시각 정합 ──
    await actAs(OP);
    await mustFail("종결에는 사유 필수",
      `select public.triage_bug_report(${b.id}, 'wont_fix', null)`);
    await client.query(`select public.triage_bug_report(${b.id}, 'in_progress', '확인 중')`);
    const { rows: [np] } = await client.query(
      `select handled_at, purge_after from private.bug_reports where id=${b.id}`);
    rec("비종결로 되돌리면 처리시각·보존기한이 비워짐",
      np.handled_at === null && np.purge_after === null);
    await client.query(`select public.triage_bug_report(${b.id}, 'resolved', '수정 완료')`);
    const { rows: [tp] } = await client.query(
      `select handled_at is not null h, purge_after is not null p from private.bug_reports where id=${b.id}`);
    rec("종결하면 처리시각·보존기한(12개월) 설정", tp.h === true && tp.p === true);

    // ── (R3) duplicate 순환·연쇄 차단 ──
    const { rows: [d1] } = await client.query(`select id from private.bug_reports order by id offset 1 limit 1`);
    const { rows: [d2] } = await client.query(`select id from private.bug_reports order by id offset 2 limit 1`);
    await mustFail("자기 자신을 원본으로 지정 불가",
      `select public.triage_bug_report(${d1.id}, 'duplicate', '중복', ${d1.id})`);
    await client.query(`select public.triage_bug_report(${d1.id}, 'duplicate', '중복', ${d2.id})`);
    await mustFail("이미 duplicate인 제보를 원본으로 지정 불가(사슬 차단)",
      `select public.triage_bug_report(${d2.id}, 'duplicate', '중복', ${d1.id})`);

    // ── (R5) 본인 철회 → 내용 비식별화 ──
    await actAs(RESTRICTED);
    const { rows: [rb] } = await client.query(
      `select id from private.bug_reports where member_id='${RESTRICTED}' limit 1`);
    await mustPass("제한 회원도 본인 제보 철회 가능", `select public.withdraw_bug_report(${rb.id})`);
    const { rows: [wd] } = await client.query(
      `select title, detail, app_path, withdrawn_at is not null w, purge_after is not null p
         from private.bug_reports where id=${rb.id}`);
    rec("철회 시 제목·상세·경로 비식별화 + 30일 파기 예약",
      wd.title === "(철회된 제보)" && wd.detail === "(철회로 삭제됨)" &&
      wd.app_path === null && wd.w === true && wd.p === true,
      `title=${wd.title}`);

    // ── (R6) 방치 제보 자동 종료 ──
    await client.query(`update private.bug_reports set status='open', handled_at=null,
      updated_at = now() - interval '25 months' where id=${d2.id}`);
    const { rows: [ex] } = await client.query(`select public.job_expire_unattended_bug_reports() n`);
    const { rows: [exr] } = await client.query(
      `select status, handled_at is not null h, purge_after is not null p from private.bug_reports where id=${d2.id}`);
    rec("24개월 방치 제보는 expired_unattended로 자동 종료(wont_fix 아님)",
      ex.n >= 1 && exr.status === "expired_unattended" && exr.h === true && exr.p === true,
      `${exr.status}`);

    // ── (R7) duplicate 계열 파기 순서 ──
    // canonical(d2)이 먼저 지워지면 이를 참조하는 d1의 FK 때문에 배치가 실패한다
    await client.query(`update private.bug_reports set purge_after = now() - interval '1 day'
      where id in (${d1.id}, ${d2.id})`);
    const { rows: [pg] } = await client.query(`select public.job_purge_bug_reports(500) n`);
    const { rows: [left] } = await client.query(
      `select count(*)::int n from private.bug_reports where id in (${d1.id}, ${d2.id})`);
    rec("파기 배치가 duplicate→canonical 순서로 동작(FK 위반 없음)",
      pg.n >= 2 && left.n === 0, `삭제 ${pg.n}건, 남은 ${left.n}건`);

    // ── 탈퇴 후 존속 ──
    await client.query(`select set_config('request.jwt.claims', null, true)`);
    await mustPass("제보자 탈퇴 가능", `delete from auth.users where id = '${ME}'`);
    const { rows: [after] } = await client.query(
      `select count(*)::int n, count(member_id)::int m, count(reporter_withdrawn_at)::int w
         from private.bug_reports where reporter_withdrawn_at is not null or member_id is null`);
    // 앞선 파기 테스트가 일부 행을 지우므로 고정 개수 대신 성질로 검사한다
    rec("탈퇴해도 제보 존속(연결만 끊김 + 시각 기록)",
      after.n > 0 && after.m === 0 && after.w === after.n,
      `행 ${after.n} / member ${after.m} / withdrawn ${after.w}`);
  } finally {
    await client.query("rollback");
    await client.end();
  }
  const pass = results.filter(Boolean).length;
  console.log(`\n=== 013 행동 검증: ${pass}/${results.length} PASS (dev 스키마 무변경) ===`);
  process.exit(pass === results.length ? 0 : 2);
}
main().catch((e) => { console.error("[fail] " + scrub(e.message || String(e), "", dbUrl)); process.exit(1); });
