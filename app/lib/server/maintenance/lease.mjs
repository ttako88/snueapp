// maintenance lease 래퍼 (중복 실행 1차 방지). 009/001~008의 service_role RPC 사용.
// GPT §5-5·§7: job별 lease, already_running이면 정상 200, 인메모리/파일 잠금 금지,
// finally에서 자기 token으로 해제(함수 timeout 시 TTL 경과가 최종 복구선).
export async function withLease(client, job, ttlSec, fn) {
  const { data: token, error } = await client.rpc("acquire_maintenance_lease", {
    p_job: job,
    p_duration_sec: ttlSec,
  });
  if (error) {
    const e = new Error("lease acquire failed");
    e.failedStep = "lease_acquire";
    throw e;
  }
  if (!token) return { alreadyRunning: true }; // 유효 lease 존재 → 중복 실행 회피
  try {
    return await fn(token);
  } finally {
    // release 실패는 배치 결과에만 반영하고 응답에 원문 오류를 넣지 않음. TTL 만료가 최종 회수.
    try {
      await client.rpc("release_maintenance_lease", { p_job: job, p_token: token });
    } catch {
      /* no-op: TTL 만료가 회수 */
    }
  }
}
