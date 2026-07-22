// ============================================================
// POST /api/lesson-plan — 수업지도안(약안·세안) 생성
// ============================================================
// 이 라우트는 **소유자 지갑에서 실제 돈을 쓴다.** 그래서 순서가 중요하다.
//   ① 로그인 확인 → ② 입력 검증 → ③ 견적 → ④ 예산 확인·예약 →
//   ⑤ AI 호출 → ⑥ 실제 사용량 기록
// 예산 확인을 통과하지 못하면 호출하지 않는다. 확인 자체가 불가능해도
// 호출하지 않는다(fail-closed) — 확인 못 한 채 돈 쓰는 경로를 만들면
// 상한 장치가 있으나 마나다.
import { NextResponse } from "next/server";
import { isEnabled } from "../../lib/features";
import { serviceClient, requireUser, NO_STORE } from "../../lib/server/verification/auth.mjs";
import {
  DEFAULT_MODEL, MODELS, maxCostKrw, clampPrompt, reserve, settle, release,
} from "../../lib/server/ai/budget.mjs";
import { generate, AiKeyMissing, availableProviders } from "../../lib/server/ai/provider.mjs";
import { validatePlanInput, withDefaults, PLAN_TYPES } from "../../lib/lessonPlan";
// 프롬프트는 여기서 만들지 않는다. 예전에 이 파일과 샘플 스크립트에 **각각**
// 복사돼 있어서, 샘플로 품질을 튜닝해도 앱에는 반영되지 않았다.
import { buildLessonPrompt } from "../../lib/server/ai/lessonPrompt.mjs";
import { loadAll } from "../../lib/server/ai/lessonData.mjs";

export const runtime = "nodejs";
export const maxDuration = 60;

const json = (body, status) => NextResponse.json(body, { status, headers: NO_STORE });

// 근거 CSV 는 매 요청마다 읽을 필요가 없다. 파일이 바뀌는 건 배포 때뿐이다.
// 다만 **읽기 실패를 캐시하지 않는다** — 실패를 빈 데이터로 굳히면
// "데이터가 없다" 와 "읽는 데 실패했다" 를 영영 구분할 수 없다.
let evidenceCache = null;
function evidence() {
  if (evidenceCache) return evidenceCache;
  try { evidenceCache = loadAll(); } catch { return null; }
  return evidenceCache;
}

