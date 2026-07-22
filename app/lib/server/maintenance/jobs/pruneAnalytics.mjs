// prune-analytics — 분석·광고 부수 테이블의 단기 보존 행 정리.
//   · usage_rate: rate limit 창(지난 창은 판정에 무용) — 10분 초과 삭제.
//   · ad_deliveries: 만료된 광고 서빙 토큰 — 만료+30분 초과 삭제.
// 둘 다 개인 속성이 없고(비식별), 잔존해도 무해하지만 무한 증식을 막으려 정리한다.
// 실패는 registry 가 batch_runs 에 기록해 감시한다(record 실패 시 성공으로 보고 안 함).
//
// 반환 계약: { processed:int, failed:int, hasMore:boolean }.
export async function pruneAnalytics({ client }) {
  let processed = 0;

  const r1 = await client.rpc("svc_prune_usage_rate", { p_keep_minutes: 10 });
  if (r1.error) {
    const e = new Error("prune usage_rate failed");
    e.failedStep = "prune_usage_rate";
    throw e;
  }
  processed += Number(r1.data) || 0;

  const r2 = await client.rpc("svc_prune_ad_deliveries", { p_keep_minutes: 30 });
  if (r2.error) {
    const e = new Error("prune ad_deliveries failed");
    e.failedStep = "prune_ad_deliveries";
    throw e;
  }
  processed += Number(r2.data) || 0;

  return { processed, failed: 0, hasMore: false };
}
