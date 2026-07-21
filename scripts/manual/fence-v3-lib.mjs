// ============================================================
// fence-v3-lib.mjs — allowlist 기반 fence + 기능 게이트
// ============================================================
// GPT 판정: FINAL_FENCE_V2_PRODUCTION_USE = REJECTED,
//           FENCE_REDESIGN_DIRECTION = APPROVED_IN_PRINCIPLE,
//           FUNCTIONAL_PROBE_GATE = MANDATORY
//
// V2 는 왜 틀렸나
//   "anon·authenticated 의 SELECT 와 schema USAGE 만 남기고 전부 회수" 였다.
//   그 결과 003 이 RLS 평가를 위해 authenticated 에게 준 authz 헬퍼 EXECUTE
//   까지 걷어내 RLS 정책 평가가 permission denied 로 죽었다.
//   실측 39 프로브 중 36 실패.
//
// V3 의 역할 축소
//   fence 는 권한을 더 회수하는 도구가 아니다. 마이그레이션이 만든 자세가
//   실제로 그러한지 **검증**하고, allowlist 밖의 **잔여 노출만** 제거한다.
//   회수 대상 = 실측 노출 − allowlist. 이 차집합이 비어 있으면 아무것도
//   회수하지 않는 것이 정답이다.
//
// 게이트 두 개가 **모두** PASS 해야 fence PASS 다.
//   ACL 게이트  : allowlist 밖 노출 0
//   기능 게이트 : 대표 role 로 실제 실행해 권한 오류 0
// ============================================================
import { createHash } from "node:crypto";
import * as L from "./fence-v2-lib.mjs";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/**
 * allowlist 스펙. exact signature 단위다.
 * 이름 단위로 관리하면 오버로드가 통째로 열리거나 닫힌다.
 */
export function makeAllowlist({ authenticated = [], anon = [], serviceRole = [], publicRole = [] }) {
  const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return {
    authenticated: new Set(authenticated.map(norm)),
    anon: new Set(anon.map(norm)),
    service_role: new Set(serviceRole.map(norm)),
    PUBLIC: new Set(publicRole.map(norm)),
    sha256: sha256(JSON.stringify({ authenticated, anon, serviceRole, publicRole })),
  };
}

/**
 * 현재 노출을 실측하고 allowlist 와 대조한다.
 * 반환의 excess 가 회수 대상이다. 여기서 SQL 을 만들지 않는다 —
 * 무엇을 회수할지 먼저 사람이 보게 하려는 것이다.
 */
export async function auditExposure(client, schemas, allowlist, roles = ["anon", "authenticated"]) {
  const inv = await L.inventory(client, schemas);
  const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const rows = [];
  for (const role of roles) {
    for (const f of inv.routines) {
      // regprocedure 는 search_path 에 있는 스키마를 생략한다. 정규화한다.
      const sig = norm(f.ident.includes(".") ? f.ident : `${f.sch}.${f.ident}`);
      const has = (await client.query(
        `select has_function_privilege($1, $2::oid, 'EXECUTE') x`, [role, f.oid])).rows[0].x;
      if (!has) continue;
      const allowed = allowlist[role]?.has(sig) ?? false;
      rows.push({ role, signature: sig, oid: f.oid, allowed });
    }
  }
  const excess = rows.filter((r) => !r.allowed);
  const covered = rows.filter((r) => r.allowed);
  // allowlist 에 있는데 실제로는 없는 것 — 마이그레이션이 안 준 것이다.
  const missing = [];
  for (const role of roles)
    for (const sig of allowlist[role] ?? [])
      if (!rows.some((r) => r.role === role && r.signature === sig))
        missing.push({ role, signature: sig });

  return {
    routine_denominator: inv.routines.length,
    exposed: rows.length,
    allowed: covered.length,
    excess,
    excess_count: excess.length,
    missing_from_actual: missing,
    missing_count: missing.length,
    allowlist_sha256: allowlist.sha256,
  };
}

/** excess 만 회수하는 최소 SQL. 비어 있으면 빈 배열을 돌려준다. */
export function buildMinimalRevoke(audit) {
  return audit.excess.map((e) =>
    `revoke execute on function ${e.signature} from ${e.role};`);
}

