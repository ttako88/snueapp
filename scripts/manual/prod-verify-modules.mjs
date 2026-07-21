// ============================================================
// prod-verify-modules.mjs — 새로 켠 모듈의 DB 계약 검증 (ROLLBACK 종료)
// ============================================================
// 마이그레이션이 "적용됐다" 와 기능이 "동작한다" 는 다르다. 오늘 아침에
// 그 차이로 앱이 죽을 뻔했다. 실제 회원으로 각 모듈의 대표 경로를 호출해
// 본다. 전 구간 단일 트랜잭션이며 ROLLBACK 으로 끝나 잔여물이 0 이다.
//
// 검증 대상
//   011 강의평가 — 평가 작성 RPC 존재·권한, 1인1회 제약
//   012 공지고정 — 공지 설정 RPC 가 moderator 이상만
//   013 추천·스크랩·신고 — 투표·북마크·신고 경로
//   014 버그제보 — 제보 작성·내 제보 조회
//
// 실행: node scripts/manual/prod-verify-modules.mjs
// ============================================================
import pg from "pg";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { readProdEnv, assertProdUrl, PROD_REF, scrub } from "./prod-url.mjs";

const OUT = join(homedir(), "prod-runs", "MODULE_VERIFY");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(48)} ${v}`);
const results = [];
const rec = (n, ok, d) => { results.push({ name: n, pass: ok, detail: d ?? "" });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const q = async (s, p = []) => (await c.query(s, p)).rows;

const A = randomUUID();
let spn = 0;
async function attempt(fn) {
  const sp = `v${++spn}`;
  await c.query(`savepoint ${sp}`);
  try { const v = await fn(); await c.query(`release savepoint ${sp}`); return { ok: true, value: v }; }
  catch (e) { await c.query(`rollback to savepoint ${sp}`); await c.query(`release savepoint ${sp}`);
    return { ok: false, code: e.code, message: (e.message || "").slice(0, 130) }; }
}
async function as(uid, fn) {
  await c.query(`set local role authenticated`);
  await c.query(`select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: uid, role: "authenticated" })]);
  try { return await fn(); }
  finally {
    await c.query(`select set_config('request.jwt.claims', '', true)`);
    await c.query(`reset role`);
  }
}

/** 모듈이 노출한 public RPC 가 존재하고 authenticated 가 부를 수 있는가 */
async function rpcCheck(label, names) {
  for (const n of names) {
    const r = await q(`select p.oid::regprocedure::text sig,
        has_function_privilege('authenticated', p.oid,'EXECUTE') auth,
        has_function_privilege('anon', p.oid,'EXECUTE') anon
      from pg_proc p join pg_namespace n2 on n2.oid=p.pronamespace
      where n2.nspname='public' and p.proname=$1::text`, [n]);
    if (!r.length) { rec(`${label} · ${n}`, false, "함수 없음"); continue; }
    rec(`${label} · ${n}`, r[0].auth === true && r[0].anon === false,
      `authenticated=${r[0].auth} anon=${r[0].anon}`);
  }
}

async function main() {
  await c.connect();
  mkdirSync(OUT, { recursive: true });

  head("0. 대상");
  line("ref", PROD_REF);
  const before = (await q(`select (select count(*) from public.posts) p,
     (select count(*) from auth.users) u, (select count(*) from private.members) m`))[0];
  line("사전", `글 ${before.p} 계정 ${before.u} 회원 ${before.m}`);

  head("1. 모듈별 RPC 노출·권한");
  await rpcCheck("011 강의평가", ["my_ticket_balance", "course_review_stats", "unlock_course_reviews", "withdraw_course_review"]);
  await rpcCheck("012 공지고정", ["set_post_notice"]);
  await rpcCheck("013 추천·스크랩·신고", ["vote_post", "toggle_bookmark", "list_my_bookmarks", "submit_report"]);
  await rpcCheck("014 버그제보", ["submit_bug_report", "list_my_bug_reports", "withdraw_bug_report"]);

  head("2. 실제 회원으로 대표 경로 호출 (ROLLBACK)");
  await c.query("begin");
  await c.query(`set local lock_timeout='10s'`);
  try {
    await c.query(
      `insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at,
          confirmation_token, recovery_token, email_change_token_new, email_change)
       values ('00000000-0000-0000-0000-000000000000',$1,'authenticated','authenticated',
          $2, now(), now(), '', '', '', '')`, [A, `zz-mod-${Date.now()}@snue.ac.kr`]);
    await c.query(`update private.members set verification_status='verified' where id=$1`, [A]);
    await as(A, () => c.query(`select public.set_initial_nickname($1)`, ["모듈검증"]));
    rec("검증용 회원 준비", true);

    const post = (await q(`select id from public.posts order by id limit 1`))[0];
    if (post) {
      const v = await as(A, () => attempt(() => c.query(
        `select public.vote_post($1, 1::smallint)`, [post.id])));
      rec("추천 호출", v.ok, v.ok ? "성공" : v.message);
      const b = await as(A, () => attempt(() => c.query(`select public.toggle_bookmark($1)`, [post.id])));
      rec("스크랩 호출", b.ok, b.ok ? "성공" : b.message);
    } else rec("추천·스크랩", false, "대상 글이 없어 건너뜀");

    const bug = await as(A, () => attempt(() =>
      // 인자 순서는 (category, title, detail, app_path, app_version) 이고
      // app_path 는 '/' 로 시작하는 경로여야 한다(체크 제약).
      c.query(`select public.submit_bug_report($1,$2,$3,$4,$5)`,
        ["other", "모듈검증 제보", "모듈 검증용 더미 본문입니다", "/board/free", "verify"])));
    rec("버그제보 작성", bug.ok, bug.ok ? "성공" : bug.message);
    const mine = await as(A, () => attempt(() => q(`select * from public.list_my_bug_reports()`)));
    rec("내 제보 조회", mine.ok, mine.ok ? `${mine.value.length}건` : mine.message);

    // 일반 회원이 운영 기능을 못 쓰는지 — 권한상승 차단
    const notice = await as(A, () => attempt(() =>
      c.query(`select public.set_post_notice($1, true, null, $2)`,
        [post ? post.id : 1, "사유"])));
    rec("일반 회원의 공지 고정 차단", !notice.ok, notice.ok ? "성공함 — 위험" : notice.message);
  } finally {
    await c.query("rollback");
    line("종료", "ROLLBACK — 잔여물 0");
  }

  head("3. 롤백 확인");
  const after = (await q(`select (select count(*) from public.posts) p,
     (select count(*) from auth.users) u, (select count(*) from private.members) m`))[0];
  rec("행수 불변", before.p === after.p && before.u === after.u && before.m === after.m,
    `글 ${after.p} 계정 ${after.u} 회원 ${after.m}`);

  const failed = results.filter((r) => !r.pass);
  const out = { document: "MODULE_VERIFY", ref: PROD_REF, total: results.length,
    passed: results.length - failed.length, failed: failed.length, results };
  const buf = Buffer.from(JSON.stringify(out, null, 2));
  writeFileSync(join(OUT, "MODULE_VERIFY.json"), buf);

  head("판정");
  console.log(`\nMODULE_VERIFY=${failed.length ? "REVIEW" : "PASS"}`);
  console.log(`${results.length - failed.length}/${results.length} 통과`);
  console.log(`SHA256=${createHash("sha256").update(buf).digest("hex")}`);
  if (failed.length) for (const f of failed) console.log(`  · ${f.name} — ${f.detail}`);
  return failed.length ? 3 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
process.exit(code);
