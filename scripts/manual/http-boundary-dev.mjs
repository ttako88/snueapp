// P0-7B: 실제 HTTP 경계 시험 — next start 서버를 127.0.0.1 임의포트에 띄워 app/api/maintenance/route.js를
// 진짜 HTTP로 시험(GET/POST·헤더·NextResponse·Cache-Control·405). .env.dev.local 값은 child env로만
// 전달·화면/로그 비출력. 운영 ref/key 감지 시 실행 전 중단. 종료 시 서버 프로세스 정리.
// 선행: npm run build (.next 필요).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import pg from "pg";
import { readDevEnv, assertDevUrl, DEV_SUPABASE_URL, DEV_REF, PROD_REF, scrub } from "./dev-url.mjs";

const { SUPABASE_SECRET_KEY: SECRET, DEV_DB_URL: DBURL } = readDevEnv(["SUPABASE_SECRET_KEY", "DEV_DB_URL"]);
if (!SECRET) throw new Error("SUPABASE_SECRET_KEY 없음");
assertDevUrl(DBURL, "DEV_DB_URL"); // dev 대상 확인(운영이면 중단)
const CRON = randomBytes(24).toString("hex");
const PORT = 3900 + Math.floor(Math.random() * 90);
const NEXT_BIN = resolve(process.cwd(), "node_modules/next/dist/bin/next");

const commonEnv = {
  SUPABASE_URL: DEV_SUPABASE_URL, SUPABASE_SECRET_KEY: SECRET, APP_ENV: "dev",
  EXPECTED_PROJECT_REF_DEV: DEV_REF, CRON_SECRET: CRON,
  NEXT_PUBLIC_SUPABASE_URL: DEV_SUPABASE_URL,
};
const results = [];
const rec = (n, pass, d) => { results.push({ n, pass }); console.log(`${pass ? "PASS" : "FAIL"}  ${n}  ${d || ""}`); };

function startServer(extraEnv) {
  return new Promise((res, rej) => {
    const logs = [];
    const proc = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(PORT), "-H", "127.0.0.1"],
      { env: { ...process.env, ...commonEnv, ...extraEnv }, cwd: process.cwd() });
    const onData = (b) => logs.push(b.toString());
    proc.stdout.on("data", onData); proc.stderr.on("data", onData);
    const t0 = Date.now();
    const poll = async () => {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.status) return res({ proc, logs }); } catch {}
      if (Date.now() - t0 > 60000) return rej(new Error("서버 기동 timeout"));
      setTimeout(poll, 500);
    };
    proc.on("error", rej);
    setTimeout(poll, 800);
  });
}
const stopServer = (s) => new Promise((r) => { s.proc.on("exit", () => r()); s.proc.kill("SIGTERM"); setTimeout(() => { try { s.proc.kill("SIGKILL"); } catch {} r(); }, 4000); });

const FORBID = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, // uuid
  /\b[0-9a-f]{64}\b/,           // 64-hex HMAC/토큰
  /sb_secret_/, /postgres(ql)?:\/\//i, new RegExp(DEV_REF), new RegExp(PROD_REF),
];
const hasForbidden = (s) => FORBID.some((re) => re.test(s || ""));
const ALLOWED_KEYS = new Set(["status", "job", "processed", "failed", "hasMore", "failedStep"]);

