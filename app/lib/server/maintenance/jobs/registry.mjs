// 잡 디스패처 + 실행 ctx 구성 + batch_runs 기록.
// (JOB_NAMES는 validation.mjs allowlist와 항상 일치 — core가 그걸로 먼저 거른다.)
// ctx = { client, budget, storage, auth }. 반환 계약: { processed:int, failed:int, hasMore:boolean }.
import { makeBudget } from "../budget.mjs";
import { makeStorageRemover } from "../storage.mjs";
import { makeAuthAdmin } from "../authAdmin.mjs";
import { staleReviews } from "./staleReviews.mjs";
import { expireUploads } from "./expireUploads.mjs";
import { purgeVerificationDocs } from "./purgeVerificationDocs.mjs";
import { deleteAccounts } from "./deleteAccounts.mjs";

const STORAGE_BUCKET = "verification-docs"; // 고정 — DB RPC엔 버킷을 넘기지 않음
const HANDLERS = {
  "stale-reviews": staleReviews,
  "expire-uploads": expireUploads,
  "purge-verification-docs": purgeVerificationDocs,
  "delete-accounts": deleteAccounts,
};

// batch_runs 기록. 성공하면 true, RPC 오류/예외면 false 반환(무엇을 할지는 호출측이 결정).
async function recordRun(client, job, ok, processed, errorCode) {
  try {
    const { error } = await client.rpc("record_maintenance_run", {
      p_job: job,
      p_ok: ok,
      p_processed: processed,
      p_error_code: errorCode,
    });
    return !error;
  } catch {
    return false;
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
    const e = new Error(`job handler not implemented: ${job}`);
    e.failedStep = "not_implemented";
    throw e;
  }
  const ctx = {
    client,
    budget: makeBudget(budgetMs),
    storage: makeStorageRemover(client, STORAGE_BUCKET),
    auth: makeAuthAdmin(client),
  };

  let result;
  let jobError;
  try {
    result = await handler(ctx);
  } catch (e) {
    jobError = e;
  }

  if (!jobError) {
    // 작업 성공 + 기록 실패 → 감사·모니터링 고장을 성공으로 보고하지 않도록 실패로 표면화.
    const recorded = await recordRun(client, job, true, result.processed, null);
    if (!recorded) {
      const e = new Error("maintenance record failed");
      e.failedStep = "maintenance_record";
      throw e;
    }
    return result;
  }

  // 작업 실패 + 기록 실패 → 원래 failedStep 유지, record 실패는 내부 부가정보로만 보존.
  const recorded = await recordRun(client, job, false, 0, safeCode(jobError.failedStep));
  if (!recorded && jobError && typeof jobError === "object") jobError.recordFailed = true;
  throw jobError;
}

export { HANDLERS };
