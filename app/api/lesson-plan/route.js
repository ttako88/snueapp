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
import { serviceClient, requireUser, NO_STORE } from "../../lib/server/verification/auth.mjs";
import {
  DEFAULT_MODEL, MODELS, preflight, checkBudget, recordUsage, BUDGET,
} from "../../lib/server/ai/budget.mjs";
import { generate, AiKeyMissing, availableProviders } from "../../lib/server/ai/provider.mjs";
import {
  validatePlanInput, PLAN_TYPES, TEACHING_MODELS,
} from "../../lib/lessonPlan";

export const runtime = "nodejs";
export const maxDuration = 60;

const json = (body, status) => NextResponse.json(body, { status, headers: NO_STORE });

const SYSTEM = `당신은 대한민국 초등학교 교사입니다. 2022 개정 교육과정에 따라
초등 수업지도안을 작성합니다.

지켜야 할 것:
- 초등학생 발달 수준에 맞는 표현을 씁니다. 중·고등학교 수업이 아닙니다.
- 발문(교사의 질문)은 실제로 교실에서 말하는 문장으로 씁니다.
- 활동은 주어진 수업 시간 안에 실제로 끝날 수 있는 분량으로 합니다.
- 성취기준 코드를 지어내지 않습니다. 정확히 모르면 코드를 쓰지 말고
  학습목표만 서술합니다.
- 학생 개인정보나 실명을 만들어 넣지 않습니다.
- 표는 마크다운 표로 씁니다.`;

function buildPrompt(v) {
  const type = PLAN_TYPES.find((t) => t.key === v.planType);
  const model = TEACHING_MODELS.find((m) => m.key === v.model);
  const structure = v.planType === "full"
    ? `1. 단원 개관
2. 단원 학습 목표
3. 학습자 실태 (일반적인 수준으로)
4. 차시별 지도 계획 (표)
5. 본시 학습 (표: 학습 단계 / 교수·학습 활동 / 시간 / 자료 및 유의점)
6. 판서 계획
7. 평가 계획 (평가 기준 상·중·하)`
    : `1. 학습 목표
2. 본시 학습 (표: 학습 단계 / 교수·학습 활동 / 시간 / 자료 및 유의점)
3. 평가 관점`;

  return `아래 조건으로 ${type.label}(${type.pages})을 작성해 주세요.

- 학년: ${v.grade}학년
- 교과: ${v.subject}
- 단원·주제: ${v.unit}
- 수업 시간: ${v.duration}분
- 수업모형: ${model.label} (${model.steps})
${v.goal ? `- 교사가 의도한 학습목표: ${v.goal}` : ""}

구성:
${structure}

본시 학습의 전개는 위 수업모형 단계를 따라 주세요.`;
}

export async function POST(request) {
  let svc;
  try { svc = serviceClient(); }
  catch { return json({ error: "service_unavailable" }, 503); }

  const who = await requireUser(request, svc);
  if (who.error) return json({ error: who.error }, who.status);

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
  const prompt = buildPrompt(body);

  // --- 견적 ---
  const est = preflight({
    model, promptText: SYSTEM + prompt, expectedOutTokens: type.maxOutTokens,
  });
  if (!est.ok) return json({ error: est.reason, estKrw: est.estKrw }, 400);

  // --- 예산 확인 + 예약 ---
  const budget = await checkBudget(svc, { userId: who.userId, estKrw: est.estKrw });
  if (!budget.allowed) {
    return json({
      error: budget.reason ?? "budget_exceeded",
      spentTodayKrw: budget.spentTodayKrw ?? null,
      dailyLimitKrw: BUDGET.dailyTotalKrw,
    }, 429);
  }

  // --- 생성 ---
  let out;
  try {
    out = await generate({
      model, system: SYSTEM, prompt, maxOutTokens: type.maxOutTokens,
    });
  } catch (e) {
    if (e instanceof AiKeyMissing) return json({ error: "ai_not_configured", model }, 503);
    return json({ error: "generation_failed" }, 502);
  }
  if (!out.text?.trim()) return json({ error: "empty_result" }, 502);

  // --- 실제 사용량 기록 ---
  // 실패해도 사용자 응답을 막지 않는다 — 돈은 이미 나갔고, 결과를 안 주면
  // 돈만 쓰고 아무것도 못 받는 셈이 된다. 대신 기록 실패를 응답에 표시한다.
  const rec = await recordUsage(svc, {
    userId: who.userId, model,
    inTokens: out.inTokens, outTokens: out.outTokens,
    purpose: body.planType === "full" ? "lesson_plan_full" : "lesson_plan_brief",
  });

  return json({
    planType: body.planType,
    modelLabel: MODELS[model].label,
    text: out.text,
    costKrw: rec.krw,
    accounted: rec.recorded,
    // AI 초안임을 응답에 박아 둔다. 화면이 이걸 빼먹어도 원본에 남는다.
    notice: "AI 가 만든 초안입니다. 반드시 직접 검토·수정해서 쓰세요.",
  }, 200);
}
