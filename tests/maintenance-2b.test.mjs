// Batch 2B(purge-verification-docs·delete-accounts) + Batch 2A 국소 보완 테스트.
import test from "node:test";
import assert from "node:assert/strict";
import { staleReviews } from "../app/lib/server/maintenance/jobs/staleReviews.mjs";
import { purgeVerificationDocs } from "../app/lib/server/maintenance/jobs/purgeVerificationDocs.mjs";
import { deleteAccounts } from "../app/lib/server/maintenance/jobs/deleteAccounts.mjs";
import { makeStorageRemover } from "../app/lib/server/maintenance/storage.mjs";
import { runJob } from "../app/lib/server/maintenance/jobs/registry.mjs";

const UUID = "00000000-0000-0000-0000-0000000000a3";
const UUID2 = "00000000-0000-0000-0000-0000000000b2";
const budgetFull = { canStartMore: () => true };
const budgetDone = { canStartMore: () => false };

function mkClient(handlers = {}, storageImpl) {
  const calls = [];
  const perName = {};
  const client = {
    calls,
    rpc: async (name, args) => {
      perName[name] = (perName[name] || 0) + 1;
      calls.push({ name, args });
      if (handlers[name]) return handlers[name](args, perName[name]);
      return { data: null, error: null };
    },
    storage: { from: () => ({ remove: async (paths) => (storageImpl ? storageImpl(paths) : { error: null }) }) },
  };
  return client;
}
const only = (calls, name) => calls.filter((c) => c.name === name);
const ok = () => ({ error: null });

/* ================= 2A 보완 1: registry 기록 실패 표면화 ================= */
test("registry: 작업 성공 + 기록 실패 → maintenance_record 표면화(throw)", async () => {
  const client = mkClient({
    run_stale_review_notifications: () => ({ data: 1, error: null }),
    expire_unreviewed_submissions: () => ({ data: 0, error: null }),
    record_maintenance_run: () => ({ data: null, error: { message: "rec down" } }),
  });
  await assert.rejects(() => runJob("stale-reviews", { client, budgetMs: 60000 }), (e) => e.failedStep === "maintenance_record");
});

test("registry: 작업 실패 + 기록 실패 → 원 failedStep 유지 + recordFailed 내부 플래그", async () => {
  const client = mkClient({
    run_stale_review_notifications: () => ({ data: null, error: { message: "x" } }),
    record_maintenance_run: () => ({ data: null, error: { message: "rec down" } }),
  });
  await assert.rejects(
    () => runJob("stale-reviews", { client, budgetMs: 60000 }),
    (e) => e.failedStep === "notify" && e.recordFailed === true
  );
});

/* ================= 2A 보완 2: stale 비대칭 페이지네이션 ================= */
test("stale: notify=limit, expire=0 → notify 다음 페이지 계속", async () => {
  const client = mkClient({
    run_stale_review_notifications: (a, i) => ({ data: i === 1 ? 2 : 0, error: null }),
    expire_unreviewed_submissions: () => ({ data: 0, error: null }),
  });
  const r = await staleReviews({ client, budget: budgetFull, limit: 2 });
  assert.equal(only(client.calls, "run_stale_review_notifications").length, 2); // 2페이지
  assert.equal(r.hasMore, false);
});

test("stale: notify=0, expire=limit → expire 다음 페이지 계속", async () => {
  const client = mkClient({
    run_stale_review_notifications: () => ({ data: 0, error: null }),
    expire_unreviewed_submissions: (a, i) => ({ data: i === 1 ? 2 : 0, error: null }),
  });
  const r = await staleReviews({ client, budget: budgetFull, limit: 2 });
  assert.equal(only(client.calls, "expire_unreviewed_submissions").length, 2); // 2페이지
  assert.equal(r.hasMore, false);
});

/* ================= purge-verification-docs ================= */
test("purge: 대상 0건", async () => {
  const client = mkClient({ claim_verification_docs_to_purge: () => ({ data: [], error: null }) });
  const r = await purgeVerificationDocs({ client, budget: budgetFull, storage: makeStorageRemover(client, "b") });
  assert.deepEqual(r, { processed: 0, failed: 0, hasMore: false });
});

test("purge: 안전경로 삭제 성공 → mark, 이미없는 파일도 성공 수렴", async () => {
  const client = mkClient(
    { claim_verification_docs_to_purge: (a, i) => ({ data: i === 1 ? [{ req_id: 1, storage_path: "u/a" }] : [], error: null }) },
    () => ok() // 오류 없음 = 성공(이미 없음 포함)
  );
  const r = await purgeVerificationDocs({ client, budget: budgetFull, storage: makeStorageRemover(client, "b") });
  assert.equal(r.processed, 1);
  assert.equal(only(client.calls, "mark_verification_doc_purged").length, 1);
});

