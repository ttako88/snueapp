// ============================================================
// budget.mjs — AI 호출 비용 상한 (서버 전용)
// ============================================================
// 왜 이게 먼저인가
//   AI 지도안 생성은 **소유자 지갑에서 실제 돈이 나간다.** 버그 하나나
//   어뷰징 한 번이면 카드가 긁힌다. 기능보다 이 장치가 먼저 있어야 한다.
//
//   소유자 확인 사항(2026-07-22): 원가는 세안 1건당 Gemini 3 Flash ₩20 /
//   Claude Haiku ₩35 수준. 하루 총 5,000원(≈150~250회)을 넘으면 자동 차단.
//
// 설계
//   · 상한은 **금액**으로 잡는다. 호출 횟수로 잡으면 모델을 바꿀 때마다
//     의미가 달라진다.
//   · 일일 상한과 사용자별 상한을 따로 둔다. 한 사람이 하루치를 다 태우면
//     나머지 사용자가 못 쓴다.
//   · 상한에 걸리면 **거부한다.** 큐에 넣거나 나중에 처리하지 않는다 —
//     그러면 다음 날 몰려서 또 터진다.
//   · 집계는 DB 에 남긴다. 서버 인스턴스가 여러 개일 때 메모리 카운터는
//     의미가 없다(Vercel 은 요청마다 다른 인스턴스일 수 있다).
// ============================================================

if (typeof window !== "undefined") {
  throw new Error("ai/budget.mjs 는 서버 전용입니다");
}

/** 원화 기준. 환경변수로 덮어쓸 수 있게 해서 운영 중 조정 가능하게 둔다. */
export const BUDGET = {
  dailyTotalKrw: Number(process.env.AI_DAILY_BUDGET_KRW ?? 5000),
  dailyPerUserKrw: Number(process.env.AI_DAILY_USER_BUDGET_KRW ?? 1000),
  /** 한 번의 호출이 이 금액을 넘으면 애초에 보내지 않는다 (프롬프트 폭주 방지) */
  singleCallMaxKrw: Number(process.env.AI_SINGLE_CALL_MAX_KRW ?? 200),
};

/**
 * 모델별 단가 (USD per 1M tokens). 2026-07 실측 기준.
 * 환율은 보수적으로 잡는다 — 낮게 잡으면 상한을 넘겨도 안 걸린다.
 */
export const USD_KRW = Number(process.env.USD_KRW ?? 1400);

export const MODELS = {
  "gemini-3-flash": { in: 0.50, out: 3.00, label: "Gemini 3 Flash" },
  "claude-haiku-4-5": { in: 1.00, out: 5.00, label: "Claude Haiku 4.5" },
  "gpt-5-mini": { in: 0.25, out: 2.00, label: "GPT-5 mini" },
};

export const DEFAULT_MODEL = process.env.AI_MODEL ?? "gemini-3-flash";

/** 토큰 수 → 원화. 반올림하지 않고 올림한다 — 과소평가가 상한을 무력화한다. */
export function costKrw(model, inTokens, outTokens) {
  const m = MODELS[model];
  if (!m) throw new Error(`알 수 없는 모델: ${model}`);
  const usd = (inTokens * m.in + outTokens * m.out) / 1_000_000;
  return Math.ceil(usd * USD_KRW);
}

/**
 * 한국어는 토큰 효율이 낮다. 글자 수로 토큰을 어림할 때 1.5배를 곱한다.
 * 사전 견적용이며, 실제 과금은 응답의 usage 값으로 다시 계산한다.
 */
export function estimateTokens(text) {
  return Math.ceil([...String(text ?? "")].length * 1.5);
}

/**
 * 호출 전 견적. 상한을 넘으면 보내지 않는다.
 * @returns {{ ok: true, estKrw: number } | { ok: false, reason: string, estKrw: number }}
 */
export function preflight({ model, promptText, expectedOutTokens = 4000 }) {
  const inTok = estimateTokens(promptText);
  const est = costKrw(model, inTok, expectedOutTokens);
  if (est > BUDGET.singleCallMaxKrw) {
    return { ok: false, reason: "single_call_too_expensive", estKrw: est };
  }
  return { ok: true, estKrw: est };
}

/**
 * 오늘 쓴 금액을 DB 에서 확인하고 이번 호출을 허용할지 판단한다.
 * 집계는 RPC 로 한다 — private 스키마를 직접 읽을 수 없고(PostgREST 미노출),
 * 동시 요청에서 읽기·쓰기가 갈라지면 상한이 새기 때문에 한 함수 안에서 처리한다.
 *
 * @param svc service_role 클라이언트
 * @returns {{ allowed: boolean, reason?: string, spentTodayKrw?: number }}
 */
export async function checkBudget(svc, { userId, estKrw }) {
  const { data, error } = await svc.rpc("svc_ai_budget_check", {
    p_member_id: userId,
    p_est_krw: estKrw,
    p_daily_total_krw: BUDGET.dailyTotalKrw,
    p_daily_user_krw: BUDGET.dailyPerUserKrw,
  });
  if (error) {
    // 예산 확인이 안 되면 **거부한다.** 확인 못 한 채로 돈 쓰는 호출을
    // 통과시키면 상한 장치가 있으나 마나다 (fail-closed).
    return { allowed: false, reason: "budget_check_unavailable" };
  }
  return {
    allowed: data?.allowed === true,
    reason: data?.reason ?? null,
    spentTodayKrw: data?.spent_today ?? null,
  };
}

/** 호출이 끝난 뒤 실제 사용량으로 기록한다. 견적이 아니라 실측으로 남긴다. */
export async function recordUsage(svc, { userId, model, inTokens, outTokens, purpose }) {
  const krw = costKrw(model, inTokens, outTokens);
  const { error } = await svc.rpc("svc_ai_record_usage", {
    p_member_id: userId,
    p_model: model,
    p_in_tokens: inTokens,
    p_out_tokens: outTokens,
    p_cost_krw: krw,
    p_purpose: purpose,
  });
  return { recorded: !error, krw };
}
