// 잡 디스패처 + 실행 ctx 구성 + batch_runs 기록.
// (JOB_NAMES는 validation.mjs allowlist와 항상 일치 — core가 그걸로 먼저 거른다.)
// ctx = { client, budget, storage }. 반환 계약: { processed:int, failed:int, hasMore:boolean }.
import { makeBudget } from "../budget.mjs";
import { makeStorageRemover } from "../storage.mjs";
import { staleReviews } from "./staleReviews.mjs";
import { expireUploads } from "./expireUploads.mjs";

const STORAGE_BUCKET = "verification-docs"; // 고정 — DB RPC엔 버킷을 넘기지 않음
const HANDLERS = {
  "stale-reviews": staleReviews,
  "expire-uploads": expireUploads,
  // "purge-verification-docs": purgeVerificationDocs,  // Batch 2B
  // "delete-accounts":         deleteAccounts,          // Batch 2B
};

// batch_runs 기록. 기록 자체의 실패는 원래 작업 결과를 바꾸지 않는다(swallow).
async function recordRun(client, job, ok, processed, errorCode) {
  try {
    await client.rpc("record_maintenance_run", {
      p_job: job,
      p_ok: ok,
      p_processed: processed,
      p_error_code: errorCode,
    });
  } catch {
    /* 기록 실패는 작업 결과를 덮어쓰지 않음 */
  }
}

// failedStep을 안전한 error_code 형식(^[a-z0-9][a-z0-9_:-]{0,39}$)으로 정규화
function safeCode(step) {
  const s = String(step || "error").toLowerCase();
  return /^[a-z0-9][a-z0-9_:-]{0,39}$/.test(s) ? s : "error";
}

export async function runJob(job, { client, budgetMs }) {
  const handler = HANDLERS[job];
  if (!handler) {
    const e = new Error(`job handler not implemented: ${job} (Batch 2)`);
    e.failedStep = "not_implemented";
    throw e;
  }
  const ctx = {
    client,
    budget: makeBudget(budgetMs),
    storage: makeStorageRemover(client, STORAGE_BUCKET),
  };
  try {
    const result = await handler(ctx);
    await recordRun(client, job, true, result.processed, null);
    return result;
  } catch (e) {
    // 실패 기록 시도(원래 실패 원인을 덮어쓰지 않음) 후 원 오류 재던짐
    await recordRun(client, job, false, 0, safeCode(e && e.failedStep));
    throw e;
  }
}

export { HANDLERS };
