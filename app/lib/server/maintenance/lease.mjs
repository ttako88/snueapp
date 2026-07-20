// maintenance lease 래퍼 (중복 실행 1차 방지). 009/001~008의 service_role RPC 사용.
// GPT §5-5·§7·§C: job별 lease, already_running이면 정상 200, 인메모리/파일 잠금 금지.
//   - 잡 성공 + release 실패 → failedStep='lease_release'로 표면화(내부 오류 원문 비노출).
//   - 잡 실패 + release 실패 → 원래 잡 실패를 숨기지 않고, release 실패는 내부 플래그로 보존.
//   - 함수 timeout·프로세스 종료 시엔 아무것도 못 하므로 lease TTL 경과가 최종 회수선.
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

  let result, fnError;
  try {
    result = await fn(token);
  } catch (e) {
    fnError = e;
  }

  let releaseError = false;
  try {
    const { error: relErr } = await client.rpc("release_maintenance_lease", { p_job: job, p_token: token });
    if (relErr) releaseError = true;
  } catch {
    releaseError = true;
  }

  if (fnError) {
    // 잡 실패 우선 — release 실패는 내부 플래그로 보존(응답엔 잡의 failedStep만)
    if (releaseError && typeof fnError === "object") fnError.releaseFailed = true;
    throw fnError;
  }
  if (releaseError) {
    const e = new Error("lease release failed");
    e.failedStep = "lease_release";
    throw e;
  }
  return result;
}