test("purge: unsafe path → 삭제 안 하고 record_failure(unsafe_path)", async () => {
  const client = mkClient({ claim_verification_docs_to_purge: (a, i) => ({ data: i === 1 ? [{ req_id: 1, storage_path: "../x" }] : [], error: null }) }, () => ok());
  const r = await purgeVerificationDocs({ client, budget: budgetFull, storage: makeStorageRemover(client, "b") });
  assert.equal(r.failed, 1);
  assert.equal(only(client.calls, "record_verification_purge_failure")[0].args.p_error_code, "unsafe_path");
});

test("purge: 성공 후 mark 실패 → 그 행 failed(늦은 실패가 완료 미복원)", async () => {
  const client = mkClient(
    {
      claim_verification_docs_to_purge: (a, i) => ({ data: i === 1 ? [{ req_id: 1, storage_path: "u/a" }] : [], error: null }),
      mark_verification_doc_purged: () => ({ data: null, error: { message: "mark down" } }),
    },
    () => ok()
  );
  const r = await purgeVerificationDocs({ client, budget: budgetFull, storage: makeStorageRemover(client, "b") });
  assert.equal(r.failed, 1);
  assert.equal(r.processed, 0);
});

test("purge: budget 도달 → 1페이지 후 중단, hasMore", async () => {
  const client = mkClient(
    { claim_verification_docs_to_purge: () => ({ data: [{ req_id: 1, storage_path: "u/a" }, { req_id: 2, storage_path: "u/b" }], error: null }) },
    () => ok()
  );
  const r = await purgeVerificationDocs({ client, budget: budgetDone, storage: makeStorageRemover(client, "b"), limit: 2 });
  assert.equal(r.hasMore, true);
  assert.equal(only(client.calls, "claim_verification_docs_to_purge").length, 1);
});

/* ================= delete-accounts ================= */
function daClient(over = {}, storageImpl) {
  const base = {
    claim_accounts_for_deletion: (a, i) => ({ data: i === 1 ? [{ member_id: UUID, resuming: false }] : [], error: null }),
    prepare_account_deletion: () => ({ data: null, error: null }),
    detach_member_content: () => ({ data: null, error: null }),
    get_member_verification_paths: () => ({ data: [{ req_id: 1, storage_path: `${UUID}/a` }], error: null }),
    mark_member_verification_doc_purged: () => ({ data: true, error: null }),
    account_deletion_converged: () => ({ data: true, error: null }),
    record_maintenance_run: () => ({ data: null, error: null }),
  };
  return mkClient({ ...base, ...over }, storageImpl);
}
function mkAuth(ok = true) {
  const calls = [];
  return { calls, deleteUser: async (id) => { calls.push(id); return { attempted: true, ok }; } };
}
const ctx = (client, auth, extra = {}) => ({ client, auth, budget: budgetFull, storage: makeStorageRemover(client, "verification-docs"), ...extra });

test("delete: 신규 정상 순서 → processed 1, 호출 순서 보장", async () => {
  const client = daClient();
  const auth = mkAuth(true);
  const r = await deleteAccounts(ctx(client, auth));
  assert.equal(r.processed, 1);
  const seq = client.calls.map((c) => c.name);
  const idx = (n) => seq.indexOf(n);
  assert.ok(idx("prepare_account_deletion") < idx("detach_member_content"));
  assert.ok(idx("detach_member_content") < idx("get_member_verification_paths"));
  assert.ok(idx("get_member_verification_paths") < idx("mark_member_verification_doc_purged"));
  assert.equal(auth.calls.length, 1);
  assert.ok(idx("mark_member_verification_doc_purged") >= 0 && auth.calls.length === 1); // mark 후 auth
  assert.ok(idx("account_deletion_converged") > idx("mark_member_verification_doc_purged"));
});

test("delete: deleting 재개도 동일 순서로 수렴", async () => {
  const client = daClient({ claim_accounts_for_deletion: (a, i) => ({ data: i === 1 ? [{ member_id: UUID, resuming: true }] : [], error: null }) });
  const auth = mkAuth(true);
  const r = await deleteAccounts(ctx(client, auth));
  assert.equal(r.processed, 1);
  assert.equal(auth.calls.length, 1);
});

test("delete: prepare 실패 → detach·Storage·Auth 0회", async () => {
  const client = daClient({ prepare_account_deletion: () => ({ data: null, error: { message: "x" } }) });
  const auth = mkAuth(true);
  const r = await deleteAccounts(ctx(client, auth));
  assert.equal(r.failed, 1);
  assert.equal(only(client.calls, "detach_member_content").length, 0);
  assert.equal(auth.calls.length, 0);
});

test("delete: detach 실패 → Storage·Auth 0회", async () => {
  const client = daClient({ detach_member_content: () => ({ data: null, error: { message: "x" } }) });
  const auth = mkAuth(true);
  const r = await deleteAccounts(ctx(client, auth));
  assert.equal(r.failed, 1);
  assert.equal(only(client.calls, "get_member_verification_paths").length, 0);
  assert.equal(auth.calls.length, 0);
});

