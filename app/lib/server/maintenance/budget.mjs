// 실행 시간 예산 (서버리스 타임아웃 대비). GPT §4: maxDuration 60s 계약, 내부는 ~45~50s에서
// 신규 claim 중단, 이미 시작한 단일 항목은 안전한 상태까지 수렴 후 종료.
export function makeBudget(totalMs = 60000, softFraction = 0.8) {
  const start = Date.now();
  const soft = Math.max(0, totalMs * softFraction);
  return {
    // 신규 claim을 더 시작해도 되는가 (soft 한도 이전인가)
    canStartMore: () => Date.now() - start < soft,
    elapsedMs: () => Date.now() - start,
  };
}
