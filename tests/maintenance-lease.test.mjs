// maintenance lease 래퍼 + config 불변식 + Route 어댑터 테스트 (GPT §C 보완).
import test from "node:test";
import assert from "node:assert/strict";
import { withLease } from "../app/lib/server/maintenance/lease.mjs";
import { MAX_DURATION_SEC, LEASE_TTL_SEC } from "../app/lib/server/maintenance/config.mjs";
// 참고: route.js는 next/server를 import하므로 node --test에서 직접 로드 불가.
//   Route의 GET/no-store/405 계약은 실행 중 dev 서버에 대한 HTTP 통합 확인으로 검증한다
//   (docs/drafts/gate4a/scripts/server-jobs/BATCH1_ROUTE_HTTP_CHECK.md).

function mockClient({ token = "tok", acquireError = null, releaseError = null } = {}) {
  const calls = { acquire: 0, release: 0 };
  const client = {
    rpc: async (name) => {
      if (name === "acquire_maintenance_lease") {
        calls.acquire++;
        return { data: token, error: acquireError };
      }
      if (name === "release_maintenance_lease") {
        calls.release++;
        return { data: null, error: releaseError };
      }
      return { data: null, error: null };
    },
  };
  return { client, calls };
}

test("withLease: acquire 실패 → lease_acquire throw, fn 미실행", async () => {
  const { client } = mockClient({ acquireError: { message: "x" } });
  let ran = false;
  await assert.rejects(
    () => withLease(client, "stale-reviews", 120, async () => { ran = true; }),
    (e) => e.failedStep === "lease_acquire"
  );
  assert.equal(ran, false);
});

test("withLease: token 없음(busy) → alreadyRunning, fn 미실행", async () => {
  const { client } = mockClient({ token: null });
  let ran = false;
  const r = await withLease(client, "stale-reviews", 120, async () => { ran = true; });
  assert.deepEqual(r, { alreadyRunning: true });
  assert.equal(ran, false);
});

test("withLease: 잡 성공 + release 성공 → 결과 반환, release 1회", async () => {
  const { client, calls } = mockClient();
  const r = await withLease(client, "stale-reviews", 120, async () => ({ processed: 2 }));
  assert.deepEqual(r, { processed: 2 });
  assert.equal(calls.release, 1);
});

test("withLease: 잡 성공 + release 실패 → lease_release throw (원문 오류 비노출)", async () => {
  const { client } = mockClient({ releaseError: { message: "secret detail" } });
  await assert.rejects(
    () => withLease(client, "stale-reviews", 120, async () => ({ processed: 1 })),
    (e) => e.failedStep === "lease_release" && !String(e.message).includes("secret detail")
  );
});

test("withLease: 잡 실패 + release 실패 → 원래 잡 실패 유지 + releaseFailed 내부 보존", async () => {
  const { client } = mockClient({ releaseError: { message: "y" } });
  await assert.rejects(
    () => withLease(client, "delete-accounts", 120, async () => {
      const e = new Error("job boom");
      e.failedStep = "job_step";
      throw e;
    }),
    (e) => e.failedStep === "job_step" && e.releaseFailed === true
  );
});

test("config 불변식: LEASE_TTL_SEC > MAX_DURATION_SEC", () => {
  assert.ok(LEASE_TTL_SEC > MAX_DURATION_SEC, "lease TTL은 함수 실행 상한보다 길어야");
});
