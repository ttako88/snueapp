// ============================================================
// prod-smoke-tx.mjs — 운영 사용자 경로 스모크 (단일 트랜잭션, ROLLBACK 종료)
// ============================================================
// GPT GATE 2 대응. 다만 영구 테스트 계정을 만들지 않는다.
//
// 왜 트랜잭션인가
//   GPT 는 "타인 콘텐츠 삭제 거부" 검증에 주체 2명이 필요하다고 했고 맞다.
//   그런데 운영에 테스트 계정·글을 영구 생성하면 나중에 지워야 하고,
//   지우는 것도 운영 변경이다. 트랜잭션 안에서 만들고 검증한 뒤 ROLLBACK
//   하면 잔여물이 0 이다. auth.users 도 그 안에서 되돌아간다.
//
// 무엇을 검증하는가 (DB 계약 층)
//   · 가입 트리거가 회원 행을 만드는가
//   · set_initial_nickname / get_my_member 계약
//   · 게시판 슬러그 → board_id 해석
//   · 글·댓글 작성과 조회 (RLS insert/select)
//   · 본인 soft delete 성공
//   · 타인 soft delete 거부 (no-op, 정보 미노출)
//   · anon 차단
//   · 일반 회원의 관리 RPC 권한상승 차단
//
// 검증하지 않는 것 — 정직하게 적는다
//   HTTP·PostgREST·브라우저 클라이언트 층은 여기서 실행되지 않는다.
//   이 스모크는 DB 계약만 본다. 클라이언트 층은 별도로 확인해야 한다.
//
// 실행: node scripts/manual/prod-smoke-tx.mjs --execute
// ============================================================
import pg from "pg";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { readProdEnv, assertProdUrl, PROD_REF, scrub } from "./prod-url.mjs";

