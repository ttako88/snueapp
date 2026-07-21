// ============================================================
// diag-module-readiness.mjs — 켠 모듈이 실제로 쓸 수 있는 상태인가 (READ-ONLY)
// ============================================================
// 오늘 같은 실수를 두 번 했다. 아침에는 권한만 보고 테이블 존재를 확인하지
// 않았고, 방금은 RPC 존재만 보고 그 RPC 가 쓸 데이터가 있는지 확인하지
// 않았다. "있다" 와 "동작한다" 사이를 계속 건너뛴다.
//
// 이 도구는 모듈마다 세 층을 함께 본다.
//   1. 스위치가 켜져 있나 (features.js)
//   2. DB 객체가 있나 (테이블·RPC)
//   3. 그 기능이 쓸 데이터가 있나 (마스터 데이터·시드)
//
// 3층이 비면 화면은 뜨지만 아무것도 안 나온다. 사용자에게는 고장으로 보인다.
// READ-ONLY.
// ============================================================
import pg from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readProdEnv, assertProdUrl, scrub } from "./prod-url.mjs";

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

// 모듈별로 "이게 없으면 빈 껍데기" 인 선행 데이터를 명시한다.
// null 이면 선행 데이터가 필요 없는 모듈이다.
const MODULES = [
  { key: "courseSearch", label: "강의조회", rpc: [], seed: null,
    note: "courses.json 정적 파일 — DB 불필요" },
  { key: "courseReview", label: "강의평가", rpc: ["course_review_stats", "unlock_course_reviews"],
    seed: { table: "private.course_review_subjects", why: "평가할 과목이 등록돼 있어야 한다" } },
  { key: "boardNotice", label: "공지 고정", rpc: ["set_post_notice"],
    seed: { table: "public.boards", why: "게시판이 있어야 한다" } },
  { key: "postVote", label: "추천/반대", rpc: ["vote_post"],
    seed: { table: "public.posts", why: "추천할 글이 있어야 한다" } },
  { key: "bookmark", label: "스크랩", rpc: ["toggle_bookmark", "list_my_bookmarks"],
    seed: { table: "public.posts", why: "스크랩할 글이 있어야 한다" } },
  { key: "report", label: "신고", rpc: ["submit_report"],
    seed: { table: "public.posts", why: "신고 대상이 있어야 한다" } },
  { key: "bugReport", label: "버그제보", rpc: ["submit_bug_report", "list_my_bug_reports"],
    seed: null, note: "사용자가 바로 쓰는 기능 — 선행 데이터 불필요" },
];

async function main() {
  await c.connect();
  await c.query("begin read only");
  const q = async (s, p = []) => (await c.query(s, p)).rows;

  const src = readFileSync(join(process.cwd(), "app/lib/features.js"), "utf8");
  const flagOf = (key) => {
    const m = new RegExp(`${key}:\\s*\\{\\s*enabled:\\s*(true|false)`).exec(src);
    return m ? m[1] === "true" : null;
  };

  const rows = [];
  for (const mod of MODULES) {
    const on = flagOf(mod.key);
    // RPC 존재
    let rpcOk = true, missing = [];
    for (const fn of mod.rpc) {
      const n = Number((await q(`select count(*) v from pg_proc p
         join pg_namespace ns on ns.oid=p.pronamespace
        where ns.nspname='public' and p.proname=$1::text`, [fn]))[0].v);
      if (n === 0) { rpcOk = false; missing.push(fn); }
    }
    // 선행 데이터
    let seedCount = null, seedOk = true;
    if (mod.seed) {
      try {
        seedCount = Number((await q(`select count(*) v from ${mod.seed.table}`))[0].v);
        seedOk = seedCount > 0;
      } catch { seedCount = null; seedOk = false; }
    }
    rows.push({ ...mod, on, rpcOk, missing, seedCount, seedOk });
  }

  console.log("=== 모듈 준비 상태 ===\n");
  console.log("  모듈           스위치  RPC     데이터        판정");
  console.log("  " + "-".repeat(62));
  for (const r of rows) {
    const seedTxt = r.seed ? `${r.seedCount ?? "?"}행` : "불필요";
    // 켜져 있는데 RPC 나 데이터가 없으면 "빈 껍데기" 다
    const verdict = !r.on ? "꺼짐"
      : !r.rpcOk ? "⛔ RPC 없음"
      : !r.seedOk ? "⚠ 빈 껍데기"
      : "정상";
    console.log(`  ${r.label.padEnd(12)}  ${(r.on ? "ON" : "OFF").padEnd(6)}  ` +
      `${(r.rpcOk ? "OK" : "없음").padEnd(6)}  ${seedTxt.padEnd(12)}  ${verdict}`);
    if (!r.seedOk && r.seed) console.log(`      → ${r.seed.why} (${r.seed.table})`);
    if (r.missing.length) console.log(`      → 없는 함수: ${r.missing.join(", ")}`);
  }

  const hollow = rows.filter((r) => r.on && (!r.rpcOk || !r.seedOk));
  console.log(`\nMODULE_READINESS=${hollow.length ? "REVIEW" : "PASS"}`);
  console.log(`켜진 모듈 ${rows.filter((r) => r.on).length}개 중 빈 껍데기 ${hollow.length}개`);
  if (hollow.length)
    console.log(`  → ${hollow.map((h) => h.label).join(", ")}`);

  await c.query("rollback");
  return hollow.length;
}

let n = -1;
try { n = await main(); }
catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
process.exit(n > 0 ? 3 : 0);
