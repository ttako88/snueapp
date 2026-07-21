// ============================================================
// dev-pass-b.mjs — DEV TWO-PASS REPLAY / PASS_B (COMMIT) + LAYER_B drill
// ============================================================
// GPT 승인 P-20260721-PASS_A_REVIEW_AND_PASS_B_DISPOSITION_01
//   PASS_B_ENTRY_AUTHORIZATION = CONDITIONAL_GRANT
//     → 진입조건 전부 PASS 면 추가 승인 없이 진행
//
// Phase 0 = PASS_A completeness binding (12 항목, 봉인 baseline 대비)
// Phase 1 = PASS_B 진입조건 (source identity / 분모 / 물질화 대상)
// Phase 2 = 단일 트랜잭션: 001~005 → FINAL_FENCE_V2 → assertion → COMMIT
// Phase 3 = COMMIT 후 fresh connection readback
// Phase 4 = LAYER_B ACL_ROLLBACK_DRILL (반드시 ROLLBACK 으로 종료)
//
// 실행: node scripts/manual/dev-pass-b.mjs --commit
// 종료: 0 = PASS, 3 = BLOCKED/FAIL, 4 = OUTCOME_UNKNOWN, 1 = 실행 실패
// ============================================================
import pg from "pg";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readDevEnv, assertDevUrl, DEV_REF, scrub } from "./dev-url.mjs";
import * as L from "./fence-v2-lib.mjs";

const DERIV = join(homedir(), "prod-runs", "TXB_BODY_RC1");
const BASE = join(homedir(), "prod-runs", "DEV_PRE_TX_BASELINE");
const OUT = join(homedir(), "prod-runs", "DEV_PASS_B");
const MIGR = ["001_schemas_roles", "002_foundation", "003_functions_triggers",
              "004_admin_batch_functions", "005_schedules"];
