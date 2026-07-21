// ============================================================
// prod-tx-b.mjs — 운영 TX-B (001~005 적용 + FINAL_FENCE_V2) 러너
// ============================================================
// 상태: 코드만 준비. 실행 권한 없음.
//   TX_A(운영 reset)가 HOLD 이고 AUTH-RESET-PROD-01 이 UNCONSUMED 인 한
//   이 러너는 --dry-run 외에는 동작하지 않는다.
//   실행에는 (a) 상호님의 명시적 승인 (b) 실행 직전 preflight PASS 가 모두
//   필요하며, 두 조건은 이 파일이 스스로 만들어낼 수 없다.
//
// dev PASS_B 에서 드러난 두 구멍을 여기서는 처음부터 막는다.
//   1. COMMIT 전 observer 가시성을 kind 별 정확한 lookup 으로 전수 검사한다.
//      (dev 는 to_regclass 만 써서 95개 중 38개만 봤다)
//   2. fence 적용 직전 RAW ACL 을 봉인한다.
//      (dev 는 봉인을 안 해서 롤백 드릴 raw exact 대조가 사후 불가능해졌다)
//
// 실행 형태
//   node scripts/manual/prod-tx-b.mjs --dry-run     ← 기본. DB 를 쓰지 않는다.
//   node scripts/manual/prod-tx-b.mjs --execute --authorization-file=<path>
//
// 종료: 0 PASS / 2 권한 없음 / 3 게이트 차단 / 4 OUTCOME_UNKNOWN / 1 실행 실패
// ============================================================
import pg from "pg";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readProdEnv, assertProdUrl, PROD_REF, scrub } from "./prod-url.mjs";
import * as L from "./fence-v2-lib.mjs";
import * as O from "./observer-lib.mjs";

const DERIV = join(homedir(), "prod-runs", "TXB_BODY_RC1");
const OUT = join(homedir(), "prod-runs", "PROD_TX_B");
const MIGR = ["001_schemas_roles", "002_foundation", "003_functions_triggers",
              "004_admin_batch_functions", "005_schedules"];