export async function POST(request) {
  let svc;
  try { svc = serviceClient(); }
  catch { return json({ error: "service_unavailable" }, 503); }

  const who = await requireUser(request, svc);
  if (who.error) return json({ error: who.error }, who.status);

  // ⚠️ 지도안 생성은 소유자 지갑에서 실제 돈이 나간다. 로그인 개방(015) 후에는
  //    아무나 로그인만 하면 예산을 소진할 수 있다. 그래서 공개(lessonPlanPublic)
  //    전까지는 **owner 만** 생성한다. 개인별 한도(aiCreditCharge)가 켜지면 그때
  //    이 flag 를 열어 인증회원에게 개방한다. 서버 게이트가 진짜 경계다.
  if (!isEnabled("lessonPlanPublic")) {
    let role = null;
    try {
      const { data } = await svc.rpc("svc_reviewer_role", { p_actor_id: who.userId });
      role = data ?? null;
    } catch { role = null; }
    if (role !== "owner") return json({ error: "not_available_yet" }, 403);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "bad_request" }, 400); }

  const invalid = validatePlanInput(body);
  if (invalid) return json({ error: "invalid_input", message: invalid }, 400);

  const model = DEFAULT_MODEL;
  const providers = availableProviders();
  if (!providers[model]) {
    // 키가 없으면 명확히 말한다. 조용히 빈 결과를 주지 않는다.
    return json({ error: "ai_not_configured", model }, 503);
  }

  const type = PLAN_TYPES.find((t) => t.key === body.planType);
  // 수업모형을 안 골랐으면 교과·학년으로 채운다. 화면과 같은 함수를 써서
  // "화면에 보이는 모형" 과 "실제로 쓰인 모형" 이 어긋나지 않게 한다.
  const input = withDefaults(body);
  const built = buildLessonPrompt(input, { data: evidence() });
  // 프롬프트를 하드 상한으로 자른다. 자르지 않으면 "최대 비용" 계산이
  // 성립하지 않고, 그러면 예약액을 실제가 넘어설 수 있다.
  const prompt = clampPrompt(built.prompt);
  const maxOut = type.maxOutTokens;

  // --- 이 호출이 낼 수 있는 최대 비용 ---
  // 입력은 잘린 프롬프트, 출력은 API 에 넘길 max_output_tokens 기준이라
  // 실제 비용이 이 값을 넘을 수 없다.
  const maxKrw = maxCostKrw(model, [...(built.system + prompt)].length, maxOut);

  // --- SR 차감 (flag ON 일 때만) ---
  // 예산 상한(018)과 목적이 다르다. 예산은 "소유자 지갑이 하루에 얼마까지
  // 나가는가", SR 은 "한 사람이 얼마나 쓰는가" 다. 예산만 있으면 한 계정이
  // 하루치를 통째로 소진해 나머지 전원이 못 쓰게 만들 수 있다.
  //
  // ⚠️ flag 가 OFF 면 개인별 제한이 **없다**. 023 을 적용한 뒤 켤 것.
  //    (flag 로 감싸는 이유: 023 없이 배포돼도 지도안이 깨지지 않게)
  const purpose = body.planType === "full" ? "lesson_plan_full" : "lesson_plan_brief";
  let charge = null;
  if (isEnabled("aiCreditCharge")) {
    const key = `ai:${who.userId}:${purpose}:${Date.now()}`;
    const { data: ch, error: chErr } = await svc.rpc("svc_charge_ai_credit", {
      p_member_id: who.userId, p_purpose: purpose, p_idempotency_key: key,
    });
    // 차감을 확인하지 못하면 호출하지 않는다(fail-closed). 확인 못 한 채
    // 돈 쓰는 경로를 두면 제한 장치가 있으나 마나다.
    if (chErr) return json({ error: "credit_unavailable" }, 503);
    if (ch?.ok !== true) {
      return json({ error: ch?.reason ?? "insufficient_sr",
                    balance: ch?.balance ?? null, cost: ch?.cost ?? null }, 402);
    }
    charge = ch;
  }

  /** SR 을 되돌린다. **실패가 확인된 경우에만** 부른다. */
  const refund = async () => {
    if (!charge?.entry_id) return;
    try {
      await svc.rpc("svc_refund_ai_credit", {
        p_member_id: who.userId, p_entry_id: charge.entry_id });
    } catch { /* 환불 실패는 운영 확인 대상. 응답을 바꾸지 않는다 */ }
  };

  // --- 예약 (한도는 DB 가 정한다) ---
  const res = await reserve(svc, { userId: who.userId, maxKrw });
  if (!res.allowed) {
    // 예산에 막혀 생성 자체를 못 했다. SR 을 받아 둘 이유가 없다.
    await refund();
    return json({
      error: res.reason ?? "budget_exceeded",
      spentTodayKrw: res.spentTodayKrw ?? null,
      dailyLimitKrw: res.limitKrw ?? null,
    }, res.reason === "single_call_too_expensive" ? 400 : 429);
  }

  // --- 생성 ---
  let out;
  try {
    out = await generate({ model, system: built.system, prompt, maxOutTokens: maxOut });
  } catch (e) {
    // 호출이 **실패했음이 확인된** 경우다. 이때만 예약을 푼다.
    await release(svc, { reservationId: res.reservationId, userId: who.userId });
    await refund();   // 호출이 실패했음이 확인된 경우다
    if (e instanceof AiKeyMissing) return json({ error: "ai_not_configured", model }, 503);
    return json({ error: "generation_failed" }, 502);
  }
  if (!out.text?.trim()) {
    // 응답은 왔지만 비어 있다 — 돈은 나갔을 수 있으므로 예약을 풀지 않고
    // 실제 사용량으로 정산한다.
    await settle(svc, {
      reservationId: res.reservationId, userId: who.userId, model,
      inTokens: out.inTokens, outTokens: out.outTokens,
      purpose,
    });
    // 사용자는 아무것도 못 받았다. 돈은 나갔을 수 있어도 SR 은 돌려준다 —
    // 원가는 소유자 부담이고, 사용자에게 빈 결과를 팔 수는 없다.
    await refund();
    return json({ error: "empty_result" }, 502);
  }

  // --- 정산 ---
  // 실패해도 사용자 응답을 막지 않는다 — 돈은 이미 나갔고, 결과를 안 주면
  // 돈만 쓰고 아무것도 못 받는 셈이다. 대신 예약은 open 으로 남아 계속
  // 비용으로 잡히므로 상한은 지켜진다(보수적 처리).
  const acct = await settle(svc, {
    reservationId: res.reservationId, userId: who.userId, model,
    inTokens: out.inTokens, outTokens: out.outTokens,
    purpose,
  });

  return json({
    planType: body.planType,
    modelLabel: MODELS[model].label,
    text: out.text,
    costKrw: acct.actual,
    accounted: acct.ok,
    // 출력 한도에 걸려 문장 중간에서 끊긴 경우다. 잘린 것을 완성본처럼
    // 건네지 않는다 — 실습 제출물이라 그대로 내면 사용자가 손해를 본다.
    truncated: Boolean(out.truncated),
    // 얼마를 썼는지 숨기지 않는다. 사용자 잔액에서 나간 값이다.
    spentSr: charge?.cost ?? 0,
    balanceSr: charge?.balance ?? null,
    // AI 초안임을 응답에 박아 둔다. 화면이 이걸 빼먹어도 원본에 남는다.
    notice: out.truncated
      ? "분량 한도에 걸려 뒷부분이 잘렸습니다. 다시 생성하거나 범위를 좁혀 주세요."
      : "AI 가 만든 초안입니다. 반드시 직접 검토·수정해서 쓰세요.",
  }, 200);
}
