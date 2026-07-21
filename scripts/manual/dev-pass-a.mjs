// ============================================================
// dev-pass-a.mjs — DEV TWO-PASS REPLAY / PASS_A (강제 ROLLBACK)
// ============================================================
// GPT 승인 P-20260721-DEV_BASELINE_CONTRADICTION_CORRECTION_01
//   PASS_A_ENTRY_AUTHORIZATION = GRANTED
//   합격 기준 = LAYER_A 자연 transaction rollback
//               → raw ACL·NULL 여부까지 exact match. 물질화 예외 없음.
//
// 절차
//   1 baseline fresh readback (corrected: public table 0 / routine 1)
//   2 단일 connection OUTER BEGIN
//   3 001_BODY~005_BODY 순서 실행 (봉인된 파생본, runtime rewrite 0)
//   4 pre-fence raw·expanded ACL snapshot
//   5 FINAL_FENCE_V2 실행
//   6 in-transaction assertions
//   7 rollback artifact + checksum
//   8 명시 ROLLBACK
//   9 fresh connection readback
//  10 PRE_TX baseline 과 exact 비교
//
// 연속성 증명: 동일 pg_backend_pid / 동일 top-level xid / SET LOCAL sentinel /
//              intermediate COMMIT 0 / observer connection partial visibility 0
//
// 실행: node scripts/manual/dev-pass-a.mjs
// 종료: 0 = PASS, 3 = BLOCKED/FAIL, 1 = 실행 실패
// ============================================================
import pg from "pg";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readDevEnv, assertDevUrl, DEV_REF, refOf, scrub } from "./dev-url.mjs";
import * as L from "./fence-v2-lib.mjs";

const DERIV = join(homedir(), "prod-runs", "TXB_BODY_RC1");
const BASE = join(homedir(), "prod-runs", "DEV_PRE_TX_BASELINE");
const OUT = join(homedir(), "prod-runs", "DEV_PASS_A");
const MIGR = ["001_schemas_roles", "002_foundation", "003_functions_triggers",
              "004_admin_batch_functions", "005_schedules"];
