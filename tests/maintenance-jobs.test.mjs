// Batch 2A 잡(stale-reviews·expire-uploads) + storage/rpc 헬퍼 + registry mock 테스트.
// GPT §2A 검수기준: fail-closed·집계정확·단계실패 처리·성공시만 mark·경로안전·비노출·수렴.
import test from "node:test";
import assert from "node:assert/strict";
import { staleReviews } from "../app/lib/server/maintenance/jobs/staleReviews.mjs";
import { expireUploads } from "../app/lib/server/maintenance/jobs/expireUploads.mjs";
import { isSafeObjectPath, makeStorageRemover } from "../app/lib/server/maintenance/storage.mjs";
import { runJob } from "../app/lib/server/maintenance/jobs/registry.mjs";

const budgetFull = { canStartMore: () => true };
const budgetDone = { canStartMore: () => false };

// rpcImpl(name, args, callIndexForName) → { data, error }
function mockClient(rpcImpl, storageImpl) {
  const calls = [];
  const perName = {};
  return {
    calls,
    rpc: async (name, args) => {
      perName[name] = (perName[name] || 0) + 1;
      calls.push({ name, args });
      return rpcImpl ? rpcImpl(name, args, perName[name]) : { data: null, error: null };
    },
    storage: {
      from: (bucket) => ({
        remove: async (paths) => (storageImpl ? storageImpl(bucket, paths) : { data: [], error: null }),
      }),
    },
  };
}
const only = (calls, name) => calls.filter((c) => c.name === name);

/* ---------- stale-reviews ---------- */
test("stale: 대상 0건 → processed 0, hasMore false", async () => {
  const client = mockClient((name) => ({ data: 0, error: null }));
  const r = await staleReviews({ client, budget: budgetFull });
  assert.deepEqual(r, { processed: 0, failed: 0, hasMore: false });
});

test("stale: 단일 페이지(알림+만료 집계)", async () => {
  const client = mockClient((name) => ({ data: name === "run_stale_review_notifications" ? 2 : 1, error: null }));
  const r = await staleReviews({ client, budget: budgetFull, limit: 200 });
  assert.deepEqual(r, { processed: 3, failed: 0, hasMore: false });
  assert.equal(only(client.calls, "run_stale_review_notifications").length, 1);
  assert.equal(only(client.calls, "expire_unreviewed_submissions").length, 1);
});

test("stale: 복수 페이지 루프(budget 여유) — 마지막이 limit 미만이면 종료", async () => {
  // name별 호출횟수 i 추적: iter1 notify=2·expire=2(각 =limit) → hasMore, 루프.
  //                        iter2 notify=0·expire=0 → hasMore false, 종료.
  const client = mockClient((name, args, i) => ({ data: i === 1 ? 2 : 0, error: null }));
  const r = await staleReviews({ client, budget: budgetFull, limit: 2 });
  assert.equal(r.processed, 4); // iter1: 2 + 2
  assert.equal(r.hasMore, false);
  assert.equal(only(client.calls, "run_stale_review_notifications").length, 2); // 2회 반복
});

test("stale: notify RPC 실패 → failedStep notify, expire 미호출", async () => {
  const client = mockClient((name) =>
    name === "run_stale_review_notifications" ? { data: null, error: { message: "x" } } : { data: 0, error: null }
  );
  await assert.rejects(() => staleReviews({ client, budget: budgetFull }), (e) => e.failedStep === "notify");
  assert.equal(only(client.calls, "expire_unreviewed_submissions").length, 0);
});

test("stale: expire RPC 실패 → failedStep expire_unreviewed", async () => {
  const client = mockClient((name) =>
    name === "expire_unreviewed_submissions" ? { data: null, error: { message: "x" } } : { data: 0, error: null }
  );
  await assert.rejects(() => staleReviews({ client, budget: budgetFull }), (e) => e.failedStep === "expire_unreviewed");
});

test("stale: RPC 응답 형태 이상(비정수) → fail-closed", async () => {
  const client = mockClient(() => ({ data: "lots", error: null }));
  await assert.rejects(() => staleReviews({ client, budget: budgetFull }), (e) => e.failedStep === "notify");
});