test("delete: 경로 조회 실패 → Storage·Auth 0회", async () => {
  const client = daClient({ get_member_verification_paths: () => ({ data: null, error: { message: "x" } }) });
  const auth = mkAuth(true);
  const r = await deleteAccounts(ctx(client, auth));
  assert.equal(r.failed, 1);
  assert.equal(auth.calls.length, 0);
});

test("delete: 일부 Storage 실패 → 메타정리·Auth 0회", async () => {
  const client = daClient(
    { get_member_verification_paths: () => ({ data: [{ req_id: 1, storage_path: `${UUID}/a` }, { req_id: 2, storage_path: `${UUID}/b` }], error: null }) },
    (paths) => (paths[0] === `${UUID}/b` ? { error: { message: "fail" } } : { error: null })
  );
  const auth = mkAuth(true);
  const r = await deleteAccounts(ctx(client, auth));
  assert.equal(r.failed, 1);
  assert.equal(only(client.calls, "mark_member_verification_doc_purged").length, 0);
  assert.equal(auth.calls.length, 0);
});

test("delete: Storage 전부 성공 후 메타정리 실패 → Auth 0회", async () => {
  const client = daClient({ mark_member_verification_doc_purged: () => ({ data: null, error: { message: "x" } }) }, () => ({ error: null }));
  const auth = mkAuth(true);
  const r = await deleteAccounts(ctx(client, auth));
  assert.equal(r.failed, 1);
  assert.equal(auth.calls.length, 0);
});

test("delete: 메타정리 회원 불일치(false 반환) → Auth 0회", async () => {
  const client = daClient({ mark_member_verification_doc_purged: () => ({ data: false, error: null }) }, () => ({ error: null }));
  const auth = mkAuth(true);
  const r = await deleteAccounts(ctx(client, auth));
  assert.equal(r.failed, 1);
  assert.equal(auth.calls.length, 0);
});

test("delete: 경로 201개(too_many) → Storage·메타·Auth 0회(fail-closed)", async () => {
  const many = Array.from({ length: 201 }, (_, i) => ({ req_id: i + 1, storage_path: `${UUID}/f${i}` }));
  const client = daClient({ get_member_verification_paths: (a, i) => ({ data: i === 1 ? many : [], error: null }) }, () => ({ error: null }));
  const auth = mkAuth(true);
  const r = await deleteAccounts(ctx(client, auth));
  assert.equal(r.failed, 1);
  assert.equal(only(client.calls, "mark_member_verification_doc_purged").length, 0);
  assert.equal(auth.calls.length, 0);
});

test("delete: Auth 성공 + converged=true → 성공", async () => {
  const client = daClient({ account_deletion_converged: () => ({ data: true, error: null }) });
  const r = await deleteAccounts(ctx(client, mkAuth(true)));
  assert.equal(r.processed, 1);
});

test("delete: Auth 성공 + converged=false → 실패", async () => {
  const client = daClient({ account_deletion_converged: () => ({ data: false, error: null }) });
  const r = await deleteAccounts(ctx(client, mkAuth(true)));
  assert.equal(r.failed, 1);
  assert.equal(r.processed, 0);
});

test("delete: Auth 오류 + converged=true → 성공 수렴", async () => {
  const client = daClient({ account_deletion_converged: () => ({ data: true, error: null }) });
  const auth = mkAuth(false); // Auth 실패해도
  const r = await deleteAccounts(ctx(client, auth));
  assert.equal(r.processed, 1); // converged=true면 성공 수렴
  assert.equal(auth.calls.length, 1);
});

test("delete: Auth 오류 + converged=false → 실패 재시도", async () => {
  const client = daClient({ account_deletion_converged: () => ({ data: false, error: null }) });
  const r = await deleteAccounts(ctx(client, mkAuth(false)));
  assert.equal(r.failed, 1);
});

test("delete: budget 소진 시 새 계정 미착수", async () => {
  const client = daClient();
  const auth = mkAuth(true);
  const r = await deleteAccounts({ client, auth, budget: budgetDone, storage: makeStorageRemover(client, "b") });
  assert.equal(r.processed, 0);
  assert.equal(only(client.calls, "prepare_account_deletion").length, 0);
  assert.equal(auth.calls.length, 0);
});

test("delete: 잘못된 member_id 형태 → 그 행 실패, RPC 미진행", async () => {
  const client = daClient({ claim_accounts_for_deletion: (a, i) => ({ data: i === 1 ? [{ member_id: "not-a-uuid", resuming: false }] : [], error: null }) });
  const auth = mkAuth(true);
  const r = await deleteAccounts(ctx(client, auth));
  assert.equal(r.failed, 1);
  assert.equal(only(client.calls, "prepare_account_deletion").length, 0);
});

test("delete: 결과에 UUID·path 미노출 (숫자 3필드)", async () => {
  const client = daClient();
  const r = await deleteAccounts(ctx(client, mkAuth(true)));
  assert.deepEqual(Object.keys(r).sort(), ["failed", "hasMore", "processed"]);
  assert.ok(!JSON.stringify(r).includes(UUID));
});
