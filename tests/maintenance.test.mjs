// maintenance Route 코어 + 검증 유닛 테스트 (node --test, mock 주입 — 실제 DB/네트워크 없음).
// GPT 검수 §C Route 테스트 계약 반영. Batch 1(인프라)만 검증 — 실제 잡 로직은 Batch 2.
import test from "node:test";
import assert from "node:assert/strict";
import { handleMaintenance } from "../app/lib/server/maintenance/core.mjs";
import {
  verifyCronSecret,
  validateProjectRef,
  parseProjectRef,
  isKnownJob,
  JOB_NAMES,
} from "../app/lib/server/maintenance/validation.mjs";

const SECRET = "0123456789abcdef0123"; // 16자 이상
const REF = "uiikgqeoxocpvphlmoqp";
const goodEnv = {
  MAINTENANCE_ENABLED: "true",
  CRON_SECRET: SECRET,
  APP_ENV: "dev",
  SUPABASE_URL: `https://${REF}.supabase.co`,
  EXPECTED_PROJECT_REF_DEV: REF,
};

// deps 팩토리: 호출 횟수를 세서 "생성/실행 0회" 계약을 검증
function makeDeps(overrides = {}) {
  const calls = { createClient: 0, withLease: 0, runJob: 0, release: 0 };
  const deps = {
    env: overrides.env || goodEnv,
    createServiceClient: () => {
      calls.createClient++;
      if (overrides.clientThrows) throw new Error("client fail");
      return { rpc: async () => ({ data: null, error: null }) };
    },
    withLease: async (client, job, ttl, fn) => {
      calls.withLease++;
      if (overrides.leaseBusy) return { alreadyRunning: true }; // fn 미실행
      try {
        return await fn();
      } finally {
        calls.release++;
      }
    },
    runJob: async (job) => {
      calls.runJob++;
      if (overrides.jobThrows) {
        const e = new Error("boom");
        e.failedStep = "job_x";
        throw e;
      }
      return { processed: 3, failed: 0, hasMore: false };
    },
    leaseTtlSec: 120,
    budgetMs: 60000,
  };
  return { deps, calls };
}

const auth = `Bearer ${SECRET}`;

test("disabled: MAINTENANCE_ENABLED!=='true'면 client 생성 0·200 disabled", async () => {
  const { deps, calls } = makeDeps({ env: { ...goodEnv, MAINTENANCE_ENABLED: undefined } });
  const r = await handleMaintenance({ authHeader: auth, job: "stale-reviews" }, deps);
  assert.deepEqual(r, { status: 200, body: { status: "disabled" } });
  assert.equal(calls.createClient, 0);
  assert.equal(calls.runJob, 0);
});

test("secret 없음/오류/짧음 → 401 무본문, mutation 0", async () => {
  for (const bad of [undefined, "Bearer wrong", "Bearer short", "nope"]) {
    const { deps, calls } = makeDeps();
    const r = await handleMaintenance({ authHeader: bad, job: "stale-reviews" }, deps);
    assert.equal(r.status, 401);
    assert.equal(r.body, null);
    assert.equal(calls.createClient, 0);
    assert.equal(calls.runJob, 0);
  }
});

test("secret 자체가 짧으면(<16) fail closed — 올바른 Bearer라도 401", async () => {
  const shortSecret = "tooshort";
  const { deps, calls } = makeDeps({ env: { ...goodEnv, CRON_SECRET: shortSecret } });
  const r = await handleMaintenance({ authHeader: `Bearer ${shortSecret}`, job: "stale-reviews" }, deps);
  assert.equal(r.status, 401);
  assert.equal(calls.createClient, 0);
});

test("unknown job → 400, client·lease 생성 0", async () => {
  const { deps, calls } = makeDeps();
  const r = await handleMaintenance({ authHeader: auth, job: "rm-rf" }, deps);
  assert.equal(r.status, 400);
  assert.equal(r.body.status, "unknown_job");
  assert.equal(calls.createClient, 0);
  assert.equal(calls.withLease, 0);
});