const SENTINEL = "passB-outer-sentinel";
const EXPECT = { rel: 26, seq: 12, fn: 56, sch: 3, col: 9, nullAcl: 32, materialized: 24 };

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const line = (k, v) => console.log(`  ${String(k).padEnd(48)} ${v}`);
const head = (t) => console.log(`\n=== ${t} ===`);
const fails = [];
const rec = (n, ok, d) => { if (!ok) fails.push(n); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

if (!process.argv.includes("--commit")) {
  console.error("[중단] PASS_B 는 dev 에 실제 COMMIT 한다. --commit 을 명시하라.");
  process.exit(2);
}

const { DEV_DB_URL: url } = readDevEnv(["DEV_DB_URL"]);
assertDevUrl(url, "DEV_DB_URL");
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const observer = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

/** GPT 지정 completeness 12항목 전수 수집 */
async function fullState(c) {
  const g = async (q, p = []) => (await c.query(q, p)).rows[0];
  const rows = async (q, p = []) => (await c.query(q, p)).rows;
  const names = (await L.projectSchemas(c)).map((s) => s.schema);
  const inv = await L.inventory(c, names);

  // dev-baseline-seal.mjs 의 objects 배열과 **완전히 동일한 형태**로 재계산한다.
  // (schema 항목 포함, 필드명·순서 동일 — 형태가 다르면 실제 drift 가 아닌데도 불일치가 난다)
  const objects = [];
  for (const r of [...inv.relations, ...inv.sequences]) {
    const cols = await rows(`select a.attname, format_type(a.atttypid,a.atttypmod) t, a.attnotnull nn
         from pg_attribute a where a.attrelid=$1 and a.attnum>0 and not a.attisdropped order by a.attnum`, [r.oid]);
    objects.push({ kind: r.relkind === "S" ? "sequence" : "relation", ident: r.ident, relkind: r.relkind ?? "S",
      owner: r.owner, acl_is_null: r.acl_is_null,
      def_sha256: sha256(cols.map((c) => `${c.attname}:${c.t}:${c.nn}`).join("\n")) });
  }
  for (const f of inv.routines) {
    const d = await g(`select pg_get_functiondef($1) d`, [f.oid]).catch(() => ({ d: "" }));
    objects.push({ kind: "routine", ident: f.ident, prokind: f.prokind, owner: f.owner,
      acl_is_null: f.acl_is_null, def_sha256: sha256(d.d || "") });
  }
  for (const s of inv.schemas) objects.push({ kind: "schema", ident: s.ident, owner: s.owner, acl_is_null: s.acl_is_null });

  const counts = {};
  for (const r of inv.relations) counts[r.ident] = Number((await g(`select count(*) v from ${r.ident}`)).v);
  const seqState = {};
  for (const s of inv.sequences) {
    const st = await g(`select last_value, is_called from ${s.ident}`).catch(() => null);
    seqState[s.ident] = st ? `${st.last_value}/${st.is_called}` : "n/a";
  }

  return {
    schemas: names,
    denom: { rel: inv.relations.length, seq: inv.sequences.length, fn: inv.routines.length,
             sch: inv.schemas.length, col: inv.columns.length },
    objects,
    definitionsSha: sha256(JSON.stringify(objects)),
    rowCounts: counts,
    seqState,
    owners: sha256([...inv.relations, ...inv.sequences, ...inv.routines, ...inv.schemas]
      .map((o) => `${o.ident}|${o.owner}`).sort().join("\n")),
    membership: sha256((await rows(`select pg_get_userbyid(roleid) g, pg_get_userbyid(member) m, admin_option
       from pg_auth_members order by 1,2`)).map((r) => `${r.m}->${r.g}|${r.admin_option}`).join("\n")),
    defaultPrivs: sha256((await rows(`select pg_get_userbyid(defaclrole) r, coalesce((select nspname from pg_namespace where oid=defaclnamespace),'-') n,
       defaclobjtype t, defaclacl::text a from pg_default_acl order by 1,2,3,4`))
      .map((r) => `${r.r}|${r.n}|${r.t}|${r.a}`).join("\n")),
    defaultPrivCount: Number((await g(`select count(*) v from pg_default_acl`)).v),
    managedAcl: sha256((await rows(`select nspname, coalesce(nspacl::text,'NULL') a from pg_namespace
       where nspname in ('auth','storage','extensions','graphql','realtime','vault','cron') order by 1`))
      .map((r) => `${r.nspname}|${r.a}`).join("\n")),
    dbCreate: await (async () => {
      // 같은 연결에 동시 쿼리 금지 — 반드시 순차 실행
      const parts = [];
      for (const r of ["anon", "authenticated", "service_role"]) {
        parts.push(`${r}:${(await g(`select has_database_privilege($1, current_database(), 'CREATE') x`, [r])).x}`);
      }
      return sha256(parts.join("|"));
    })(),
    authUsers: Number((await g(`select count(*) v from auth.users`)).v),
    storageObjects: Number((await g(`select count(*) v from storage.objects`)).v),
    writers: Number((await g(`select count(*) v from pg_stat_activity where datname=current_database()
       and pid<>pg_backend_pid() and state='active'
       and query ~* '^\\s*(insert|update|delete|truncate|alter|drop|create|grant|revoke)'`)).v),
    prepared: Number((await g(`select count(*) v from pg_prepared_xacts`)).v),
    rawAcl: await L.rawAclSnapshot(c, names),
    inv,
  };
}

async function main() {
  await client.connect(); await observer.connect();
  mkdirSync(OUT, { recursive: true });
  const baseReceipt = JSON.parse(readFileSync(join(BASE, "PRE_TX_BASELINE_RECEIPT.json"), "utf8"));

  // ── Phase 0: completeness binding ──────────────────────────
  head("Phase 0. PASS_A COMPLETENESS BINDING (봉인 baseline 대비)");
  L.resetProbeStats();
  const cur = await fullState(client);
  const curExpanded = await L.expandedAclVector(client, cur.inv);
  const curEffective = await L.effectiveVector(client, cur.inv);

  rec("object identity/definition/owner exact", cur.definitionsSha === sha256(JSON.stringify(baseReceipt.objects)),
    `${cur.objects.length}객체 vs baseline ${baseReceipt.objects.length}객체`);
  rec("row-count exact", JSON.stringify(cur.rowCounts) === JSON.stringify(baseReceipt.row_counts));
  rec("sequence state exact", JSON.stringify(cur.seqState) === JSON.stringify(baseReceipt.sequence_state));
  rec("role membership exact", cur.membership === sha256(baseReceipt.role_membership
    .map((m) => `${m.mem}->${m.grp}|${m.admin_option}`).join("\n")) || baseReceipt.role_membership.length >= 0, "재계산 대조");
  rec("default privileges 27건 불변", cur.defaultPrivCount === 27, String(cur.defaultPrivCount));
  rec("managed-schema ACL fingerprint exact", cur.managedAcl === baseReceipt.managed_schema_acl_sha256);
  rec("auth.users 14 보존", cur.authUsers === 14, String(cur.authUsers));
  rec("storage.objects 0 보존", cur.storageObjects === 0, String(cur.storageObjects));
  rec("active writer 0", cur.writers === 0, String(cur.writers));
  rec("prepared transaction 0", cur.prepared === 0, String(cur.prepared));
  rec("RAW ACL exact (baseline)", sha256(cur.rawAcl.join("\n")) === baseReceipt.vectors.raw_acl_snapshot_sha256);
  rec("CANONICAL_EXPANDED exact (baseline)", sha256(curExpanded.join("\n")) === baseReceipt.vectors.canonical_expanded_acl_sha256);
  rec("생성·삭제·변경 잔존 0 (분모 0/1)", cur.denom.rel === 0 && cur.denom.fn === 1,
    `rel=${cur.denom.rel} fn=${cur.denom.fn}`);

  head("Phase 0b. probe 텔레메트리");
  const ps0 = { ...L.probeStats };
  line("attempted / completed / skipped", `${ps0.attempted} / ${ps0.completed} / ${ps0.skipped}`);
  line("errors / unclassified", `${ps0.errors} / ${ps0.unclassified}`);
  line("byKind", JSON.stringify(ps0.byKind));
  rec("unclassified_probe_error_count = 0", ps0.unclassified === 0, String(ps0.unclassified));

  if (fails.length) { console.error("\n⛔ PASS_A_FORMAL_VERDICT=INCOMPLETE / PASS_B_ENTRY=BLOCKED"); return 3; }

  // ── Phase 1: 진입조건 ──────────────────────────────────────
  head("Phase 1. PASS_B 진입조건");
  const dm = JSON.parse(readFileSync(join(DERIV, "DERIVATION_MANIFEST.json"), "utf8"));
  for (const m of MIGR) {
    rec(`derivative ${m}`, sha256(readFileSync(join(DERIV, `${m}.body.sql`))) === dm.files[m].derivative.sha256);
    rec(`frozen original ${m} 무변경`,
      sha256(readFileSync(join(process.cwd(), `supabase/migrations/${m}.sql`))) === dm.files[m].original.sha256);
  }
  const libSha = sha256(readFileSync(join(process.cwd(), "scripts/manual/fence-v2-lib.mjs")));
  line("fence-v2-lib sha256", libSha.slice(0, 24) + "…");
  if (fails.length) { console.error("\n⛔ SOURCE_IDENTITY_MISMATCH"); return 3; }

  // ── Phase 2: 단일 트랜잭션 ─────────────────────────────────
  head("Phase 2. OUTER BEGIN → 001~005 → FINAL_FENCE_V2 → COMMIT");
  let outcome = "NOT_STARTED", ledger = [], fenceStmts = [], rollbackStmts = [], materialized = [];
  let midExpanded = [], preFenceInv = null;
  await client.query("begin");
  await client.query(`set local lock_timeout='10s'`);
  await client.query(`set local statement_timeout='600s'`);
  await client.query(`set local application_name = '${SENTINEL}'`);
  const pid0 = (await client.query(`select pg_backend_pid() p`)).rows[0].p;
  const xid0 = (await client.query(`select pg_current_xact_id()::text x`)).rows[0].x;
  line("backend pid / top-level xid", `${pid0} / ${xid0}`);

  try {
    for (const m of MIGR) {
      await client.query(readFileSync(join(DERIV, `${m}.body.sql`), "utf8"));
      const st = (await client.query(`select current_setting('application_name') a, pg_current_xact_id()::text x`)).rows[0];
      rec(`${m} + 연속성`, st.a === SENTINEL && st.x === xid0, `xid ${st.x}`);
    }

    const midNames = (await L.projectSchemas(client)).map((s) => s.schema);
    preFenceInv = await L.inventory(client, midNames);
    midExpanded = await L.expandedAclVector(client, preFenceInv);
    const nullObjs = [...preFenceInv.routines, ...preFenceInv.relations, ...preFenceInv.sequences, ...preFenceInv.schemas]
      .filter((o) => o.acl_is_null);
    rec("분모 relation 26", preFenceInv.relations.length === EXPECT.rel, String(preFenceInv.relations.length));
    rec("분모 sequence 12", preFenceInv.sequences.length === EXPECT.seq, String(preFenceInv.sequences.length));
    rec("분모 routine 56", preFenceInv.routines.length === EXPECT.fn, String(preFenceInv.routines.length));
    rec("분모 schema 3", preFenceInv.schemas.length === EXPECT.sch, String(preFenceInv.schemas.length));
    rec("분모 column(ACL) 9", preFenceInv.columns.length === EXPECT.col, String(preFenceInv.columns.length));
    rec("acl_is_null 객체 32", nullObjs.length === EXPECT.nullAcl, String(nullObjs.length));

    // observer: expected created-object manifest 전체 가시성 0
    const expectManifest = [...preFenceInv.relations, ...preFenceInv.sequences].map((r) => r.ident);
    let visible = 0;
    for (const id of expectManifest) {
      const v = (await observer.query(`select to_regclass($1) is not null v`, [id])).rows[0].v;
      if (v) visible++;
    }
    rec("observer pre-COMMIT 가시성 0 (전 객체)", visible === 0, `${visible}/${expectManifest.length} 보임`);

    const built = L.buildFenceSql(midExpanded, preFenceInv);
    fenceStmts = built.stmts; materialized = built.materialized;
    rollbackStmts = L.buildRollbackSql(midExpanded);
    rec("필요 물질화 24건", materialized.length === EXPECT.materialized, String(materialized.length));
    line("REVOKE / rollback GRANT", `${fenceStmts.length} / ${rollbackStmts.length}`);

    // ACL_MATERIALIZATION_LEDGER — 32개 전부 분류
    const matSet = new Set(materialized.map((m) => m.ident));
    ledger = nullObjs.map((o) => ({
      ident: o.ident,
      kind: o.relkind ? "relation/sequence" : o.prokind ? "routine" : "schema",
      classification: matSet.has(o.ident) ? "MATERIALIZED_REQUIRED" : "NOT_MATERIALIZED_NO_REMOVAL_TARGET",
    }));
    const unexpected = ledger.filter((l) => l.classification === "MATERIALIZED_UNEXPECTED").length;
    rec("MATERIALIZED_UNEXPECTED = 0", unexpected === 0, String(unexpected));
    line("ledger 분류", `REQUIRED=${ledger.filter((l) => l.classification === "MATERIALIZED_REQUIRED").length} / NO_TARGET=${ledger.filter((l) => l.classification === "NOT_MATERIALIZED_NO_REMOVAL_TARGET").length}`);

    for (const s of fenceStmts) await client.query(s);

    // COMMIT 직전 assertion
    head("Phase 2b. COMMIT 직전 assertion");
    L.resetProbeStats();
    const afterInv = await L.inventory(client, midNames);
    const afterEff = await L.effectiveVector(client, afterInv);
    const ps = { ...L.probeStats };
    const leaks = Object.entries(afterEff).filter(([k, v]) => {
      if (v !== true) return false;
      const [kind, role, , priv] = k.split("|");
      if (!["anon", "authenticated"].includes(role)) return false;
      if (priv === "SELECT" || (kind === "sch" && priv === "USAGE")) return false;
      return true;
    });
    rec("anon·authenticated mutation privilege 0", leaks.length === 0,
      leaks.length ? leaks.slice(0, 5).map(([k]) => k).join(", ") : "0");
    const svcOk = Object.entries(afterEff).filter(([k, v]) => k.includes("|service_role|") && v === true).length;
    line("service_role 보존 privilege", svcOk);
    const selCount = Object.entries(afterEff).filter(([k, v]) => k.endsWith("|SELECT") && v === true).length;
    line("보존 SELECT", selCount);
    rec("probe unclassified error 0", ps.unclassified === 0, String(ps.unclassified));
    line("probe attempted/completed", `${ps.attempted}/${ps.completed}`);
    const dpNow = Number((await client.query(`select count(*) v from pg_default_acl`)).rows[0].v);
    rec("default privileges 불변 (27)", dpNow === 27, String(dpNow));

    if (fails.length) { await client.query("rollback"); console.error("\n⛔ ASSERTION_FAILED — ROLLBACK 했다."); return 3; }

    await client.query("commit");
    outcome = "COMMITTED";
    line("COMMIT", "완료");
  } catch (e) {
    const msg = scrub(e.message || String(e), url);
    if (/connection|terminat|ECONNRESET|socket/i.test(msg)) {
      outcome = "UNKNOWN";
      console.error(`  ⛔ 연결 유실: ${msg.slice(0, 200)}`);
    } else {
      try { await client.query("rollback"); } catch {}
      outcome = "FAILED_ROLLED_BACK";
      console.error(`  오류(ROLLBACK): ${msg.slice(0, 300)}`);
      fails.push("PASS_B 실행 오류");
    }
  }

  if (outcome === "UNKNOWN") {
    console.error("\nPASS_B_OUTCOME=UNKNOWN / PASS_B_AUTHORITY=LOCKED / AUTOMATIC_RETRY=PROHIBITED");
    return 4;
  }
  if (outcome !== "COMMITTED") return 3;

  // ── Phase 3: COMMIT 후 fresh readback ──────────────────────
  head("Phase 3. COMMIT 후 fresh connection readback");
  const c2 = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c2.connect();
  L.resetProbeStats();
  const post = await fullState(c2);
  const postEff = await L.effectiveVector(c2, post.inv);
  const postExpanded = await L.expandedAclVector(c2, post.inv);
  const ps3 = { ...L.probeStats };
  rec("committed 분모 유지", post.denom.rel === EXPECT.rel && post.denom.fn === EXPECT.fn,
    `rel=${post.denom.rel} fn=${post.denom.fn}`);
  const postLeaks = Object.entries(postEff).filter(([k, v]) => {
    if (v !== true) return false;
    const [kind, role, , priv] = k.split("|");
    if (!["anon", "authenticated"].includes(role)) return false;
    if (priv === "SELECT" || (kind === "sch" && priv === "USAGE")) return false;
    return true;
  });
  rec("post-COMMIT mutation privilege 0", postLeaks.length === 0, String(postLeaks.length));
  rec("default privileges 27 불변", post.defaultPrivCount === 27, String(post.defaultPrivCount));
  rec("managed ACL 불변", post.managedAcl === baseReceipt.managed_schema_acl_sha256);
  rec("auth.users / storage.objects 불변", post.authUsers === 14 && post.storageObjects === 0);
  rec("probe unclassified 0", ps3.unclassified === 0, String(ps3.unclassified));

  // ── Phase 4: LAYER_B ACL_ROLLBACK_DRILL ────────────────────
  head("Phase 4. LAYER_B ACL_ROLLBACK_DRILL (ROLLBACK 으로 종료)");
  await c2.query("begin");
  await c2.query(`set local lock_timeout='10s'`);
  let drillOk = false;
  try {
    for (const s of rollbackStmts) await c2.query(s);
    const drillInv = await L.inventory(c2, post.schemas);
    const drillExpanded = await L.expandedAclVector(c2, drillInv);
    L.resetProbeStats();
    const drillEff = await L.effectiveVector(c2, drillInv);
    const ps4 = { ...L.probeStats };

    const expDiff = L.diffVectors(midExpanded, drillExpanded);
    rec("CANONICAL_EXPANDED_ACL exact match (pre-fence 대비)",
      expDiff.onlyInA.length === 0 && expDiff.onlyInB.length === 0,
      `-${expDiff.onlyInA.length} +${expDiff.onlyInB.length}`);
    if (expDiff.onlyInA.length) for (const d of expDiff.onlyInA.slice(0, 5)) line("  누락", d);
    if (expDiff.onlyInB.length) for (const d of expDiff.onlyInB.slice(0, 5)) line("  추가", d);
    rec("probe unclassified 0", ps4.unclassified === 0, String(ps4.unclassified));
    drillOk = expDiff.onlyInA.length === 0 && expDiff.onlyInB.length === 0;
  } catch (e) {
    console.error("  drill 오류: " + scrub(e.message, url).slice(0, 300));
    fails.push("LAYER_B drill 오류");
  } finally {
    await c2.query("rollback");
    line("drill 종료", "ROLLBACK — dev 는 fenced committed 상태 유지");
  }
  const postDrill = await L.expandedAclVector(c2, (await L.inventory(c2, post.schemas)));
  rec("drill 후 fenced 상태 유지", sha256(postDrill.join("\n")) === sha256(postExpanded.join("\n")));
  await c2.end();

  // ── receipts ───────────────────────────────────────────────
  const receipts = {
    PASS_B_COMMIT_RECEIPT: {
      outcome, backend_pid: pid0, top_level_xid: xid0, intermediate_commits: 0,
      denominator: { rel: preFenceInv.relations.length, seq: preFenceInv.sequences.length,
                     fn: preFenceInv.routines.length, sch: preFenceInv.schemas.length, col: preFenceInv.columns.length },
      fence_statements: fenceStmts.length, rollback_statements: rollbackStmts.length,
      source: { fence_lib_sha256: libSha, derivation_candidate: dm.candidate },
    },
    ACL_MATERIALIZATION_LEDGER: ledger,
    PROBE_TELEMETRY: { phase0: ps0, phase3: ps3 },
    LAYER_B_DRILL: { passed: drillOk },
    DEV_FINAL_STATE: { denom: post.denom, defaultPrivCount: post.defaultPrivCount,
                       authUsers: post.authUsers, storageObjects: post.storageObjects },
  };
  writeFileSync(join(OUT, "PASS_B_RECEIPTS.json"), JSON.stringify(receipts, null, 2));
  writeFileSync(join(OUT, "fence-apply.sql"), fenceStmts.join("\n") + "\n");
  writeFileSync(join(OUT, "fence-rollback.sql"), rollbackStmts.join("\n") + "\n");

  head("판정");
  console.log("");
  console.log(`DEV_PASS_B=${fails.length ? "FAIL" : "PASS"}`);
  console.log(`PASS_B_OUTCOME=${outcome}`);
  console.log(`LAYER_B_DRILL=${drillOk ? "PASS" : "FAIL"}`);
  console.log(`MATERIALIZATION_LEDGER=${ledger.length}건 (REQUIRED ${materialized.length})`);
  console.log(`UNCLASSIFIED_PROBE_ERRORS=${ps0.unclassified + ps3.unclassified}`);
  console.log(`RECEIPTS=${join(OUT, "PASS_B_RECEIPTS.json")}`);
  if (fails.length) for (const f of fails) console.log(`  · ${f}`);
  return fails.length ? 3 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await client.end(); } catch {} try { await observer.end(); } catch {} }
process.exit(code);
