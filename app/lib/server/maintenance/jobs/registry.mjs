// 잡 디스패처. Batch 1은 인프라만 — 실제 4종 잡 구현은 Batch 2A/2B에서 이 레지스트리를 채운다.
// (JOB_NAMES는 validation.mjs의 allowlist와 항상 일치해야 한다 — core가 그걸로 먼저 거른다.)
//
// ctx = { client, budgetMs }. 반환 계약: { processed:int, failed:int, hasMore:boolean }.
export const JOB_HANDLERS = {
  // "purge-verification-docs": purgeVerificationDocs,   // Batch 2B
  // "delete-accounts":         deleteAccounts,          // Batch 2B
  // "expire-uploads":          expireUploads,           // Batch 2A
  // "stale-reviews":           staleReviews,            // Batch 2A
};

export async function runJob(job, ctx) {
  const handler = JOB_HANDLERS[job];
  if (!handler) {
    const e = new Error(`job handler not implemented: ${job} (Batch 2)`);
    e.failedStep = "not_implemented";
    throw e;
  }
  return handler(ctx);
}