const SENTINEL = "prod-txb-outer-sentinel";
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(46)} ${v}`);
const fails = [];
const rec = (n, ok, d) => { if (!ok) fails.push(n); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

const argv = process.argv.slice(2);
const DRY = !argv.includes("--execute");
const authFile = (argv.find((a) => a.startsWith("--authorization-file=")) || "").split("=")[1];

// ── 권한 게이트: 이 러너는 스스로 승인을 만들어내지 않는다 ──────────
function checkAuthorization() {
  head("0. 실행 권한 게이트");
  if (DRY) { line("모드", "DRY_RUN — DB 에 쓰지 않는다"); return true; }
  if (!authFile || !existsSync(authFile)) {
    console.error("  ⛔ --execute 에는 --authorization-file 이 필요하다.");
    console.error("     승인 파일은 상호님의 명시적 승인이 확인된 뒤에만 생성된다.");
    console.error("     이 러너는 승인을 대신 만들지 않는다.");
    return false;
  }
  let auth;
  try { auth = JSON.parse(readFileSync(authFile, "utf8")); }
  catch { console.error("  ⛔ 승인 파일 파싱 실패"); return false; }
  const ok = auth.token === "AUTH-RESET-PROD-01"
    && auth.status === "GRANTED"
    && auth.consumed === false
    && auth.target_ref === PROD_REF
    && auth.scope === "TX_A_AND_TX_B";
  rec("승인 토큰 형식·대상·미소비", ok, ok ? "" : "형식 불일치 또는 이미 소비됨");
  if (!ok) return false;
  line("승인 발급 시각", auth.granted_at_utc ?? "(미기재)");
  line("승인 경유", auth.relayed_by ?? "(미기재)");
  return true;
}

async function main() {
  if (!checkAuthorization()) return 2;
  mkdirSync(OUT, { recursive: true });

  head("1. 소스 identity (DB 접속 전)");
  const dm = JSON.parse(readFileSync(join(DERIV, "DERIVATION_MANIFEST.json"), "utf8"));
  for (const m of MIGR) {
    rec(`derivative ${m}`,
      sha256(readFileSync(join(DERIV, `${m}.body.sql`))) === dm.files[m].derivative.sha256);
    rec(`frozen original ${m} 무변경`,
      sha256(readFileSync(join(process.cwd(), `supabase/migrations/${m}.sql`))) === dm.files[m].original.sha256);
  }
  const runnerHashes = {};
  for (const f of ["fence-v2-lib.mjs", "observer-lib.mjs", "prod-tx-b.mjs"])
    runnerHashes[f] = sha256(readFileSync(join(process.cwd(), "scripts/manual", f)));
  for (const [k, v] of Object.entries(runnerHashes)) line(k, v.slice(0, 24) + "…");
  if (fails.length) { console.error("\n⛔ SOURCE_IDENTITY_MISMATCH"); return 3; }

  if (DRY) {
    head("DRY_RUN 종료");
    console.log("\n소스 identity 검증까지만 수행했다. DB 에 접속하지 않았다.");
    console.log("PROD_TX_B=DRY_RUN_OK");
    console.log(`RUNNER_HASHES=${JSON.stringify(runnerHashes, null, 1)}`);
    return 0;
  }

  // ── 여기부터는 승인이 확인된 경우에만 도달한다 ──────────────────
  const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
  assertProdUrl(url, "PROD_DB_URL");
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const observer = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect(); await observer.connect();
  let outcome = "NOT_STARTED";

  try {
    head("2. 실행 직전 preflight (fresh 측정)");
    const q = async (s, p = []) => (await client.query(s, p)).rows;
    const g = async (s, p = []) => (await q(s, p))[0];
    const writers = Number((await g(`select count(*) v from pg_stat_activity
      where datname=current_database() and pid<>pg_backend_pid() and state='active'
        and query ~* '^\\s*(insert|update|delete|truncate|alter|drop|create|grant|revoke)'`)).v);
    const prepared = Number((await g(`select count(*) v from pg_prepared_xacts`)).v);
    const blocking = Number((await g(`select count(*) v from pg_locks where not granted`)).v);
    rec("active writer 0", writers === 0, String(writers));
    rec("prepared transaction 0", prepared === 0, String(prepared));
    rec("blocking lock 0", blocking === 0, String(blocking));
    if (fails.length) { console.error("\n⛔ PREFLIGHT_BLOCKED"); return 3; }

    head("3. OUTER BEGIN → 001~005");
    await client.query("begin");
    await client.query(`set local lock_timeout='10s'`);
    await client.query(`set local statement_timeout='900s'`);
    await client.query(`set local application_name = '${SENTINEL}'`);
    const xid0 = (await q(`select pg_current_xact_id()::text x`))[0].x;
    line("top-level xid", xid0);

    for (const m of MIGR) {
      await client.query(readFileSync(join(DERIV, `${m}.body.sql`), "utf8"));
      const st = (await q(`select current_setting('application_name') a, pg_current_xact_id()::text x`))[0];
      rec(`${m} + 트랜잭션 연속성`, st.a === SENTINEL && st.x === xid0, `xid ${st.x}`);
    }

    head("4. COMMIT 전 observer 가시성 — kind별 전수");
    const schemas = (await L.projectSchemas(client)).map((s) => s.schema);
    const baseIdents = new Set();   // 운영 reset 직후이므로 baseline 은 비어 있다
    const manifest = await O.createdManifest(client, schemas, baseIdents);
    line("생성 매니페스트", `${manifest.total} ${JSON.stringify(manifest.byKind)}`);
    const vis = await O.observerVisibility(observer, manifest);
    line("checked / visible / unresolvable",
      `${vis.checked} / ${vis.visible} / ${vis.unresolvable}`);
    rec("observer 가시성 0 (전수 검사)", vis.commitAllowed,
      vis.visible ? `보임: ${vis.visibleList.join(", ")}`
        : vis.unresolvable ? `해석 실패: ${vis.unresolvableList.join(", ")}`
        : `checked ${vis.checked}/${manifest.total}`);
    if (!vis.commitAllowed) { await client.query("rollback"); console.error("\n⛔ OBSERVER_VISIBILITY_BLOCKED — ROLLBACK"); return 3; }

    head("5. fence 직전 RAW ACL 봉인");
    const seal = await O.sealPreFenceRaw(client, schemas);
    writeFileSync(join(OUT, "PRE_FENCE_RAW_SEAL.json"), JSON.stringify(seal, null, 2));
    line("봉인 항목 / NULL acl", `${seal.entry_count} / ${seal.null_acl_count}`);
    line("봉인 sha256", seal.sha256);

    head("6. FINAL_FENCE_V2 적용");
    const inv = await L.inventory(client, schemas);
    const expanded = await L.expandedAclVector(client, inv);
    const built = L.buildFenceSql(expanded, inv);
    const rollbackStmts = L.buildRollbackSql(expanded);
    line("REVOKE / rollback GRANT", `${built.stmts.length} / ${rollbackStmts.length}`);
    line("필요 물질화", built.materialized.length);
    for (const s of built.stmts) await client.query(s);
    writeFileSync(join(OUT, "fence-apply.sql"), built.stmts.join("\n") + "\n");
    writeFileSync(join(OUT, "fence-rollback.sql"), rollbackStmts.join("\n") + "\n");

    head("7. COMMIT 직전 assertion");
    L.resetProbeStats();
    const afterInv = await L.inventory(client, schemas);
    const afterEff = await L.effectiveVector(client, afterInv);
    const ps = { ...L.probeStats };
    const leaks = Object.entries(afterEff).filter(([k, v]) => {
      if (v !== true) return false;
      const [kind, role, , priv] = k.split("|");
      if (!["anon", "authenticated"].includes(role)) return false;
      return !(priv === "SELECT" || (kind === "sch" && priv === "USAGE"));
    });
    rec("anon·authenticated mutation privilege 0", leaks.length === 0,
      leaks.slice(0, 5).map(([k]) => k).join(", ") || "0");
    rec("probe unclassified error 0", ps.unclassified === 0, String(ps.unclassified));
    line("probe attempted/completed", `${ps.attempted}/${ps.completed}`);
    if (fails.length) { await client.query("rollback"); console.error("\n⛔ ASSERTION_FAILED — ROLLBACK"); return 3; }

    await client.query("commit");
    outcome = "COMMITTED";
    line("COMMIT", "완료");
  } catch (e) {
    const msg = scrub(e.message || String(e), url);
    if (/connection|terminat|ECONNRESET|socket/i.test(msg)) {
      outcome = "UNKNOWN";
      console.error(`\n⛔ 연결 유실: ${msg.slice(0, 200)}`);
      console.error("PROD_TX_B_OUTCOME=UNKNOWN / AUTHORITY=LOCKED / AUTOMATIC_RETRY=PROHIBITED");
    } else {
      try { await client.query("rollback"); } catch {}
      outcome = "FAILED_ROLLED_BACK";
      console.error(`\n오류(ROLLBACK): ${msg.slice(0, 300)}`);
    }
  } finally {
    try { await client.end(); } catch {}
    try { await observer.end(); } catch {}
  }

  head("판정");
  console.log(`\nPROD_TX_B=${outcome === "COMMITTED" && !fails.length ? "PASS" : "FAIL"}`);
  console.log(`PROD_TX_B_OUTCOME=${outcome}`);
  return outcome === "UNKNOWN" ? 4 : outcome === "COMMITTED" && !fails.length ? 0 : 3;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e))); }
process.exit(code);
