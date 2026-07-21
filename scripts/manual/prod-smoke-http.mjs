// ============================================================
// prod-smoke-http.mjs — 운영 PostgREST 층 스모크 (익명 경로, READ-ONLY)
// ============================================================
// prod-smoke-tx.mjs 는 DB 계약을 직접 검증했다. 그건 SQL 연결로 도는 것이라
// PostgREST·HTTP·공개키 경로는 지나가지 않는다. 여기서 그 층을 본다.
//
// 다루는 범위
//   · 공개키(publishable/anon)로 실제 HTTPS 요청이 도는가
//   · anon 이 boards 미리보기를 읽는가
//   · anon 이 posts·comments 에서 차단되는가
//   · anon 이 RPC 를 호출할 수 없는가
//   · 스키마 캐시가 신 스키마를 반영하는가 (구 컬럼 요청이 실패해야 정상)
//
// 다루지 못하는 범위 — 정직하게 적는다
//   로그인 세션이 필요한 경로(닉네임 온보딩, 글쓰기, 본인 삭제)는 JWT 가
//   있어야 한다. 이메일 OTP 로그인을 스크립트로 대신할 수 없으므로
//   authenticated HTTP 경로는 여기서 검증되지 않는다.
//   그 부분은 prod-smoke-tx.mjs 가 DB 계약 층에서 확인했다.
//
// 쓰기를 하지 않는다. GET 과 실패해야 하는 요청만 보낸다.
// ============================================================
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const OUT = join(homedir(), "prod-runs", "PROD_SMOKE");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(50)} ${v}`);
const results = [];
const rec = (n, ok, d) => { results.push({ name: n, pass: ok, detail: d ?? "" });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

// 공개키만 읽는다. service_role 은 쓰지 않는다.
const env = readFileSync(join(process.cwd(), ".env.local"), "utf8");
const pick = (k) => (new RegExp(`^${k}=(.*)$`, "m").exec(env) || [])[1]?.trim();
const URL_ = pick("NEXT_PUBLIC_SUPABASE_URL");
const KEY = pick("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
const REF = (/https:\/\/([a-z0-9]+)\.supabase\.co/.exec(URL_ || "") || [])[1];
if (!URL_ || !KEY) { console.error("[중단] 공개 env 없음"); process.exit(2); }
if (REF !== "jclwkvxbvsegmbcnptpi") { console.error(`[중단] 운영 ref 아님: ${REF}`); process.exit(2); }

const call = async (path, init = {}) => {
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, ...(init.headers || {}) },
  });
  let body = null;
  try { body = await r.json(); } catch { /* 본문 없음 */ }
  return { status: r.status, body };
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  head("0. 대상");
  line("ref", REF);
  line("키 종류", "publishable/anon (service_role 미사용)");

  head("1. anon 읽기 — 허용돼야 하는 것");
  const boards = await call("boards?select=id,slug,name,access&order=sort");
  rec("boards 미리보기 조회", boards.status === 200 && Array.isArray(boards.body),
    `HTTP ${boards.status}, ${Array.isArray(boards.body) ? boards.body.length + "건" : "배열 아님"}`);
  if (Array.isArray(boards.body) && boards.body.length) {
    const slugs = boards.body.map((b) => b.slug);
    rec("free 게시판이 목록에 있음", slugs.includes("free"), slugs.join(", "));
  }

  head("2. anon 읽기 — 차단돼야 하는 것");
  const posts = await call("posts?select=id,title&limit=1");
  rec("posts 차단", posts.status !== 200 || (Array.isArray(posts.body) && posts.body.length === 0),
    `HTTP ${posts.status}${posts.body?.code ? ` (${posts.body.code})` : ""}`);
  const comments = await call("comments?select=id&limit=1");
  rec("comments 차단", comments.status !== 200 || (Array.isArray(comments.body) && comments.body.length === 0),
    `HTTP ${comments.status}${comments.body?.code ? ` (${comments.body.code})` : ""}`);

  head("3. anon RPC 차단");
  for (const [fn, payload] of [["get_my_member", {}], ["set_initial_nickname", { p_nick: "x" }],
                               ["soft_delete_post", { p_post_id: "1" }]]) {
    const r = await call(`rpc/${fn}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    rec(`anon 이 ${fn} 호출 불가`, r.status !== 200,
      `HTTP ${r.status}${r.body?.code ? ` (${r.body.code})` : ""}`);
  }

  head("4. 스키마 캐시가 신 스키마를 반영하는가");
  // 구 컬럼을 요청해서 실패해야 정상이다. 성공하면 PostgREST 가 옛 스키마를
  // 캐시하고 있다는 뜻이고, 그러면 클라이언트 수정이 무의미해진다.
  const oldCol = await call("posts?select=id&board=eq.free&limit=1");
  rec("구 컬럼 posts.board 요청이 실패", oldCol.status !== 200,
    `HTTP ${oldCol.status}${oldCol.body?.code ? ` (${oldCol.body.code})` : ""}`);
  const oldTable = await call("profiles?select=id&limit=1");
  rec("구 테이블 profiles 요청이 실패", oldTable.status !== 200,
    `HTTP ${oldTable.status}${oldTable.body?.code ? ` (${oldTable.body.code})` : ""}`);
  // 신 컬럼은 스키마 상 인식돼야 한다(행이 안 보이는 것과 컬럼이 없는 것은 다르다)
  const newCol = await call("posts?select=id,board_id&limit=1");
  rec("신 컬럼 posts.board_id 는 인식됨",
    newCol.status === 200 || newCol.body?.code !== "42703",
    `HTTP ${newCol.status}${newCol.body?.code ? ` (${newCol.body.code})` : ""}`);

  const failed = results.filter((r) => !r.pass);
  const out = {
    document: "PROD_HTTP_SMOKE_ANON",
    layer_covered: "HTTPS / PostgREST / 공개키 / RLS(익명 경로)",
    not_covered: "authenticated HTTP 경로 — 이메일 OTP 로그인을 스크립트로 대신할 수 없다. "
      + "해당 계약은 prod-smoke-tx.mjs 가 DB 층에서 확인했다.",
    total: results.length, passed: results.length - failed.length, failed: failed.length, results,
  };
  const buf = Buffer.from(JSON.stringify(out, null, 2));
  writeFileSync(join(OUT, "PROD_SMOKE_HTTP.json"), buf);

  head("판정");
  console.log(`\nPROD_SMOKE_HTTP=${failed.length ? "FAIL" : "PASS"}`);
  console.log(`${results.length - failed.length}/${results.length} 통과`);
  console.log(`SHA256=${createHash("sha256").update(buf).digest("hex")}`);
  if (failed.length) for (const f of failed) console.log(`  · ${f.name} — ${f.detail}`);
  return failed.length ? 3 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + (e.message || String(e))); }
process.exit(code);
