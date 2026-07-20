// P0-7: maintenance Route↔dev 실제 E2E (dev 전용, 로컬).
// route.js는 handleMaintenance의 얇은 HTTP 어댑터이므로, 실제 dev 서비스클라이언트를 주입해
// handleMaintenance를 직접 호출하면 auth 순서·disabled 게이트·secret·job·ref·lease·실제 RPC·
// batch_runs·release까지 전부 실측된다(HTTP status = 반환 status). 12 시나리오.
// 값(SUPABASE_SECRET_KEY·DEV_DB_URL)은 .env.dev.local에서만, 화면·로그 비출력.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { handleMaintenance } from "../../app/lib/server/maintenance/core.mjs";
import { createServiceClient } from "../../app/lib/server/maintenance/serviceClient.mjs";
import { withLease } from "../../app/lib/server/maintenance/lease.mjs";
import { runJob } from "../../app/lib/server/maintenance/jobs/registry.mjs";
import { LEASE_TTL_SEC, BUDGET_MS } from "../../app/lib/server/maintenance/config.mjs";

const DEV_REF = "uiikgqeoxocpvphlmoqp", PROD_REF = "jclwkvxbvsegmbcnptpi";
function envFile() {
  const raw = readFileSync(resolve(process.cwd(), ".env.dev.local"), "utf8");
  const get = (k) => (raw.match(new RegExp("^\\s*" + k + "\\s*=\\s*(.+)\\s*$", "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "");
  return { secret: get("SUPABASE_SECRET_KEY"), dbUrl: get("DEV_DB_URL") };
}
const { secret, dbUrl } = envFile();
if (!secret) throw new Error("SUPABASE_SECRET_KEY 없음");
if (!dbUrl || !dbUrl.includes(DEV_REF) || dbUrl.includes(PROD_REF)) throw new Error("DEV_DB_URL 대상 오류");

const SUPABASE_URL = `https://${DEV_REF}.supabase.co`;
const CRON = randomBytes(24).toString("hex");
const baseEnv = {
  SUPABASE_URL, SUPABASE_SECRET_KEY: secret, APP_ENV: "dev",
  EXPECTED_PROJECT_REF_DEV: DEV_REF, CRON_SECRET: CRON, MAINTENANCE_ENABLED: "true",
};
const deps = (env) => ({ env, createServiceClient, withLease, runJob, leaseTtlSec: LEASE_TTL_SEC, budgetMs: BUDGET_MS });
const AUTH = "Bearer " + CRON;
const JOBS = ["purge-verification-docs", "delete-accounts", "expire-uploads", "stale-reviews"];

const db = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
const q = async (sql) => (await db.query(sql)).rows[0];
// 응답 본문에 민감정보(UUID/path/secret/DB URL/HMAC 흔적)가 없는지
function bodyClean(body) {
  const s = JSON.stringify(body || {});
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(s)) return false; // uuid
  if (s.includes(secret) || s.includes(SUPABASE_URL) || /\//.test(s.replace(/https?:/g, ""))) {
    // path 슬래시(스킴 제외) 존재 시 의심 — 정상 응답엔 없음
    if (/[a-z0-9_]+\/[a-z0-9_]/i.test(s)) return false;
  }
  return true;
}

const results = [];
const rec = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${detail || ""}`); };

async function main() {
  await db.connect();
  // 사전: lease 잔존 정리(이전 실측 잔재)
  await db.query("delete from private.maintenance_leases");
  const t0 = (await q("select now() as t")).t;  // batch_runs는 job별 upsert(1행/job) — 갱신 시각으로 판정

  // (1) disabled
  let r = await handleMaintenance({ authHeader: AUTH, job: "stale-reviews" }, deps({ ...baseEnv, MAINTENANCE_ENABLED: "false" }));
  const leaseAfter1 = (await q("select count(*)::int n from private.maintenance_leases")).n;
  rec("S1-disabled", r.status === 200 && r.body?.status === "disabled" && leaseAfter1 === 0, `status=${r.status} lease=${leaseAfter1}`);

  // (2a) secret 누락
  r = await handleMaintenance({ authHeader: undefined, job: "stale-reviews" }, deps(baseEnv));
  rec("S2a-no-secret-401", r.status === 401 && r.body === null, `status=${r.status}`);
  // (2b) secret 오류
  r = await handleMaintenance({ authHeader: "Bearer wrongwrongwrongwrong", job: "stale-reviews" }, deps(baseEnv));
  const leaseAfter2 = (await q("select count(*)::int n from private.maintenance_leases")).n;
  rec("S2b-wrong-secret-401", r.status === 401 && r.body === null && leaseAfter2 === 0, `status=${r.status} lease=${leaseAfter2}`);

  // (3) unknown job
  r = await handleMaintenance({ authHeader: AUTH, job: "bogus-job" }, deps(baseEnv));
  rec("S3-unknown-job-400", r.status === 400 && r.body?.status === "unknown_job", `status=${r.status}`);

  // (4) ref 불일치
  r = await handleMaintenance({ authHeader: AUTH, job: "stale-reviews" }, deps({ ...baseEnv, EXPECTED_PROJECT_REF_DEV: "wrongref000000000000" }));
  const leaseAfter4 = (await q("select count(*)::int n from private.maintenance_leases")).n;
  rec("S4-ref-mismatch-500", r.status === 500 && r.body?.failedStep === "env" && leaseAfter4 === 0, `status=${r.status} step=${r.body?.failedStep}`);

  // (5) 정상 + (7) 4 job 각각 실제 dev 호출
  let allJobsOk = true, allClean = true;
  for (const job of JOBS) {
    r = await handleMaintenance({ authHeader: AUTH, job }, deps(baseEnv));
    const ok = r.status === 200 && (r.body?.status === "ok");
    if (!ok) allJobsOk = false;
    if (!bodyClean(r.body)) allClean = false;
    rec(`S7-job-${job}`, ok, `status=${r.status} body=${JSON.stringify(r.body)}`);
  }
  const jobsArr = `'{${JOBS.join(",")}}'::text[]`;
  const updated = (await q(`select count(*)::int n from private.batch_runs
    where job_name = any(${jobsArr}) and last_run_at >= '${t0.toISOString()}'`)).n;
  rec("S5-batch-runs-recorded", updated === 4, `4 job의 batch_runs.last_run_at 갱신=${updated}/4`);

  // (6) 중복 요청 → already_running. lease는 job별 행이 영구 존재하고 release는 leased_until=null로
  //     비활성화(행 유지)하는 설계 → 활성 lease를 강제(upsert)한 뒤 호출.
  const token = "00000000-0000-0000-0000-0000000000ff";
  await db.query(`insert into private.maintenance_leases(job_name, lease_token, leased_until, started_at)
                  values ('stale-reviews','${token}', now()+interval '2 min', now())
                  on conflict (job_name) do update
                    set lease_token=excluded.lease_token, leased_until=excluded.leased_until, started_at=excluded.started_at`);
  r = await handleMaintenance({ authHeader: AUTH, job: "stale-reviews" }, deps(baseEnv));
  rec("S6-already-running", r.status === 200 && r.body?.status === "already_running", `status=${r.status} body=${JSON.stringify(r.body)}`);
  // 해제(설계대로 leased_until=null)
  await db.query("update private.maintenance_leases set lease_token=null, leased_until=null where job_name='stale-reviews'");

  // (10) 응답 민감정보 없음
  rec("S10-response-no-sensitive", allClean, "모든 job 응답 본문 비식별");

  // (11) 종료 후 활성 lease 잔존 0 (행은 job별로 남지만 leased_until 유효한 것이 없어야)
  const activeLease = (await q("select count(*)::int n from private.maintenance_leases where leased_until is not null and leased_until > now()")).n;
  rec("S11-no-active-lease", activeLease === 0, `active_lease=${activeLease}`);

  await db.end();
  const passed = results.filter((x) => x.pass).length, total = results.length;
  console.log(`\n=== P0-7 E2E: ${passed}/${total} PASS ===`);
  process.exit(passed === total ? 0 : 2);
}
main().catch((e) => { console.error("[fail] " + (e.message || e)); process.exit(1); });
