// ============================================================
// prod-deploy-a.mjs — 운영 배포 (경로 A: fence 제외)
// ============================================================
// 권한: 상호님이 경로 A 를 명시적으로 선택했다.
//   "a로 가자 너무 검증이 철저해; 그럴것가진 없는데"
//   경로 A = FINAL_FENCE 를 운영에 걸지 않고, F-1 수정 + reset + 001~009 배포.
//
// fence 를 빼는 근거 (추측이 아니라 실측)
//   001~009 자체가 이미 PUBLIC EXECUTE 0 / anon EXECUTE 0 을 만든다.
//   fence 는 그 위에 덧씌우는 추가 회수였고, 003 이 RLS 평가용으로
//   authenticated 에게 준 authz 헬퍼 EXECUTE 까지 걷어내 dev 에서
//   39 프로브 중 27개가 권한 오류로 죽었다. 걸지 않는 것이 옳다.
//
// 단계
//   0. 권한·소스 identity
//   1. preflight (fresh)
//   2. TX_A  reset (스크립트 자체가 단일 트랜잭션 + fail-closed pre-check)
//   3. reset readback
//   4. TX_B  001~009 파생물을 하나의 트랜잭션에서 적용
//   5. 최종 readback (fence 없음)
//
// 실행: node scripts/manual/prod-deploy-a.mjs --execute
// 종료: 0 PASS / 2 권한 없음 / 3 차단 / 4 OUTCOME_UNKNOWN / 1 실행 실패
// ============================================================
import pg from "pg";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readProdEnv, assertProdUrl, PROD_REF, scrub } from "./prod-url.mjs";
import * as L from "./fence-v2-lib.mjs";
import * as O from "./observer-lib.mjs";

const HEAD_DIR = join(homedir(), "prod-runs", "TXB_BODY_RC1");
const TAIL_DIR = join(homedir(), "prod-runs", "TXB_TAIL_RC1");
const OUT = join(homedir(), "prod-runs", "PROD_DEPLOY_A");
const HEAD = ["001_schemas_roles", "002_foundation", "003_functions_triggers",
              "004_admin_batch_functions", "005_schedules"];
const TAIL = ["006_storage_policies", "007_soft_delete_rpc",
              "008_harden_private_exec", "009_server_job_rpcs"];
