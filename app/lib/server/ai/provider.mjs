// ============================================================
// provider.mjs — AI 공급자 추상화 (서버 전용)
// ============================================================
// 왜 추상화하나
//   가격 차이가 작아서(약안 1건 실측 ₩5 수준) 가격이 선택 기준이 못 된다.
//   실제 기준은 한국어·교육과정 용어 정확도인데 그건 써 봐야 안다.
//   그래서 갈아끼울 수 있게 만들어 둔다.
//
//   중국계 API 는 절감액이 회당 ₩10 안팎인데 입력이 국외로 나가고
//   교육과정 용어 정확도가 미검증이라 기본 후보에서 뺐다.
//
// ⚠️ 모델명은 추측하지 말고 실제로 호출해 확인한다. /v1beta/models 목록에
//    있어도 "신규 사용자에게는 제공 안 됨" 으로 404 가 나는 모델이 있다.
//    실측(2026-07-22) 결과 이 계정에서는 `-latest` 별칭만 호출된다.
//
// 키가 없으면 명확히 그렇게 말한다. 조용히 빈 결과를 주지 않는다.
// ============================================================
import { MODELS } from "./budget.mjs";

if (typeof window !== "undefined") {
  throw new Error("ai/provider.mjs 는 서버 전용입니다");
}

/** 어떤 공급자를 쓸 수 있는지 — 키 존재 여부만 본다. 값은 읽지 않는다. */
export function availableProviders(env = process.env) {
  const gemini = Boolean(env.GEMINI_API_KEY);
  return {
    "gemini-flash-latest": gemini,
    "gemini-flash-lite-latest": gemini,
    "gemini-pro-latest": gemini,
    "claude-haiku-4-5": Boolean(env.ANTHROPIC_API_KEY),
    "gpt-5-mini": Boolean(env.OPENAI_API_KEY),
  };
}

export class AiKeyMissing extends Error {
  constructor(model) {
    super(`AI 키 없음: ${model}`);
    this.name = "AiKeyMissing";
    this.model = model;
  }
}

/**
 * 공통 호출 인터페이스.
 * @returns {{ text: string, inTokens: number, outTokens: number }}
 */
export async function generate(
  { model, system, prompt, maxOutTokens = 4000, thinkBudget = null },
  env = process.env,
) {
  if (!MODELS[model]) throw new Error(`알 수 없는 모델: ${model}`);

  if (model.startsWith("gemini-")) {
    const key = env.GEMINI_API_KEY;
    if (!key) throw new AiKeyMissing(model);
    // 키를 URL 쿼리가 아니라 헤더로 보낸다 — 쿼리에 넣으면 접근 로그·프록시·
    // 리퍼러에 키가 남는다. 구글은 두 방식을 다 받는다.
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: maxOutTokens, temperature: 0.4,
            // 생각 토큰 상한. 지정하면 생각이 줄어 원가가 내려가지만 품질이
            // 같이 내려가는지는 **실측 전까지 모른다** — A/B 로만 판단한다.
            // ⚠️ 이 모델은 thinkingBudget:0 을 400 으로 거부한다(실측 07-22).
            //    "생각 끄기" 는 선택지가 아니다.
            ...(thinkBudget ? { thinkingConfig: { thinkingBudget: thinkBudget } } : {}),
          },
        }),
      });
    if (!res.ok) {
      // 상태코드만으로는 원인을 못 찾는다(404 가 모델명 오타인지 권한인지).
      // 응답 본문의 message 만 붙인다 — 키는 본문에 없다.
      const t = await res.text().catch(() => "");
      let msg = "";
      try { msg = JSON.parse(t)?.error?.message ?? ""; } catch { msg = t.slice(0, 120); }
      throw new Error(`gemini ${res.status}${msg ? `: ${msg}` : ""}`);
    }
    const j = await res.json();
    const u = j?.usageMetadata ?? {};
    // ⚠️ 추론 모델은 **생각 토큰(thoughtsTokenCount)도 출력으로 과금된다.**
    //   `candidatesTokenCount` 만 세면 실제보다 싸게 계산되고, 그만큼
    //   일일 상한이 조용히 샌다 — budget.mjs 가 보장한다고 적어 둔 불변식이
    //   깨진다. 실측(2026-07-22, gemini-3.6-flash): 생각 1,352 / 본문 844.
    //   **청구 기준 출력 = 생각 + 본문** 이다.
    const thinkTokens = u.thoughtsTokenCount ?? 0;
    const bodyTokens = u.candidatesTokenCount ?? 0;
    return {
      text: j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "",
      inTokens: u.promptTokenCount ?? 0,
      outTokens: thinkTokens + bodyTokens,
      thinkTokens,
      bodyTokens,
      // MAX_TOKENS 면 본문이 문장 중간에서 잘렸다는 뜻이다. 호출부가 이걸 보고
      // 사용자에게 알리거나 재시도할 수 있어야 한다 — 잘린 지도안을 완성본인
      // 것처럼 건네지 않는다.
      truncated: j?.candidates?.[0]?.finishReason === "MAX_TOKENS",
      // 별칭이 실제로 어떤 모델을 가리켰는지 기록한다. 별칭이 옮겨가면
      // 단가·품질이 조용히 바뀌므로 이 값이 달라지는 것을 신호로 삼는다.
      resolvedModel: j?.modelVersion ?? null,
    };
  }

  if (model === "claude-haiku-4-5") {
    const key = env.ANTHROPIC_API_KEY;
    if (!key) throw new AiKeyMissing(model);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: maxOutTokens,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}`);
    const j = await res.json();
    return {
      text: (j?.content ?? []).map((b) => b.text ?? "").join(""),
      inTokens: j?.usage?.input_tokens ?? 0,
      outTokens: j?.usage?.output_tokens ?? 0,
    };
  }

  if (model === "gpt-5-mini") {
    const key = env.OPENAI_API_KEY;
    if (!key) throw new AiKeyMissing(model);
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "gpt-5-mini",
        max_completion_tokens: maxOutTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}`);
    const j = await res.json();
    return {
      text: j?.choices?.[0]?.message?.content ?? "",
      inTokens: j?.usage?.prompt_tokens ?? 0,
      outTokens: j?.usage?.completion_tokens ?? 0,
    };
  }

  throw new Error(`공급자 미구현: ${model}`);
}
