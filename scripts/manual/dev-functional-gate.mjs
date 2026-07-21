// ============================================================
// dev-functional-gate.mjs — 기능 게이트 커버리지 실측 (ROLLBACK 전용)
// ============================================================
// GPT: FUNCTIONAL_PROBE_GATE = MANDATORY,
//      FUNCTIONAL_PROBE_COVERAGE = EXACT_DENOMINATOR_REQUIRED
//
// 무엇을 잴 수 있고 무엇을 못 재는지부터 정직하게 나눈다.
//   · dev 에는 001~005 만 적용돼 있다. 007·009 함수는 **존재하지 않는다**.
//   · dev reset 권한이 없다. 따라서 007·009 는 이 게이트로 검증 불가다.
//   · verified 회원 행을 만들 권한도 없다(쓰기 금지). 따라서 역할별
//     성공 경로는 재현할 수 없고, "권한 오류인가 아닌가"만 구별한다.
//
// 판정 구분 (GPT 지정)
//   OK                 정상 허용
//   RLS_DENY           RLS 에 의한 정상 거부(0 rows 또는 의도된 domain error)
//   PERMISSION_FAIL    ACL·schema·function permission 오류 → FAIL
//   UNEXPECTED         예상 못한 SQLSTATE → FAIL
//   NOT_PRESENT        dev 에 함수가 없음 → 분모에서 분리해 계상
//
// 모든 작업은 단일 트랜잭션 안이고 반드시 ROLLBACK 으로 끝난다.
// ============================================================
import pg from "pg";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readDevEnv, assertDevUrl, scrub } from "./dev-url.mjs";

