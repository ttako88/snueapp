// ============================================================
// dev-fence-v3-verify.mjs — fence-v3 검증 (READ-ONLY / ROLLBACK 전용)
// ============================================================
// fence-v3 는 아직 실행 승인이 없다. 여기서는 로직이 실제로 동작하는지만
// 확인한다. dev 는 지금 V2 fence 가 걸려 있어 노출이 거의 0 이므로
// "excess 0" 이 나와도 그게 정답이라는 뜻은 아니다 — 오히려 지금은
// 기능 게이트가 FAIL 이어야 정상이다. 그 두 결과가 함께 나오는지 본다.
//
// 또한 allowlist 를 손으로 적다 빠뜨리는 것을 막기 위해, RLS 정책이
// 의존하는 헬퍼를 카탈로그에서 뽑아 allowlist 와 대조한다.
// ============================================================
import pg from "pg";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readDevEnv, assertDevUrl, scrub } from "./dev-url.mjs";
import * as L from "./fence-v2-lib.mjs";
import * as V3 from "./fence-v3-lib.mjs";

const OUT = join(homedir(), "prod-runs", "FENCE_V3_VERIFY");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(48)} ${v}`);
const fails = [];
const rec = (n, ok, d) => { if (!ok) fails.push(n); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

const { DEV_DB_URL: url } = readDevEnv(["DEV_DB_URL"]);
assertDevUrl(url, "DEV_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

// 001~009 가 의도한 authenticated allowlist (보고서 10 §7 잠정본)
const AUTHENTICATED = [
  "authz.board_access_ok(smallint)", "authz.is_active_member()",
  "authz.is_blocked_author(text,bigint)", "authz.is_writable_member()",
  "authz.post_visible_to_me(bigint)",
  "public.admin_reveal_author(bigint,text,bigint,text)",
  "public.apply_sanction(bigint,text,text)", "public.block_author(text,bigint)",
  "public.change_nickname(text)", "public.close_case(bigint,text,text)",
  "public.get_case(bigint)", "public.get_my_member()",
  "public.get_my_verification_requests()", "public.grant_role(uuid,text,text)",
  "public.list_my_blocks()", "public.list_verification_requests()",
  "public.mark_message_read(bigint)", "public.moderate_content(bigint,text,text)",
  "public.record_member_view(bigint)",
  "public.review_verification(bigint,boolean,text)",
  "public.set_initial_nickname(text)", "public.submit_report(text,bigint,text,text)",
  "public.unblock_author(uuid)", "public.withdraw_verification(bigint)",
];

async function main() {
  await c.connect();
  mkdirSync(OUT, { recursive: true });
  const schemas = (await L.projectSchemas(c)).map((s) => s.schema);

  head("1. allowlist 구성");
  const allow = V3.makeAllowlist({ authenticated: AUTHENTICATED, anon: [], publicRole: [] });
  line("authenticated 항목", allow.authenticated.size);
  line("anon / PUBLIC 항목", `${allow.anon.size} / ${allow.PUBLIC.size}`);
  line("allowlist sha256", allow.sha256.slice(0, 24) + "…");

  head("2. RLS 정책 의존 헬퍼 ↔ allowlist 대조");
  // 손으로 적은 allowlist 가 정책 의존을 빠뜨리면 배포 후 RLS 가 죽는다.
  const deps = await V3.rlsHelperDependencies(c, schemas);
  line("정책 총수", deps.policy_count);
  line("함수를 호출하는 정책", deps.policies_using_functions);
  const helperDeps = deps.dependencies.filter((d) => d.function.startsWith("authz."));
  line("정책이 의존하는 authz 헬퍼", helperDeps.length);
  const missingFromAllow = helperDeps.filter((d) =>
    ![...allow.authenticated].some((s) => s.startsWith(d.function + "(")));
  rec("정책 의존 헬퍼가 전부 allowlist 에 있음", missingFromAllow.length === 0,
    missingFromAllow.map((d) => d.function).join(", ") || "0");
  for (const d of helperDeps)
    line(`  ${d.function}`, `${d.policies.length}개 정책`);

  head("3. ACL 게이트 — 현재 노출 대조");
  const audit = await V3.auditExposure(c, schemas, allow);
  line("routine 분모", audit.routine_denominator);
  line("현재 노출 / allowlist 내", `${audit.exposed} / ${audit.allowed}`);
  line("excess (회수 대상)", audit.excess_count);
  line("allowlist 에 있으나 실제로 없음", audit.missing_count);
  const revokes = V3.buildMinimalRevoke(audit);
  line("최소 REVOKE 문", revokes.length);
  for (const r of revokes.slice(0, 8)) console.log(`    ${r}`);
  // dev 는 V2 fence 가 걸려 있어 노출이 0 에 가깝다.
  // 그래서 excess 0 은 예상된 결과이고, missing 이 크게 나와야 정상이다.
  rec("dev 는 V2 fence 상태이므로 missing 이 다수여야 정상", audit.missing_count > 0,
    `missing ${audit.missing_count}`);

  head("4. 기능 게이트 (ROLLBACK)");
  const checks = [];
  for (const role of ["anon", "authenticated"])
    for (const t of ["public.posts", "public.comments", "public.boards"])
      checks.push({ role, sql: `select count(*) from ${t}`, label: `select ${t}`, kind: "RLS_READ" });
  await c.query("begin");
  let gate;
  try {
    gate = await V3.functionalGate(c, checks);
  } finally {
    await c.query("rollback");
    line("종료", "ROLLBACK — 영구 변경 0");
  }
  line("분모 / 결과", `${gate.denominator} / ${JSON.stringify(gate.tally)}`);
  line("PERMISSION_FAIL", gate.permission_failures.length);
  // V2 fence 가 걸린 상태이므로 기능 게이트는 FAIL 이어야 한다.
  // 여기서 PASS 가 나오면 게이트가 아무것도 못 잡고 있다는 뜻이다.
  rec("V2 fence 상태에서 기능 게이트가 FAIL 을 잡아냄", gate.passed === false,
    `passed=${gate.passed}`);

  head("5. 결합 판정");
  const v = V3.verdict(audit, gate);
  for (const [k, val] of Object.entries(v)) line(k, val);
  rec("ACL PASS 여도 기능 FAIL 이면 FENCE FAIL", v.FENCE === "FAIL",
    `ACL=${v.ACL_GATE} FUNC=${v.FUNCTIONAL_GATE} → FENCE=${v.FENCE}`);

  const out = {
    document: "FENCE_V3_LOGIC_VERIFICATION",
    note: "로직 검증 전용. fence-v3 실행 승인 없음. dev 는 V2 fence 상태 그대로다.",
    allowlist_sha256: allow.sha256,
    rls_dependencies: deps,
    acl_audit: audit,
    functional_gate: { denominator: gate.denominator, tally: gate.tally,
                       permission_failures: gate.permission_failures.length },
    verdict: v,
  };
  const buf = Buffer.from(JSON.stringify(out, null, 2));
  writeFileSync(join(OUT, "FENCE_V3_VERIFY.json"), buf);

  head("판정");
  console.log(`\nFENCE_V3_LOGIC=${fails.length ? "FAIL" : "PASS"}`);
  console.log(`ACL_GATE=${v.ACL_GATE} FUNCTIONAL_GATE=${v.FUNCTIONAL_GATE} FENCE=${v.FENCE}`);
  console.log(`SHA256=${createHash("sha256").update(buf).digest("hex")}`);
  console.log(`OUT=${join(OUT, "FENCE_V3_VERIFY.json")}`);
  if (fails.length) for (const f of fails) console.log(`  · ${f}`);
  return fails.length ? 3 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
process.exit(code);
