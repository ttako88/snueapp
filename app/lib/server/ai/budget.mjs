// ============================================================
// budget.mjs — AI 호출 비용 상한 (서버 전용, rev2)
// ============================================================
// 보장해야 하는 불변식: **AI 호출 총비용이 KST 일일 한도를 넘을 수 없다.**
//
// rev1 은 견적(estimate)을 예약했는데, 실제 비용이 견적을 넘으면 상한이 샜다.
// rev2 는 **그 호출이 낼 수 있는 최대 비용**을 계산해 예약한다. 그러려면
// 입력·출력 토큰 양쪽에 기계적 상한이 있어야 한다 —
//   · 출력은 API 의 max_output_tokens 로 묶는다
//   · 입력은 프롬프트 길이를 서버가 자르고, 자른 뒤 길이로 상한을 계산한다
// 이 둘이 없으면 "최대 비용" 이라는 말 자체가 성립하지 않는다.
//
// 한도 값은 DB(private.ai_budget_config)가 단일 출처다. 여기서 넘기지 않는다 —
// 호출부 오류 하나로 상한이 통째로 무력화되기 때문이다.
// ============================================================

if (typeof window !== "undefined") {
  throw new Error("ai/budget.mjs 는 서버 전용입니다");
}

/** 모델별 단가 (USD per 1M tokens). 2026-07 실측. */
export const MODELS = {
  "gemini-3-flash":   { in: 0.50, out: 3.00, label: "Gemini 3 Flash" },
  "claude-haiku-4-5": { in: 1.00, out: 5.00, label: "Claude Haiku 4.5" },
  "gpt-5-mini":       { in: 0.25, out: 2.00, label: "GPT-5 mini" },
};

export const DEFAULT_MODEL = process.env.AI_MODEL ?? "gemini-3-flash";

/** 환율은 보수적으로 높게 잡는다 — 낮게 잡으면 상한을 넘겨도 안 걸린다. */
export const USD_KRW = Number(process.env.USD_KRW ?? 1500);

/** 입력 프롬프트 하드 상한(문자). 이걸 넘으면 자른다. 최대 비용 계산의 전제다. */
export const MAX_PROMPT_CHARS = 6000;

/** 한국어는 토큰 효율이 낮다. 최대 비용 계산이므로 넉넉히 잡는다. */
const CHARS_TO_TOKENS = 2.0;

/** 비용은 항상 올림. 내림하면 상한 근처에서 초과가 새어 나간다. */
export function costKrw(model, inTokens, outTokens) {
  const m = MODELS[model];
  if (!m) throw new Error(`알 수 없는 모델: ${model}`);
  const usd = (inTokens * m.in + outTokens * m.out) / 1_000_000;
  return Math.ceil(usd * USD_KRW);
}

/**
 * 이 호출이 낼 수 있는 **최대** 비용. 예약액은 이 값이다.
 * 입력은 잘린 프롬프트 기준, 출력은 API 에 넘길 max_output_tokens 기준이다.
 * 둘 다 실제 호출에서 초과될 수 없는 값이라야 이 계산이 의미를 갖는다.
 */
export function maxCostKrw(model, promptChars, maxOutTokens) {
  const inTok = Math.ceil(Math.min(promptChars, MAX_PROMPT_CHARS) * CHARS_TO_TOKENS);
  return costKrw(model, inTok, maxOutTokens);
}

/** 프롬프트를 하드 상한으로 자른다. 자르지 않으면 최대 비용을 보장할 수 없다. */
export function clampPrompt(text) {
  const s = String(text ?? "");
  return [...s].length <= MAX_PROMPT_CHARS ? s : [...s].slice(0, MAX_PROMPT_CHARS).join("");
}

/**
 * 예약. 한도는 DB 가 정하므로 넘기지 않는다.
 * @returns {{ allowed: boolean, reservationId?: string, reason?: string, ... }}
 */
export async function reserve(svc, { userId, maxKrw }) {
  const { data, error } = await svc.rpc("svc_ai_reserve", {
    p_member_id: userId, p_max_krw: maxKrw,
  });
  if (error) {
    // 예약이 안 되면 호출하지 않는다(fail-closed). 확인 못 한 채 돈 쓰는
    // 경로를 두면 상한 장치가 있으나 마나다.
    return { allowed: false, reason: "budget_unavailable" };
  }
  return {
    allowed: data?.allowed === true,
    reservationId: data?.reservation_id ?? null,
    reason: data?.reason ?? null,
    spentTodayKrw: data?.spent_today ?? null,
    limitKrw: data?.limit ?? null,
  };
}

/** 정산. 실제가 예약을 넘으면 DB 가 거부하고 예약은 open 으로 남는다. */
export async function settle(svc, { reservationId, userId, model, inTokens, outTokens, purpose }) {
  const actual = costKrw(model, inTokens, outTokens);
  const { data, error } = await svc.rpc("svc_ai_settle", {
    p_reservation_id: reservationId,
    p_member_id: userId,
    p_model: model,
    p_in_tokens: inTokens,
    p_out_tokens: outTokens,
    p_actual_krw: actual,
    p_purpose: purpose,
  });
  if (error) return { ok: false, reason: "settle_failed", actual };
  return { ok: data?.ok === true, reason: data?.reason ?? null, actual };
}

/**
 * 해제. **호출 실패가 확인된 경우에만** 부른다.
 * 성공 여부가 불명확하면 부르지 않는다 — 애매하면 돈이 나간 쪽으로 본다.
 */
export async function release(svc, { reservationId, userId }) {
  const { error } = await svc.rpc("svc_ai_release", {
    p_reservation_id: reservationId, p_member_id: userId,
  });
  return !error;
}