test("stale: 시간예산 도달 → 1페이지 후 중단, hasMore 유지", async () => {
  const client = mockClient((name) => ({ data: 2, error: null })); // 항상 full(=limit2)
  const r = await staleReviews({ client, budget: budgetDone, limit: 2 });
  assert.equal(r.hasMore, true);
  assert.equal(only(client.calls, "run_stale_review_notifications").length, 1); // 루프 미반복
});

/* ---------- expire-uploads ---------- */
const okStorage = () => ({ data: [{}], error: null });
const failStorage = () => ({ data: null, error: { message: "boom" } });

test("expire: 대상 0건 → processed·failed 0", async () => {
  const client = mockClient((name) => (name === "claim_expired_uploads" ? { data: [], error: null } : { data: null, error: null }), okStorage);
  const r = await expireUploads({ client, budget: budgetFull, storage: makeStorageRemover(client, "verification-docs") });
  assert.deepEqual(r, { processed: 0, failed: 0, hasMore: false });
});

test("expire: Storage 성공 → mark 호출, processed 1", async () => {
  const client = mockClient(
    (name, args, i) => (name === "claim_expired_uploads" ? { data: i === 1 ? [{ req_id: 1, storage_path: "uuid/x1" }] : [], error: null } : { data: null, error: null }),
    okStorage
  );
  const r = await expireUploads({ client, budget: budgetFull, storage: makeStorageRemover(client, "verification-docs"), limit: 50 });
  assert.equal(r.processed, 1);
  assert.equal(r.failed, 0);
  assert.equal(only(client.calls, "mark_verification_doc_purged").length, 1);
});

test("expire: 일부 삭제 실패 → 성공은 mark, 실패는 record_failure", async () => {
  const client = mockClient(
    (name, args, i) => (name === "claim_expired_uploads" ? { data: i === 1 ? [{ req_id: 1, storage_path: "u/a" }, { req_id: 2, storage_path: "u/b" }] : [], error: null } : { data: null, error: null }),
    (bucket, paths) => (paths[0] === "u/b" ? failStorage() : okStorage())
  );
  const r = await expireUploads({ client, budget: budgetFull, storage: makeStorageRemover(client, "verification-docs") });
  assert.equal(r.processed, 1);
  assert.equal(r.failed, 1);
  assert.equal(only(client.calls, "mark_verification_doc_purged").length, 1);
  assert.equal(only(client.calls, "record_verification_purge_failure").length, 1);
});

test("expire: 성공 마킹 RPC 실패 → 그 행만 failed, 다음 행 계속", async () => {
  const client = mockClient(
    (name, args, i) => {
      if (name === "claim_expired_uploads") return { data: i === 1 ? [{ req_id: 1, storage_path: "u/a" }] : [], error: null };
      if (name === "mark_verification_doc_purged") return { data: null, error: { message: "mark fail" } };
      return { data: null, error: null };
    },
    okStorage
  );
  const r = await expireUploads({ client, budget: budgetFull, storage: makeStorageRemover(client, "verification-docs") });
  assert.equal(r.processed, 0);
  assert.equal(r.failed, 1);
});

test("expire: 실패 기록 RPC 실패 → 그 행 failed, 계속", async () => {
  const client = mockClient(
    (name, args, i) => {
      if (name === "claim_expired_uploads") return { data: i === 1 ? [{ req_id: 1, storage_path: "u/a" }] : [], error: null };
      if (name === "record_verification_purge_failure") return { data: null, error: { message: "rec fail" } };
      return { data: null, error: null };
    },
    failStorage
  );
  const r = await expireUploads({ client, budget: budgetFull, storage: makeStorageRemover(client, "verification-docs") });
  assert.equal(r.failed, 1);
  assert.equal(r.processed, 0);
});

test("expire: claim RPC 이상(배열 아님) → fail-closed claim", async () => {
  const client = mockClient((name) => (name === "claim_expired_uploads" ? { data: { nope: 1 }, error: null } : { data: null, error: null }), okStorage);
  await assert.rejects(
    () => expireUploads({ client, budget: budgetFull, storage: makeStorageRemover(client, "verification-docs") }),
    (e) => e.failedStep === "claim"
  );
});