async function main() {
  const db = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  await db.query("update private.maintenance_leases set lease_token=null, leased_until=null"); // 활성 lease 정리
  let logBlobs = [];

  // ── Phase A: disabled (MAINTENANCE_ENABLED 미설정) ──
  let s = await startServer({ MAINTENANCE_ENABLED: "false" });
  try {
    let r = await fetch(`http://127.0.0.1:${PORT}/api/maintenance?job=stale-reviews`);
    let body = await r.text();
    rec("H1-disabled-GET-200", r.status === 200 && JSON.parse(body).status === "disabled" && r.headers.get("cache-control") === "no-store",
      `status=${r.status} cc=${r.headers.get("cache-control")}`);
    r = await fetch(`http://127.0.0.1:${PORT}/api/maintenance?job=stale-reviews`, { method: "POST" });
    rec("H2-disabled-POST-405", r.status === 405, `status=${r.status}`);
  } finally { logBlobs.push(s.logs.join("")); await stopServer(s); }

  // ── Phase B: enabled ──
  s = await startServer({ MAINTENANCE_ENABLED: "true" });
  let allBodiesClean = true, schemaOk = true;
  const checkBody = (body) => {
    if (hasForbidden(body)) allBodiesClean = false;
    try { const o = JSON.parse(body); if (o && typeof o === "object") for (const k of Object.keys(o)) if (!ALLOWED_KEYS.has(k)) schemaOk = false; } catch {}
  };
  try {
    let r = await fetch(`http://127.0.0.1:${PORT}/api/maintenance?job=stale-reviews`);
    rec("H3-enabled-no-auth-401", r.status === 401, `status=${r.status}`);
    r = await fetch(`http://127.0.0.1:${PORT}/api/maintenance?job=stale-reviews`, { headers: { Authorization: "Bearer wrongwrongwrongwrong" } });
    rec("H4-wrong-bearer-401", r.status === 401, `status=${r.status}`);
    r = await fetch(`http://127.0.0.1:${PORT}/api/maintenance?job=bogus`, { headers: { Authorization: "Bearer " + CRON } });
    let body = await r.text(); checkBody(body);
    rec("H5-unknown-job-400", r.status === 400 && JSON.parse(body).status === "unknown_job", `status=${r.status}`);
    r = await fetch(`http://127.0.0.1:${PORT}/api/maintenance?job=stale-reviews`, { headers: { Authorization: "Bearer " + CRON } });
    body = await r.text(); checkBody(body);
    rec("H6-normal-GET-200", r.status === 200 && JSON.parse(body).status === "ok", `status=${r.status} body=${body}`);
    // H7 already_running: 활성 lease 선점 후 호출
    await db.query(`insert into private.maintenance_leases(job_name,lease_token,leased_until,started_at)
      values ('stale-reviews','00000000-0000-0000-0000-0000000000ff', now()+interval '2 min', now())
      on conflict (job_name) do update set lease_token=excluded.lease_token, leased_until=excluded.leased_until, started_at=excluded.started_at`);
    r = await fetch(`http://127.0.0.1:${PORT}/api/maintenance?job=stale-reviews`, { headers: { Authorization: "Bearer " + CRON } });
    body = await r.text(); checkBody(body);
    rec("H7-already-running-200", r.status === 200 && JSON.parse(body).status === "already_running", `body=${body}`);
    await db.query("update private.maintenance_leases set lease_token=null, leased_until=null where job_name='stale-reviews'");
  } finally { logBlobs.push(s.logs.join("")); await stopServer(s); }

  // ── 응답 schema·서버 로그 금지값 ──
  rec("H8-response-schema-allowlist", schemaOk, "허용 키만");
  rec("H9-response-no-forbidden", allBodiesClean, "응답 본문 비식별");
  const allLogs = logBlobs.join("\n");
  const logClean = !hasForbidden(allLogs) && !allLogs.includes(SECRET) && !allLogs.includes(CRON);
  rec("H10-server-log-no-secret", logClean, "서버 로그에 secret/URL/UUID/path 없음");
  // 종료 후 활성 lease 0
  const active = (await db.query("select count(*)::int n from private.maintenance_leases where leased_until is not null and leased_until>now()")).rows[0].n;
  rec("H11-no-active-lease", active === 0, `active=${active}`);
  await db.end();

  const pass = results.filter((x) => x.pass).length, total = results.length;
  console.log(`\n=== P0-7B HTTP 경계: ${pass}/${total} PASS ===`);
  process.exit(pass === total ? 0 : 2);
}
main().catch((e) => { console.error("[fail] " + scrub(e.message || String(e), SECRET, CRON, DBURL)); process.exit(1); });
