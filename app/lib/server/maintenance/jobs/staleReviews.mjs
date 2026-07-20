// stale-reviews 잡. 장기 미심사 알림(3/7일) + 30일 자동 종료 — 각 RPC 결과로 집계.
// 책임 분리: expired_unreviewed 전환까지만. 실제 Storage 삭제는 purge-verification-docs가 담당.
// 단계 실패 시(보수적 기본): 해당 실행 중단(throw) → 다음 Cron 재시도.
import { callRpc, asCount } from "../rpc.mjs";

export async function staleReviews(ctx) {
  const { client, budget, limit = 200 } = ctx;
  let processed = 0;
  let hasMore = false;

  do {
    // 단계1: 알림 발송(운영진 3/7일 + 사용자 지연). 실패하면 여기서 중단 — 단계2 진행 안 함.
    const sent = asCount(
      await callRpc(client, "run_stale_review_notifications", { p_limit: limit }, "notify"),
      "notify"
    );
    // 단계2: 30일(submitted_at 기준) 초과 → expired_unreviewed + pending 복귀 + purge_after 즉시.
    const expired = asCount(
      await callRpc(client, "expire_unreviewed_submissions", { p_limit: limit }, "expire_unreviewed"),
      "expire_unreviewed"
    );

    processed += sent + expired;
    hasMore = sent >= limit || expired >= limit;
  } while (hasMore && budget.canStartMore());

  return { processed, failed: 0, hasMore };
}