const OUT = join(homedir(), "prod-runs", "FUNCTIONAL_GATE");
const CAND = join(homedir(), "prod-runs", "ALLOWLIST_CLASSIFICATION", "ALLOWLIST_CLASSIFICATION.json");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(48)} ${v}`);

const { DEV_DB_URL: url } = readDevEnv(["DEV_DB_URL"]);
assertDevUrl(url, "DEV_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

// permission 계열 SQLSTATE
const PERM = new Set(["42501"]);          // insufficient_privilege
const MISSING = new Set(["42883", "42P01", "3F000"]); // undefined_function/table/schema

async function main() {
  await c.connect();
  const cand = JSON.parse(readFileSync(CAND, "utf8"));

  head("1. 분모 확정 — dev 에 실재하는 대상만");
  const helpers = (await c.query(
    `select p.oid::regprocedure::text sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='authz' order by 1`)).rows.map((r) => r.sig);
  const publicFns = (await c.query(
    `select p.oid::regprocedure::text sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind='f' order by 1`)).rows.map((r) => r.sig);
  const candNames = cand.rows.map((r) => r.name);
  const present = candNames.filter((n) => publicFns.some((s) => s.startsWith(`${n}(`)));
  const absent = candNames.filter((n) => !present.includes(n));

  line("allowlist 후보 (public RPC)", candNames.length);
  line("  dev 에 실재", present.length);
  line("  dev 에 없음 (007·009 유래)", absent.length);
  line("authz RLS 헬퍼 (dev 실재)", helpers.length);
  line("기능 게이트 분모 = 실재 대상", present.length + helpers.length);
  console.log(`  · dev 부재: ${absent.join(", ") || "없음"}`);

  head("2. RLS 읽기 경로 — 헬퍼 의존 테이블");
  const results = [];
  await c.query("begin");
  try {
    const probe = async (role, sql, label, kind) => {
      await c.query("savepoint fp");
      let outcome, code = null, msg = "";
      try {
        await c.query(`set local role ${role}`);
        await c.query(sql);
        outcome = "OK";
        await c.query("release savepoint fp");
      } catch (e) {
        code = e.code; msg = (e.message || "").slice(0, 100);
        outcome = PERM.has(code) ? "PERMISSION_FAIL"
          : MISSING.has(code) ? "NOT_PRESENT" : "UNEXPECTED";
        await c.query("rollback to savepoint fp");
        await c.query("release savepoint fp");
      }
      await c.query("reset role");
      results.push({ role, label, kind, outcome, code, msg });
      console.log(`  ${outcome.padEnd(16)} ${role.padEnd(14)} ${label}` + (msg ? `\n      ${msg}` : ""));
      return outcome;
    };

    for (const role of ["anon", "authenticated"])
      for (const t of ["public.posts", "public.comments", "public.boards", "public.bookmarks", "public.post_votes"])
        await probe(role, `select count(*) from ${t}`, `select ${t}`, "RLS_READ");

    head("3. authz 헬퍼 직접 호출");
    for (const role of ["anon", "authenticated"])
      for (const sig of helpers) {
        const name = sig.replace(/\(.*/, "");
        const argc = (sig.match(/\(([^)]*)\)/)?.[1] ?? "").split(",").filter((x) => x.trim()).length;
        const args = argc === 0 ? "" : argc === 1 ? "null" : Array(argc).fill("null").join(",");
        await probe(role, `select ${name}(${args})`, `call ${sig}`, "HELPER");
      }

    head("4. public RPC 호출 (dev 실재분)");
    for (const n of present) {
      const sig = publicFns.find((s) => s.startsWith(`${n}(`));
      const argc = (sig.match(/\(([^)]*)\)/)?.[1] ?? "").split(",").filter((x) => x.trim()).length;
      const args = argc === 0 ? "" : Array(argc).fill("null").join(",");
      await probe("authenticated", `select ${n}(${args})`, `call ${sig}`, "RPC");
    }
  } finally {
    await c.query("rollback");
    line("종료", "ROLLBACK — 영구 변경 0");
  }

  head("5. 집계");
  const tally = {};
  for (const r of results) tally[r.outcome] = (tally[r.outcome] || 0) + 1;
  for (const [k, v] of Object.entries(tally).sort()) line(k, v);
  const permFail = results.filter((r) => r.outcome === "PERMISSION_FAIL");
  const byKind = {};
  for (const r of permFail) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
  line("PERMISSION_FAIL 내역 (kind별)", JSON.stringify(byKind));

  head("6. 이 게이트가 증명하지 못하는 것");
  const gaps = [
    `007·009 함수 ${absent.length}건은 dev 에 존재하지 않아 검증 불가 (dev reset 권한 없음)`,
    "verified 회원 행을 만들 수 없어 역할별 성공 경로를 재현할 수 없다 — 권한 오류 여부만 구별했다",
    "null 인자로 호출하므로 domain 오류는 정상이며 성공을 뜻하지 않는다",
    "타인 객체 변경 차단은 실제 데이터가 필요해 여기서 검증하지 않았다",
  ];
  for (const g of gaps) console.log("  · " + g);

  const out = {
    document: "FUNCTIONAL_GATE_COVERAGE",
    denominator: {
      allowlist_candidates: candNames.length,
      present_in_dev: present.length,
      absent_from_dev: absent.length,
      absent_list: absent,
      authz_helpers: helpers.length,
      total_probeable: present.length + helpers.length,
    },
    probe_count: results.length,
    tally,
    permission_failures: permFail,
    results,
    coverage_gaps: gaps,
    ended_with: "ROLLBACK",
  };
  mkdirSync(OUT, { recursive: true });
  const buf = Buffer.from(JSON.stringify(out, null, 2));
  writeFileSync(join(OUT, "FUNCTIONAL_GATE_COVERAGE.json"), buf);

  head("판정");
  console.log(`\nFUNCTIONAL_GATE=${permFail.length ? "FAIL" : "PASS"}`);
  console.log(`PROBES=${results.length} TALLY=${JSON.stringify(tally)}`);
  console.log(`ABSENT_FROM_DEV=${absent.length}`);
  console.log(`SHA256=${createHash("sha256").update(buf).digest("hex")}`);
  console.log(`OUT=${join(OUT, "FUNCTIONAL_GATE_COVERAGE.json")}`);
  return permFail.length ? 3 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
process.exit(code);