/**
 * 기능 게이트. 대표 role 로 실제 실행해 권한 오류가 나는지 본다.
 * 반드시 호출자의 트랜잭션 안에서 돌리고 ROLLBACK 으로 끝내야 한다.
 *
 * 판정 구분은 GPT 지정을 따른다.
 *   OK / RLS_DENY / PERMISSION_FAIL / UNEXPECTED / NOT_PRESENT
 * PERMISSION_FAIL 이 하나라도 있으면 FAIL 이다.
 */
const PERM = new Set(["42501"]);
const MISSING = new Set(["42883", "42P01", "3F000"]);

export async function functionalGate(client, checks) {
  const results = [];
  let spn = 0;
  for (const chk of checks) {
    const sp = `fg${++spn}`;
    await client.query(`savepoint ${sp}`);
    let outcome, code = null, msg = "";
    try {
      await client.query(`set local role ${chk.role}`);
      await client.query(chk.sql);
      outcome = "OK";
      await client.query(`release savepoint ${sp}`);
    } catch (e) {
      code = e.code; msg = (e.message || "").slice(0, 120);
      outcome = PERM.has(code) ? "PERMISSION_FAIL"
        : MISSING.has(code) ? "NOT_PRESENT"
        : chk.expectDomainError ? "RLS_DENY" : "UNEXPECTED";
      await client.query(`rollback to savepoint ${sp}`);
      await client.query(`release savepoint ${sp}`);
    }
    await client.query("reset role");
    results.push({ ...chk, outcome, code, msg });
  }
  const tally = {};
  for (const r of results) tally[r.outcome] = (tally[r.outcome] || 0) + 1;
  return {
    denominator: checks.length,
    tally,
    permission_failures: results.filter((r) => r.outcome === "PERMISSION_FAIL"),
    unexpected: results.filter((r) => r.outcome === "UNEXPECTED"),
    passed: !results.some((r) => ["PERMISSION_FAIL", "UNEXPECTED"].includes(r.outcome)),
    results,
  };
}

/**
 * RLS 정책이 의존하는 헬퍼를 카탈로그에서 뽑는다.
 * allowlist 를 손으로 적다가 빠뜨리는 것을 막기 위함이다 —
 * 정책이 부르는 함수는 그 role 이 반드시 실행할 수 있어야 한다.
 */
export async function rlsHelperDependencies(client, schemas) {
  const { rows } = await client.query(
    `select schemaname||'.'||tablename tbl, policyname,
            coalesce(qual,'')||' '||coalesce(with_check,'') expr
       from pg_policies where schemaname = any($1::text[])`, [schemas]);
  const deps = new Map();
  for (const r of rows)
    for (const m of (r.expr.match(/\b[a-z_]+\.[a-z_]+\s*\(/gi) || [])) {
      const fn = m.replace(/\s*\($/, "").toLowerCase();
      if (!deps.has(fn)) deps.set(fn, []);
      deps.get(fn).push(`${r.tbl}:${r.policyname}`);
    }
  return {
    policy_count: rows.length,
    policies_using_functions: new Set(rows.filter((r) => /\b[a-z_]+\.[a-z_]+\s*\(/i.test(r.expr))
      .map((r) => `${r.tbl}:${r.policyname}`)).size,
    dependencies: [...deps].map(([fn, policies]) => ({ function: fn, policies })),
  };
}

/**
 * 두 게이트를 묶은 최종 판정.
 * 하나라도 실패하면 fence PASS 가 아니다.
 */
export function verdict(aclAudit, funcGate) {
  const aclPass = aclAudit.excess_count === 0;
  return {
    ACL_GATE: aclPass ? "PASS" : "FAIL",
    FUNCTIONAL_GATE: funcGate.passed ? "PASS" : "FAIL",
    FENCE: aclPass && funcGate.passed ? "PASS" : "FAIL",
    excess_count: aclAudit.excess_count,
    permission_failure_count: funcGate.permission_failures.length,
    unexpected_count: funcGate.unexpected.length,
  };
}
