// ============================================================
// diag-first-post.mjs — 첫 글이 제대로 들어갔는지 확인 (READ-ONLY)
// ============================================================
// "등록됐다" 와 "제대로 들어갔다" 는 다르다. 트리거가 채워야 할 값,
// 소유권 행, 게시판 연결이 맞는지 본다. 본문은 출력하지 않는다.
// READ-ONLY.
// ============================================================
import pg from "pg";
import { readProdEnv, assertProdUrl, scrub } from "./prod-url.mjs";

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const line = (k, v) => console.log(`  ${String(k).padEnd(40)} ${v}`);

async function main() {
  await c.connect();
  await c.query("begin read only");
  const q = async (s, p = []) => (await c.query(s, p)).rows;

  const posts = await q(`select p.id, b.slug board, p.title is not null has_title,
       p.body is not null has_body, p.author_nickname, p.is_anonymous,
       p.comment_count, p.vote_count, p.view_count, p.deleted_at, p.created_at,
       (select count(*) from public.post_owners o where o.post_id=p.id) owners
     from public.posts p join public.boards b on b.id = p.board_id
     order by p.id`);

  console.log(`=== posts (${posts.length}건) ===`);
  for (const p of posts) {
    line(`글 #${p.id}`, `게시판=${p.board}`);
    line("  제목·본문 존재", `${p.has_title} / ${p.has_body}`);
    line("  author_nickname (트리거 채움)", p.author_nickname ?? "★ 비어있음");
    line("  익명 여부", p.is_anonymous);
    line("  소유권 행", `${p.owners}건 ${Number(p.owners) === 1 ? "" : "★"}`);
    line("  카운터 (댓글/추천/조회)", `${p.comment_count}/${p.vote_count}/${p.view_count}`);
    line("  삭제됨", p.deleted_at ? "예" : "아니오");
  }

  console.log("\n=== 전체 현황 ===");
  const s = (await q(`select
      (select count(*) from auth.users) users,
      (select count(*) from private.members) members,
      (select count(*) from private.members where verification_status='verified') verified,
      (select count(*) from public.posts) posts,
      (select count(*) from public.comments) comments`))[0];
  line("계정 / 회원 / 인증됨", `${s.users} / ${s.members} / ${s.verified}`);
  line("글 / 댓글", `${s.posts} / ${s.comments}`);

  const ok = posts.length > 0 && posts.every((p) =>
    p.has_title && p.has_body && Number(p.owners) === 1 && !p.deleted_at
    && (p.is_anonymous || p.author_nickname));
  console.log(`\nFIRST_POST_INTEGRITY=${ok ? "PASS" : "REVIEW"}`);

  await c.query("rollback");
}

try { await main(); }
catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