const RESET_SQL = join(process.cwd(), "scripts/manual/prod-reset-community.sql");
const RESET_SHA = "4b0ab5d8747d907de143b49abcf50d5f82671e5697eba28675981de147221739";
const SENTINEL = "prod-deploy-a-txb";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(46)} ${v}`);
const fails = [];
const rec = (n, ok, d) => { if (!ok) fails.push(n); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

if (!process.argv.includes("--execute")) {
  console.error("[중단] 운영 배포다. --execute 를 명시하라.");
  process.exit(2);
}

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  mkdirSync(OUT, { recursive: true });
  const receipt = { path: "A_NO_FENCE", started_at_utc: new Date().toISOString(), steps: {} };

  head("0. 소스 identity (DB 접속 전)");
  const resetBuf = readFileSync(RESET_SQL);
  rec("reset 스크립트 해시 = 승인값", sha256(resetBuf) === RESET_SHA, sha256(resetBuf).slice(0, 24) + "…");
  const derivs = [];
  for (const [dir, list] of [[HEAD_DIR, HEAD], [TAIL_DIR, TAIL]]) {
    const dm = JSON.parse(readFileSync(join(dir, "DERIVATION_MANIFEST.json"), "utf8"));
    for (const m of list) {
      const buf = readFileSync(join(dir, `${m}.body.sql`));
      const ok = sha256(buf) === dm.files[m].derivative.sha256;
      rec(`파생물 ${m}`, ok);
      const orig = readFileSync(join(process.cwd(), `supabase/migrations/${m}.sql`));
      rec(`동결 원본 ${m} 무변경`, sha256(orig) === dm.files[m].original.sha256);
      derivs.push({ name: m, sql: buf.toString("utf8"), sha256: sha256(buf) });
    }
  }
  if (fails.length) { console.error("\n⛔ SOURCE_IDENTITY_MISMATCH — 중단"); return 3; }
  receipt.steps.source_identity = { reset_sha256: sha256(resetBuf), derivatives: derivs.map((d) => ({ name: d.name, sha256: d.sha256 })) };

  await client.connect();
  const q = async (s, p = []) => (await client.query(s, p)).rows;
  const g = async (s, p = []) => (await q(s, p))[0];

  head("1. preflight (fresh 측정)");
  const info = await g(`select current_database() db, current_user usr`);
  line("database / user", `${info.db} / ${info.usr}`);
  line("target ref", PROD_REF);
  const writers = Number((await g(`select count(*) v from pg_stat_activity
    where datname=current_database() and pid<>pg_backend_pid() and state='active'
      and query ~* '^\\s*(insert|update|delete|truncate|alter|drop|create|grant|revoke)'`)).v);
  const prepared = Number((await g(`select count(*) v from pg_prepared_xacts`)).v);
  const blocking = Number((await g(`select count(*) v from pg_locks where not granted`)).v);
  const authBefore = Number((await g(`select count(*) v from auth.users`)).v);
  const objBefore = Number((await g(`select count(*) v from storage.objects`)).v);
  rec("active writer 0", writers === 0, String(writers));
  rec("prepared transaction 0", prepared === 0, String(prepared));
  rec("blocking lock 0", blocking === 0, String(blocking));
  line("auth.users (보존 대상)", authBefore);
  line("storage.objects (보존 대상)", objBefore);
  if (fails.length) { console.error("\n⛔ PREFLIGHT_BLOCKED"); return 3; }
  receipt.steps.preflight = { writers, prepared, blocking, auth_users_before: authBefore, storage_objects_before: objBefore };

  head("2. TX_A — reset 실행");
  console.log("  스크립트가 자체 트랜잭션이며 pre-check 가 전부 fail-closed 다.");
  console.log("  auth.users 수가 바뀌면 스크립트 스스로 예외를 던져 롤백된다.");
  let outcome = "NOT_STARTED";
  try {
    await client.query(resetBuf.toString("utf8"));
    outcome = "RESET_COMMITTED";
    line("reset", "완료");
  } catch (e) {
    const msg = scrub(e.message || String(e), url);
    if (/connection|terminat|ECONNRESET|socket/i.test(msg)) {
      console.error(`\n⛔ 연결 유실: ${msg.slice(0, 200)}`);
      console.error("PROD_DEPLOY_OUTCOME=UNKNOWN / 자동 재시도 금지");
      return 4;
    }
    console.error(`\n⛔ reset 실패(스크립트가 롤백함): ${msg.slice(0, 400)}`);
    return 3;
  }

  head("3. reset readback");
  const authAfter = Number((await g(`select count(*) v from auth.users`)).v);
  const objAfter = Number((await g(`select count(*) v from storage.objects`)).v);
  rec("auth.users 불변", authAfter === authBefore, `${authBefore} → ${authAfter}`);
  rec("storage.objects 불변", objAfter === objBefore, `${objBefore} → ${objAfter}`);
  const leftSchemas = (await q(`select nspname from pg_namespace where nspname in ('private','authz')`)).map((r) => r.nspname);
  rec("private·authz 스키마 제거됨", leftSchemas.length === 0, leftSchemas.join(", ") || "없음");
  const leftTables = Number((await g(`select count(*) v from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p')`)).v);
  line("public 잔존 테이블", leftTables);
  if (fails.length) { console.error("\n⛔ RESET_READBACK_FAILED"); return 3; }
  receipt.steps.reset = { outcome, auth_users_after: authAfter, storage_objects_after: objAfter, public_tables_after: leftTables };

  head("4. TX_B — 001~009 단일 트랜잭션 적용");
  await client.query("begin");
  await client.query(`set local lock_timeout='10s'`);
  await client.query(`set local statement_timeout='900s'`);
  await client.query(`set local application_name = '${SENTINEL}'`);
  const xid0 = (await q(`select pg_current_xact_id()::text x`))[0].x;
  line("top-level xid", xid0);
  try {
    for (const d of derivs) {
      await client.query(d.sql);
      const st = (await q(`select current_setting('application_name') a, pg_current_xact_id()::text x`))[0];
      rec(`${d.name} + 트랜잭션 연속성`, st.a === SENTINEL && st.x === xid0, `xid ${st.x}`);
    }
    if (fails.length) { await client.query("rollback"); console.error("\n⛔ 연속성 실패 — ROLLBACK"); return 3; }
    await client.query("commit");
    line("COMMIT", "완료");
    outcome = "MIGRATIONS_COMMITTED";
  } catch (e) {
    const msg = scrub(e.message || String(e), url);
    if (/connection|terminat|ECONNRESET|socket/i.test(msg)) {
      console.error(`\n⛔ 연결 유실: ${msg.slice(0, 200)}`);
      console.error("PROD_DEPLOY_OUTCOME=UNKNOWN / 자동 재시도 금지");
      return 4;
    }
    try { await client.query("rollback"); } catch {}
    console.error(`\n⛔ 마이그레이션 실패(ROLLBACK): ${msg.slice(0, 500)}`);
    return 3;
  }

  head("5. 최종 readback (fence 미적용)");
  const schemas = (await L.projectSchemas(client)).map((s) => s.schema);
  const inv = await L.inventory(client, schemas);
  line("스키마", schemas.join(", "));
  line("relation / sequence / routine", `${inv.relations.length} / ${inv.sequences.length} / ${inv.routines.length}`);
  L.resetProbeStats();
  const eff = await L.effectiveVector(client, inv);
  const ps = { ...L.probeStats };
  const execBy = (role) => Object.entries(eff).filter(([k, v]) =>
    v === true && k.startsWith("fn|") && k.split("|")[1] === role).length;
  line("routine EXECUTE — anon", execBy("anon"));
  line("routine EXECUTE — authenticated", execBy("authenticated"));
  line("routine EXECUTE — service_role", execBy("service_role"));
  rec("anon routine EXECUTE 0", execBy("anon") === 0, String(execBy("anon")));
  rec("authenticated routine EXECUTE > 0 (RLS 헬퍼 살아있음)", execBy("authenticated") > 0, String(execBy("authenticated")));
  const pol = Number((await g(`select count(*) v from pg_policies where schemaname='public'`)).v);
  line("public RLS 정책", pol);
  const rlsOff = (await q(`select n.nspname||'.'||c.relname t from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity`)).map((r) => r.t);
  rec("public 테이블 RLS 전부 활성", rlsOff.length === 0, rlsOff.join(", ") || "0");
  rec("probe unclassified 0", ps.unclassified === 0, String(ps.unclassified));
  const authFinal = Number((await g(`select count(*) v from auth.users`)).v);
  rec("auth.users 최종 불변", authFinal === authBefore, `${authBefore} → ${authFinal}`);

  receipt.steps.final = {
    schemas, relations: inv.relations.length, sequences: inv.sequences.length,
    routines: inv.routines.length, policies: pol,
    execute_anon: execBy("anon"), execute_authenticated: execBy("authenticated"),
    execute_service_role: execBy("service_role"),
    fence_applied: false, auth_users: authFinal,
  };
  receipt.outcome = fails.length ? "FAIL" : "PASS";
  receipt.finished_at_utc = new Date().toISOString();
  const buf = Buffer.from(JSON.stringify(receipt, null, 2));
  writeFileSync(join(OUT, "PROD_DEPLOY_A_RECEIPT.json"), buf);

  head("판정");
  console.log(`\nPROD_DEPLOY_A=${fails.length ? "FAIL" : "PASS"}`);
  console.log(`RESET_EXECUTED=YES`);
  console.log(`MIGRATIONS_EXECUTED=001~009`);
  console.log(`FENCE_APPLIED=NO (경로 A)`);
  console.log(`SHA256=${sha256(buf)}`);
  console.log(`OUT=${join(OUT, "PROD_DEPLOY_A_RECEIPT.json")}`);
  if (fails.length) for (const f of fails) console.log(`  · ${f}`);
  return fails.length ? 3 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await client.end(); } catch {} }
process.exit(code);