const OUT = join(homedir(), "prod-runs", "PROD_SMOKE");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(50)} ${v}`);
const results = [];
const rec = (n, ok, d) => { results.push({ name: n, pass: ok, detail: d ?? "" });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

if (!process.argv.includes("--execute")) {
  console.error("[중단] 운영 대상이다. --execute 를 명시하라.");
  process.exit(2);
}

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

const A = randomUUID(), B = randomUUID();
const q = async (s, p = []) => (await c.query(s, p)).rows;

/** 지정한 사용자로 가장해 실행. auth.uid() 가 request.jwt.claims 를 읽는다. */
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
async function asAnon(fn) {
  await c.query(`set local role anon`);
  try { return await fn(); }
  finally { await c.query(`reset role`); }
}
/** 실패해도 트랜잭션을 죽이지 않게 savepoint 로 감싼다 */
let spn = 0;
async function attempt(fn) {
  const sp = `sm${++spn}`;
  await c.query(`savepoint ${sp}`);
  try { const v = await fn(); await c.query(`release savepoint ${sp}`); return { ok: true, value: v }; }
  catch (e) { await c.query(`rollback to savepoint ${sp}`); await c.query(`release savepoint ${sp}`);
    return { ok: false, code: e.code, message: (e.message || "").slice(0, 140) }; }
}

async function main() {
  await c.connect();
  mkdirSync(OUT, { recursive: true });

  head("0. 대상");
  line("ref", PROD_REF);
  line("사용자 A / B (임시)", `${A.slice(0, 8)}… / ${B.slice(0, 8)}…`);
  const before = {
    users: Number((await q(`select count(*) v from auth.users`))[0].v),
    posts: Number((await q(`select count(*) v from public.posts`))[0].v),
    comments: Number((await q(`select count(*) v from public.comments`))[0].v),
    members: Number((await q(`select count(*) v from private.members`))[0].v),
  };
  line("사전 행수", JSON.stringify(before));

  await c.query("begin");
  await c.query(`set local lock_timeout='10s'`);
  try {
    head("1. 가입 — auth.users 삽입 → 트리거가 회원 행 생성");
    for (const [uid, mail] of [[A, "smoke-a@snue.ac.kr"], [B, "smoke-b@snue.ac.kr"]]) {
      await c.query(
        `insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
            email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
         values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated',
            $2, '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb)`, [uid, mail]);
    }
    const members = Number((await q(`select count(*) v from private.members where id in ($1,$2)`, [A, B]))[0].v);
    rec("가입 트리거가 회원 행 2건 생성", members === 2, `${members}건`);

    // 인증 완료 상태를 만든다(실제로는 서류 심사 경로). 스모크 목적상 직접 세팅.
    await c.query(`update private.members set verification_status='verified' where id in ($1,$2)`, [A, B]);

    head("2. 닉네임 온보딩 (set_initial_nickname / get_my_member)");
    const nickA = await as(A, () => attempt(() => c.query(`select public.set_initial_nickname($1)`, ["스모크A"])));
    rec("A 최초 닉네임 설정", nickA.ok, nickA.ok ? "" : nickA.message);
    const meA = await as(A, () => q(`select * from public.get_my_member()`));
    rec("A get_my_member 가 닉네임 반환", meA.length === 1 && meA[0].nickname === "스모크A",
      meA.length ? `nickname=${meA[0].nickname} status=${meA[0].verification_status}` : "행 없음");
    const dup = await as(B, () => attempt(() => c.query(`select public.set_initial_nickname($1)`, ["스모크A"])));
    rec("B 가 같은 닉네임 요청 시 거부", !dup.ok && /nickname in use/i.test(dup.message || ""),
      dup.ok ? "중복이 허용됨" : dup.message);
    const nickB = await as(B, () => attempt(() => c.query(`select public.set_initial_nickname($1)`, ["스모크B"])));
    rec("B 최초 닉네임 설정", nickB.ok, nickB.ok ? "" : nickB.message);

    head("3. 게시판 해석 + 글·댓글 작성 (RLS)");
    const board = (await as(A, () => q(`select id, slug from public.boards where slug='free'`)))[0];
    rec("A 가 슬러그로 게시판 조회", !!board, board ? `free → id ${board.id}` : "조회 실패");
    const mkPost = await as(A, () => attempt(async () =>
      (await c.query(`insert into public.posts (board_id, title, body, is_anonymous)
         values ($1,$2,$3,false) returning id`, [board.id, "스모크 제목", "스모크 본문"])).rows[0]));
    rec("A 글 작성", mkPost.ok, mkPost.ok ? `id=${mkPost.value.id}` : mkPost.message);
    const postId = mkPost.ok ? mkPost.value.id : null;
    const mkCmt = postId ? await as(A, () => attempt(async () =>
      (await c.query(`insert into public.comments (post_id, body, is_anonymous)
         values ($1,$2,false) returning id`, [postId, "스모크 댓글"])).rows[0])) : { ok: false, message: "글 없음" };
    rec("A 댓글 작성", mkCmt.ok, mkCmt.ok ? `id=${mkCmt.value.id}` : mkCmt.message);

    head("4. 조회 — 목록·본문·소유확인");
    const listB = await as(B, () => q(`select id, title, author_nickname from public.posts
      where board_id=$1 and deleted_at is null order by id desc`, [board.id]));
    rec("B 가 A 의 글을 목록에서 봄", listB.length === 1 && String(listB[0].id) === String(postId),
      `${listB.length}건`);
    const ownB = await as(B, () => q(`select post_id from public.post_owners where post_id=$1`, [postId]));
    rec("B 에게는 A 의 소유행이 안 보임 (RLS)", ownB.length === 0, `${ownB.length}건`);
    const ownA = await as(A, () => q(`select post_id from public.post_owners where post_id=$1`, [postId]));
    rec("A 에게는 본인 소유행이 보임", ownA.length === 1, `${ownA.length}건`);

    head("5. soft delete — 본인 성공 / 타인 거부");
    const delByB = await as(B, () => attempt(() => c.query(`select public.soft_delete_post($1)`, [postId])));
    const stillThere = Number((await q(`select count(*) v from public.posts where id=$1 and deleted_at is null`, [postId]))[0].v);
    rec("B 의 타인 글 삭제 시도가 무효 (no-op)", delByB.ok && stillThere === 1,
      delByB.ok ? `예외 없이 no-op, 글 생존=${stillThere}` : `예외 발생: ${delByB.message}`);
    const delByA = await as(A, () => attempt(() => c.query(`select public.soft_delete_post($1)`, [postId])));
    const gone = Number((await q(`select count(*) v from public.posts where id=$1 and deleted_at is not null`, [postId]))[0].v);
    rec("A 의 본인 글 삭제 성공", delByA.ok && gone === 1, delByA.ok ? `deleted_at 설정됨` : delByA.message);

    head("6. anon 차단");
    const anonPosts = await asAnon(() => attempt(() => c.query(`select count(*) from public.posts`)));
    rec("anon 은 posts 조회 불가", !anonPosts.ok, anonPosts.ok ? "조회됨 — 위험" : `차단(${anonPosts.code})`);
    const anonBoards = await asAnon(() => attempt(() => c.query(`select count(*) from public.boards`)));
    rec("anon 은 boards 미리보기 가능", anonBoards.ok, anonBoards.ok ? "허용" : `차단(${anonBoards.code})`);

    head("7. 권한상승 차단 — 일반 회원의 관리 RPC");
    const adminCalls = [
      ["grant_role", `select public.grant_role($1,'owner','smoke')`, [B]],
      ["moderate_content", `select public.moderate_content(1,'hide','smoke')`, []],
      ["list_verification_requests", `select * from public.list_verification_requests()`, []],
      ["admin_reveal_author", `select * from public.admin_reveal_author(1,'post',1,'smoke')`, []],
    ];
    for (const [name, sql, params] of adminCalls) {
      const r = await as(A, () => attempt(() => c.query(sql, params)));
      rec(`일반 회원이 ${name} 호출 불가`, !r.ok, r.ok ? "성공함 — 위험" : r.message);
    }
  } finally {
    await c.query("rollback");
    line("종료", "ROLLBACK — 운영 잔여물 0");
  }

  head("8. 롤백 후 잔여 확인");
  const after = {
    users: Number((await q(`select count(*) v from auth.users`))[0].v),
    posts: Number((await q(`select count(*) v from public.posts`))[0].v),
    comments: Number((await q(`select count(*) v from public.comments`))[0].v),
    members: Number((await q(`select count(*) v from private.members`))[0].v),
  };
  line("사후 행수", JSON.stringify(after));
  rec("모든 행수가 사전과 동일", JSON.stringify(before) === JSON.stringify(after),
    `${JSON.stringify(before)} → ${JSON.stringify(after)}`);

  const failed = results.filter((r) => !r.pass);
  const out = {
    document: "PROD_USER_PATH_SMOKE",
    method: "단일 트랜잭션 / 임시 사용자 2명 / ROLLBACK 종료 / 영구 잔여물 0",
    layer_covered: "DB 계약 (RLS·RPC·소유권). HTTP·PostgREST·브라우저 층은 미포함.",
    before, after, total: results.length, passed: results.length - failed.length,
    failed: failed.length, results,
  };
  const buf = Buffer.from(JSON.stringify(out, null, 2));
  writeFileSync(join(OUT, "PROD_SMOKE_TX.json"), buf);

  head("판정");
  console.log(`\nPROD_SMOKE_TX=${failed.length ? "FAIL" : "PASS"}`);
  console.log(`${results.length - failed.length}/${results.length} 통과`);
  console.log(`SHA256=${createHash("sha256").update(buf).digest("hex")}`);
  if (failed.length) for (const f of failed) console.log(`  · ${f.name} — ${f.detail}`);
  return failed.length ? 3 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
process.exit(code);