const SENTINEL = "passA-outer-sentinel";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const line = (k, v) => console.log(`  ${String(k).padEnd(46)} ${v}`);
const head = (t) => console.log(`\n=== ${t} ===`);
const fails = [];
const rec = (n, ok, d) => { if (!ok) fails.push(n); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

const { DEV_DB_URL: url } = readDevEnv(["DEV_DB_URL"]);
assertDevUrl(url, "DEV_DB_URL");

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const observer = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function snapshotAll(c) {
  const names = (await L.projectSchemas(c)).map((s) => s.schema);
  const inv = await L.inventory(c, names);
  return {
    schemas: names,
    counts: { rel: inv.relations.length, seq: inv.sequences.length, fn: inv.routines.length,
              sch: inv.schemas.length, col: inv.columns.length },
    rawAcl: await L.rawAclSnapshot(c, names),
    expanded: await L.expandedAclVector(c, inv),
    effective: await L.effectiveVector(c, inv),
    inv,
  };
}

async function main() {
  await client.connect();
  await observer.connect();
  mkdirSync(OUT, { recursive: true });

  // ── 0. 소스 결속 ───────────────────────────────────────────
  head("0. SOURCE IDENTITY 재결속");
  const dm = JSON.parse(readFileSync(join(DERIV, "DERIVATION_MANIFEST.json"), "utf8"));
  let bodySha = {};
  for (const m of MIGR) {
    const p = join(DERIV, `${m}.body.sql`);
    const b = readFileSync(p);
    bodySha[m] = sha256(b);
    rec(`derivative ${m}`, bodySha[m] === dm.files[m].derivative.sha256, bodySha[m].slice(0, 16) + "…");
    // 동결 원본이 변경되지 않았는지도 확인
    const orig = readFileSync(join(process.cwd(), `supabase/migrations/${m}.sql`));
    rec(`frozen original ${m} 무변경`, sha256(orig) === dm.files[m].original.sha256);
  }
  const libSha = sha256(readFileSync(join(process.cwd(), "scripts/manual/fence-v2-lib.mjs")));
  line("fence-v2-lib.mjs sha256", libSha.slice(0, 24) + "…");
  const baseReceipt = JSON.parse(readFileSync(join(BASE, "PRE_TX_BASELINE_RECEIPT.json"), "utf8"));
  line("baseline receipt", baseReceipt.sealed_at_utc);

  if (fails.length) { console.error("\n⛔ SOURCE_IDENTITY_BLOCKED"); return 3; }

  // ── 1. baseline fresh readback ─────────────────────────────
  head("1. baseline fresh readback (corrected 0/1)");
  const pre = await snapshotAll(client);
  const preVer = await L.assertVersion(client, "17.6");
  rec("PostgreSQL 17.6", preVer.ok, preVer.actual);
  rec("public relation 0", pre.counts.rel === 0, String(pre.counts.rel));
  rec("public routine 1", pre.counts.fn === 1, String(pre.counts.fn));
  rec("private 스키마 부재", !pre.schemas.includes("private"), pre.schemas.join(","));
  rec("authz 스키마 부재", !pre.schemas.includes("authz"));
  rec("baseline raw ACL sha 일치", sha256(pre.rawAcl.join("\n")) === baseReceipt.vectors.raw_acl_snapshot_sha256);
  rec("baseline expanded ACL sha 일치", sha256(pre.expanded.join("\n")) === baseReceipt.vectors.canonical_expanded_acl_sha256);
  if (fails.length) { console.error("\n⛔ DEV_BASELINE_DRIFT — PASS_A 시작 금지"); return 3; }

  // ── 2~3. OUTER BEGIN + 001~005 ─────────────────────────────
  head("2~3. OUTER BEGIN → 001_BODY~005_BODY");
  await client.query("begin");
  await client.query(`set local lock_timeout='10s'`);
  await client.query(`set local statement_timeout='600s'`);
  await client.query(`set local application_name = '${SENTINEL}'`);
  const pid0 = (await client.query(`select pg_backend_pid() p`)).rows[0].p;
  const xid0 = (await client.query(`select pg_current_xact_id()::text x`)).rows[0].x;
  line("backend pid / top-level xid", `${pid0} / ${xid0}`);

  let committed = false;
  try {
    for (const m of MIGR) {
      const sql = readFileSync(join(DERIV, `${m}.body.sql`), "utf8");
      await client.query(sql);
      const st = (await client.query(`select current_setting('application_name') a, pg_current_xact_id()::text x`)).rows[0];
      rec(`${m} 적용 + 트랜잭션 연속성`, st.a === SENTINEL && st.x === xid0, `xid ${st.x}`);
    }

    // observer 에서 pre-COMMIT 가시성 0 확인
    const seen = (await observer.query(`select to_regnamespace('private') is not null v`)).rows[0].v;
    rec("observer 의 pre-COMMIT 가시성 0", seen === false, seen ? "private 보임 ⛔" : "안 보임");

    // ── 4. pre-fence snapshot ────────────────────────────────
    // 각 단계에 라벨을 붙여 어느 조회가 실패했는지 즉시 드러나게 한다.
    // (1차 실행에서 "current transaction is aborted" 만 보여 원인 특정에 실패했다)
    head("4. pre-fence snapshot (001~005 적용 직후)");
    const step = async (label, fn) => {
      try { const r = await fn(); line(`  ${label}`, "ok"); return r; }
      catch (e) { throw new Error(`[step4:${label}] ${e.message}`); }
    };
    const midNames = (await step("projectSchemas", () => L.projectSchemas(client))).map((s) => s.schema);
    const midInv = await step("inventory", () => L.inventory(client, midNames));
    const midExpanded = await step("expandedAclVector", () => L.expandedAclVector(client, midInv));
    const midEffective = await step("effectiveVector", () => L.effectiveVector(client, midInv));
    line("분모", `relation=${midInv.relations.length} sequence=${midInv.sequences.length} routine=${midInv.routines.length} schema=${midInv.schemas.length} col=${midInv.columns.length}`);
    const midNull = [...midInv.routines, ...midInv.relations, ...midInv.sequences, ...midInv.schemas].filter((o) => o.acl_is_null).length;
    line("acl_is_null 객체 (물질화 후보)", midNull);

    // ── 5. FINAL_FENCE_V2 ────────────────────────────────────
    head("5. FINAL_FENCE_V2 적용");
    const { stmts, materialized } = L.buildFenceSql(midExpanded, midInv);
    const rollbackSql = L.buildRollbackSql(midExpanded);
    line("REVOKE 문", stmts.length);
    line("rollback GRANT 문", rollbackSql.length);
    line("필요 물질화 대상", materialized.length);
    for (const s of stmts) await client.query(s);

    // ── 6. in-TX assertions ──────────────────────────────────
    head("6. in-transaction assertions");
    const afterInv = await L.inventory(client, midNames);
    const afterEff = await L.effectiveVector(client, afterInv);
    const leaks = Object.entries(afterEff).filter(([k, v]) => {
      if (v !== true) return false;
      const [kind, role, , priv] = k.split("|");
      if (!["anon", "authenticated"].includes(role)) return false;
      if (priv === "SELECT" || (kind === "sch" && priv === "USAGE")) return false;
      return true;
    });
    rec("anon·authenticated mutation privilege 0", leaks.length === 0,
      leaks.length ? leaks.slice(0, 4).map(([k]) => k).join(", ") : "0");
    const selOk = Object.entries(afterEff).filter(([k, v]) => k.endsWith("|SELECT") && v === true).length;
    line("보존된 SELECT 항목", selOk);

    // ── 7. rollback artifact ─────────────────────────────────
    head("7. rollback artifact (COMMIT 전, _INCOMPLETE 격리)");
    const inc = join(OUT, "_INCOMPLETE");
    mkdirSync(inc, { recursive: true });
    writeFileSync(join(inc, "fence-apply.sql"), stmts.join("\n") + "\n");
    writeFileSync(join(inc, "fence-rollback.sql"), rollbackSql.join("\n") + "\n");
    writeFileSync(join(inc, "materialization.json"), JSON.stringify(materialized, null, 2));
    line("상태", "UNCOMMITTED — 권위 없음");

    // ── 8. 명시 ROLLBACK ─────────────────────────────────────
    head("8. 명시 ROLLBACK");
    await client.query("rollback");
    line("실행", "ROLLBACK 완료 (intermediate COMMIT 0)");
  } catch (e) {
    if (!committed) { try { await client.query("rollback"); } catch {} }
    console.error("  실행 오류: " + scrub(e.message || String(e), url).slice(0, 400));
    fails.push("PASS_A 실행 중 오류");
  }

  // ── 9~10. fresh connection readback + exact 비교 ───────────
  head("9~10. fresh connection readback + LAYER_A exact 비교");
  const c2 = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c2.connect();
  const post = await snapshotAll(c2);
  await c2.end();

  rec("public relation 0 복원", post.counts.rel === 0, String(post.counts.rel));
  rec("public routine 1 복원", post.counts.fn === 1, String(post.counts.fn));
  rec("private·authz 스키마 부재", !post.schemas.includes("private") && !post.schemas.includes("authz"));
  const rawSame = sha256(post.rawAcl.join("\n")) === sha256(pre.rawAcl.join("\n"));
  rec("RAW ACL exact match (NULL 여부 포함)", rawSame,
    rawSame ? "동일" : `${sha256(pre.rawAcl.join("\n")).slice(0, 12)} → ${sha256(post.rawAcl.join("\n")).slice(0, 12)}`);
  rec("CANONICAL_EXPANDED_ACL exact match",
    sha256(post.expanded.join("\n")) === sha256(pre.expanded.join("\n")));
  rec("EFFECTIVE_PRIVILEGE exact match",
    sha256(JSON.stringify(post.effective)) === sha256(JSON.stringify(pre.effective)));
  rec("baseline receipt 와 raw ACL 일치",
    sha256(post.rawAcl.join("\n")) === baseReceipt.vectors.raw_acl_snapshot_sha256);

  const receipt = {
    receipt: "PASS_A_EXECUTION_RECEIPT", target_ref: DEV_REF,
    executed_at_utc: new Date().toISOString(),
    source: { derivative_sha256: bodySha, fence_lib_sha256: libSha, derivation_manifest: dm.candidate },
    continuity: { backend_pid: pid0, top_level_xid: xid0, sentinel: SENTINEL, intermediate_commits: 0 },
    baseline_sha: baseReceipt.vectors,
    post_sha: {
      raw_acl: sha256(post.rawAcl.join("\n")),
      expanded: sha256(post.expanded.join("\n")),
      effective: sha256(JSON.stringify(post.effective)),
    },
    result: fails.length ? "FAIL" : "PASS",
    failures: fails,
  };
  writeFileSync(join(OUT, "PASS_A_RECEIPT.json"), JSON.stringify(receipt, null, 2));

  head("판정");
  console.log("");
  console.log(`DEV_PASS_A=${fails.length ? "FAIL" : "PASS"}`);
  console.log(`LAYER_A_RAW_EXACT_MATCH=${rawSame}`);
  console.log(`BACKEND_PID=${pid0} / TOP_LEVEL_XID=${xid0} / INTERMEDIATE_COMMITS=0`);
  console.log(`RECEIPT=${join(OUT, "PASS_A_RECEIPT.json")}`);
  if (fails.length) for (const f of fails) console.log(`  · ${f}`);
  return fails.length ? 3 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await client.end(); } catch {} try { await observer.end(); } catch {} }
process.exit(code);