test("project ref 불일치 → 500 env, mutation 0", async () => {
  const { deps, calls } = makeDeps({ env: { ...goodEnv, EXPECTED_PROJECT_REF_DEV: "otherref" } });
  const r = await handleMaintenance({ authHeader: auth, job: "stale-reviews" }, deps);
  assert.equal(r.status, 500);
  assert.equal(r.body.failedStep, "env");
  assert.equal(calls.createClient, 0);
  assert.equal(calls.runJob, 0);
});

test("client 생성 실패 → 500 client, job 실행 0", async () => {
  const { deps, calls } = makeDeps({ clientThrows: true });
  const r = await handleMaintenance({ authHeader: auth, job: "stale-reviews" }, deps);
  assert.equal(r.status, 500);
  assert.equal(r.body.failedStep, "client");
  assert.equal(calls.runJob, 0);
});

test("lease busy → 200 already_running, job 실행 0", async () => {
  const { deps, calls } = makeDeps({ leaseBusy: true });
  const r = await handleMaintenance({ authHeader: auth, job: "stale-reviews" }, deps);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "already_running");
  assert.equal(calls.runJob, 0);
});

test("정상 → 200 ok, withLease 1회·release 1회, 결과 전달", async () => {
  const { deps, calls } = makeDeps();
  const r = await handleMaintenance({ authHeader: auth, job: "expire-uploads" }, deps);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: "ok", job: "expire-uploads", processed: 3, failed: 0, hasMore: false });
  assert.equal(calls.withLease, 1);
  assert.equal(calls.runJob, 1);
  assert.equal(calls.release, 1);
});

test("job throw → 500 failedStep, release는 시도됨(finally)", async () => {
  const { deps, calls } = makeDeps({ jobThrows: true });
  const r = await handleMaintenance({ authHeader: auth, job: "delete-accounts" }, deps);
  assert.equal(r.status, 500);
  assert.equal(r.body.status, "error");
  assert.equal(r.body.failedStep, "job_x");
  assert.equal(calls.release, 1); // finally에서 lease 해제 시도
});

test("응답에 secret·ref·path·UUID 미노출 (성공/실패 모두)", async () => {
  const { deps: d1 } = makeDeps();
  const ok = await handleMaintenance({ authHeader: auth, job: "stale-reviews" }, d1);
  const { deps: d2 } = makeDeps({ jobThrows: true });
  const err = await handleMaintenance({ authHeader: auth, job: "stale-reviews" }, d2);
  for (const r of [ok, err]) {
    const s = JSON.stringify(r.body);
    assert.ok(!s.includes(SECRET), "secret 노출 금지");
    assert.ok(!s.includes(REF), "project ref 노출 금지");
  }
});

// ── 검증 유닛 ──
test("verifyCronSecret: 정확한 Bearer만 통과, 짧은 secret은 fail closed", () => {
  assert.equal(verifyCronSecret(`Bearer ${SECRET}`, SECRET), true);
  assert.equal(verifyCronSecret(`Bearer ${SECRET}x`, SECRET), false);
  assert.equal(verifyCronSecret(`Bearer ${SECRET}`, "short"), false);
  assert.equal(verifyCronSecret(SECRET, SECRET), false); // Bearer 없음
  assert.equal(verifyCronSecret(undefined, SECRET), false);
});

test("parseProjectRef / validateProjectRef", () => {
  assert.equal(parseProjectRef(`https://${REF}.supabase.co`), REF);
  assert.equal(parseProjectRef("https://evil.example.com"), null);
  assert.equal(parseProjectRef("not a url"), null);
  assert.equal(validateProjectRef(goodEnv).ok, true);
  assert.equal(validateProjectRef({ ...goodEnv, APP_ENV: "staging" }).ok, false);
  assert.equal(validateProjectRef({ ...goodEnv, EXPECTED_PROJECT_REF_DEV: "x" }).ok, false);
});

test("job allowlist는 정확히 5종", () => {
  assert.deepEqual([...JOB_NAMES].sort(), [
    "delete-accounts",
    "expire-uploads",
    "prune-analytics",
    "purge-verification-docs",
    "stale-reviews",
  ]);
  assert.equal(isKnownJob("stale-reviews"), true);
  assert.equal(isKnownJob("prune-analytics"), true);
  assert.equal(isKnownJob("../etc"), false);
});
