// maintenance 요청 처리 코어 (순수 오케스트레이션 — 외부 IO는 deps 주입으로 테스트 가능).
// GPT §5 인증·환경 검증 순서를 그대로 구현. Route(route.js)는 이 코어를 실제 deps로 감싸는 얇은 어댑터.
//
// 반환: { status:<http>, body:<obj|null> }  (body=null → 무본문 401)
// deps: { env, createServiceClient, withLease, runJob, leaseTtlSec?, budgetMs? }
import { isKnownJob, verifyCronSecret, validateProjectRef } from "./validation.mjs";

export async function handleMaintenance({ authHeader, job }, deps) {
  const { env, createServiceClient, withLease, runJob, leaseTtlSec = 120, budgetMs = 60000 } = deps;

  // 0) 비활성 기본값 — service client 생성 전, 상태 변경 없이 disabled
  if (env.MAINTENANCE_ENABLED !== "true") return { status: 200, body: { status: "disabled" } };

  // 1) CRON_SECRET (미설정·짧음·불일치 → 무본문 401, 아무것도 만들지 않음)
  if (!verifyCronSecret(authHeader, env.CRON_SECRET)) return { status: 401, body: null };

  // 2) job allowlist (unknown → client·lease 생성 안 함)
  if (!isKnownJob(job)) return { status: 400, body: { status: "unknown_job" } };

  // 3) APP_ENV·project ref 대조 (불일치 → mutation 없이 500)
  if (!validateProjectRef(env).ok) return { status: 500, body: { status: "error", job, failedStep: "env" } };

  // 4) service client
  let client;
  try {
    client = createServiceClient(env);
  } catch {
    return { status: 500, body: { status: "error", job, failedStep: "client" } };
  }

  // 5) lease 획득 → 6) 잡 실행 → 7) 해제(withLease finally). already_running이면 정상 200.
  try {
    const result = await withLease(client, job, leaseTtlSec, () => runJob(job, { client, budgetMs }));
    if (result && result.alreadyRunning) return { status: 200, body: { status: "already_running" } };
    return {
      status: 200,
      body: {
        status: "ok",
        job,
        processed: result?.processed ?? 0,
        failed: result?.failed ?? 0,
        hasMore: result?.hasMore ?? false,
      },
    };
  } catch (e) {
    // 응답엔 비식별 failedStep만 — 원문 오류·경로·UUID·secret 미포함
    return { status: 500, body: { status: "error", job, failedStep: (e && e.failedStep) || "run" } };
  }
}