test("expire: 시간예산 도달 → 1페이지 후 중단, hasMore true", async () => {
  const client = mockClient(
    (name) => (name === "claim_expired_uploads" ? { data: [{ req_id: 1, storage_path: "u/a" }, { req_id: 2, storage_path: "u/b" }], error: null } : { data: null, error: null }),
    okStorage
  );
  const r = await expireUploads({ client, budget: budgetDone, storage: makeStorageRemover(client, "verification-docs"), limit: 2 });
  assert.equal(r.hasMore, true);
  assert.equal(only(client.calls, "claim_expired_uploads").length, 1);
});

test("expire: 비정상 경로(..)는 서버에서 재검사 → 삭제 안 하고 record_failure(unsafe_path)", async () => {
  const client = mockClient(
    (name, args, i) => (name === "claim_expired_uploads" ? { data: i === 1 ? [{ req_id: 9, storage_path: "../etc/passwd" }] : [], error: null } : { data: null, error: null }),
    okStorage
  );
  const r = await expireUploads({ client, budget: budgetFull, storage: makeStorageRemover(client, "verification-docs") });
  assert.equal(r.failed, 1);
  const rec = only(client.calls, "record_verification_purge_failure");
  assert.equal(rec.length, 1);
  assert.equal(rec[0].args.p_error_code, "unsafe_path");
});

test("결과에 path·UUID 미노출 (숫자 3필드만)", async () => {
  const client = mockClient(
    (name, args, i) => (name === "claim_expired_uploads" ? { data: i === 1 ? [{ req_id: 1, storage_path: "uuid-secret/x" }] : [], error: null } : { data: null, error: null }),
    okStorage
  );
  const r = await expireUploads({ client, budget: budgetFull, storage: makeStorageRemover(client, "verification-docs") });
  assert.deepEqual(Object.keys(r).sort(), ["failed", "hasMore", "processed"]);
  assert.ok(!JSON.stringify(r).includes("uuid-secret"));
});

/* ---------- storage / path 안전성 ---------- */
test("isSafeObjectPath", () => {
  assert.equal(isSafeObjectPath("uuid/x1"), true);
  assert.equal(isSafeObjectPath("../etc"), false);
  assert.equal(isSafeObjectPath("/abs"), false);
  assert.equal(isSafeObjectPath(""), false);
  assert.equal(isSafeObjectPath("a\\b"), false);
  assert.equal(isSafeObjectPath(null), false);
});

/* ---------- registry: batch_runs 기록 ---------- */
test("registry: 성공 → 핸들러 실행 + record_maintenance_run(ok=true, processed)", async () => {
  const client = mockClient((name) => {
    if (name === "run_stale_review_notifications") return { data: 2, error: null };
    if (name === "expire_unreviewed_submissions") return { data: 0, error: null };
    return { data: null, error: null };
  });
  const r = await runJob("stale-reviews", { client, budgetMs: 60000 });
  assert.equal(r.processed, 2);
  const rec = only(client.calls, "record_maintenance_run");
  assert.equal(rec.length, 1);
  assert.equal(rec[0].args.p_ok, true);
  assert.equal(rec[0].args.p_processed, 2);
  assert.equal(rec[0].args.p_error_code, null);
});

test("registry: HANDLERS에 없는 job → not_implemented throw", async () => {
  const client = mockClient();
  await assert.rejects(() => runJob("nonexistent-job", { client, budgetMs: 60000 }), (e) => e.failedStep === "not_implemented");
});

test("registry: 잡 실패 → record(ok=false, 안전코드) 후 원 오류 재던짐", async () => {
  const client = mockClient((name) =>
    name === "run_stale_review_notifications" ? { data: null, error: { message: "x" } } : { data: null, error: null }
  );
  await assert.rejects(() => runJob("stale-reviews", { client, budgetMs: 60000 }), (e) => e.failedStep === "notify");
  const rec = only(client.calls, "record_maintenance_run");
  assert.equal(rec.length, 1);
  assert.equal(rec[0].args.p_ok, false);
  assert.equal(rec[0].args.p_error_code, "notify");
});

// (구 동작 "record 실패해도 성공 반환"은 GPT 2A 보완으로 폐기 — 이제 성공+기록실패는
//  maintenance_record로 표면화된다. 해당 계약은 maintenance-2b.test.mjs가 검증.)
