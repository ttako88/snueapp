// 011 게시판 공지(핀) 행동 검증 (dev, 트랜잭션 안에서만 — 끝나면 ROLLBACK).
// 권한 경계가 의도대로 막히는지를 실제 호출로 확인한다.
// set_post_notice는 auth.uid()로 행위자를 판정하므로, 세션 GUC(request.jwt.claims)를
// 바꿔가며 "누가 호출했는가"를 흉내 낸다.
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
    await client.query("savepoint sp");
    await client.query(sql);
    await client.query("release savepoint sp");
    rec(name, false, "막혔어야 하는데 통과됨");
  } catch (e) {
    await client.query("rollback to savepoint sp");
    rec(name, true, e.message.split("\n")[0].slice(0, 60));
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
    rec(name, false, e.message.split("\n")[0].slice(0, 60));
  }
}
// auth.uid()가 읽는 JWT 클레임을 바꿔 행위자를 바꾼다
const actAs = (uuid) =>
  client.query(`select set_config('request.jwt.claims', '{"sub":"${uuid}"}', true)`);

const OP = "00000000-0000-0000-0000-0000000011a1";  // operator
const ME = "00000000-0000-0000-0000-0000000011a2";  // 일반 회원

async function main() {
  await client.connect();
  await client.query("begin");
  try {
    const sql = fs.readFileSync("supabase/migrations/pending/011_board_notice.sql", "utf8")
      .replace(/^\s*begin\s*;\s*$/gim, "").replace(/^\s*commit\s*;\s*$/gim, "");
    await client.query(sql);

    await client.query(`insert into auth.users (id, instance_id, aud, role, email) values
      ('${OP}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','op011@example.invalid'),
      ('${ME}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','me011@example.invalid')`);
    await client.query(`update private.members set nickname='운영자', role='operator',
      verification_status='verified', sanction='none' where id='${OP}'`);
    await client.query(`update private.members set nickname='학생', role='member',
      verification_status='verified', sanction='none' where id='${ME}'`);

    // posts 삽입 트리거가 auth.uid()로 post_owners를 기록하므로 행위자를 먼저 정한다
    await actAs(OP);

    const { rows: [b] } = await client.query(`select id from public.boards order by sort limit 1`);
    const mkPost = async (title, anon = false) => {
      const { rows: [p] } = await client.query(
        `insert into public.posts (board_id, title, body, author_nickname, is_anonymous)
         values (${b.id}, '${title}', '본문', ${anon ? "null" : "'운영자'"}, ${anon})
         returning id`);
      return p.id;
    };
    const p1 = await mkPost("공지 후보");
    const pAnon = await mkPost("익명글", true);
    const pDel = await mkPost("삭제된 글");
    await client.query(`update public.posts set deleted_at = now() where id = ${pDel}`);

    // ── 권한 ──
    await actAs(ME);
    await mustFail("일반 회원은 공지 고정 불가",
      `select public.set_post_notice(${p1}, true, null, '사유')`);

    await actAs(OP);
    await mustFail("사유 없이 고정 불가",
      `select public.set_post_notice(${p1}, true, null, '   ')`);
    await mustFail("익명 글은 공지로 고정 불가",
      `select public.set_post_notice(${pAnon}, true, null, '사유')`);
    await mustFail("삭제된 글은 공지로 고정 불가",
      `select public.set_post_notice(${pDel}, true, null, '사유')`);
    await mustFail("과거 시각으로 만료 설정 불가",
      `select public.set_post_notice(${p1}, true, now() - interval '1 day', '사유')`);

    await mustPass("운영자는 고정 가능",
      `select public.set_post_notice(${p1}, true, null, '학사일정 안내')`);
    const { rows: [pin] } = await client.query(
      `select pinned_at is not null p, pinned_by from public.posts where id = ${p1}`);
    rec("고정 상태·고정자 기록됨", pin.p === true && pin.pinned_by === OP);

    const { rows: [a1] } = await client.query(
      `select count(*)::int n from private.audit_logs where action='board_notice:pin' and target_id='${p1}'`);
    rec("고정이 감사로그에 남음", a1.n === 1);

    // ── 게시판당 상한 ──
    let capOk = true;
    for (let i = 0; i < 4; i++) {
      const pid = await mkPost(`추가공지${i}`);
      await client.query(`select public.set_post_notice(${pid}, true, null, '사유')`);
    }
    const pOver = await mkPost("상한초과");
    await mustFail("게시판당 고정 상한(5) 초과 불가",
      `select public.set_post_notice(${pOver}, true, null, '사유')`);

    // ── 직접 UPDATE 차단 ──
    await mustFail("authenticated의 pinned_at 직접 수정 권한 없음",
      `set local role authenticated; update public.posts set pinned_at = now() where id = ${pOver}`);
    await client.query("reset role");

    // ── 해제 + 만료 배치 ──
    await actAs(OP);
    await mustPass("고정 해제", `select public.set_post_notice(${p1}, false, null, '기간 종료')`);
    const { rows: [un] } = await client.query(
      `select pinned_at from public.posts where id = ${p1}`);
    rec("해제되면 pinned_at이 비워짐", un.pinned_at === null);

    // 기한부 공지가 만료되면 배치가 내린다
    const pTmp = await mkPost("기한부공지");
    await client.query(`select public.set_post_notice(${pTmp}, true, now() + interval '1 day', '사유')`);
    await client.query(`update public.posts set pinned_until = now() - interval '1 minute' where id = ${pTmp}`);
    const { rows: [job] } = await client.query(`select public.job_expire_notices() n`);
    const { rows: [tmp] } = await client.query(`select pinned_at from public.posts where id = ${pTmp}`);
    rec("만료 배치가 기한 지난 공지를 내림", job.n >= 1 && tmp.pinned_at === null, `해제 ${job.n}건`);
  } finally {
    await client.query("rollback");
    await client.end();
  }

  const pass = results.filter(Boolean).length;
  console.log(`\n=== 011 행동 검증: ${pass}/${results.length} PASS (dev 스키마 무변경) ===`);
  process.exit(pass === results.length ? 0 : 2);
}
main().catch((e) => { console.error("[fail] " + scrub(e.message || String(e), "", dbUrl)); process.exit(1); });
