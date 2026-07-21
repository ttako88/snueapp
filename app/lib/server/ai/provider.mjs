// ============================================================
// provider.mjs — AI 공급자 추상화 (서버 전용)
// ============================================================
// 왜 추상화하나
//   가격 조사 결과 세안 1건 원가가 Gemini 3 Flash ₩20 / Claude Haiku ₩35 /
//   GPT-5 mini ₩13 로, **최저가와 최고가 차이가 ₩70 이 안 된다.**
//   즉 가격이 선택 기준이 못 되고, 실제 기준은 한국어·교육과정 용어 정확도다.
//   그건 써 봐야 아는 것이라 갈아끼울 수 있게 만들어 둔다.
//
//   중국계 API(DeepSeek ₩2.5 등)는 절감액이 회당 ₩10~30 뿐인데 입력 데이터가
//   국외로 나가고 교육과정 용어 정확도가 미검증이라 기본 후보에서 뺐다.
//
// 키가 없으면 명확히 그렇게 말한다. 조용히 빈 결과를 주지 않는다.
// ============================================================
import { MODELS } from "./budget.mjs";

if (typeof window !== "undefined") {
  throw new Error("ai/provider.mjs 는 서버 전용입니다");
}

/** 어떤 공급자를 쓸 수 있는지 — 키 존재 여부만 본다. 값은 읽지 않는다. */
export function availableProviders(env = process.env) {
  return {
    "gemini-3-flash": Boolean(env.GEMINI_API_KEY),
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
export async function generate({ model, system, prompt, maxOutTokens = 4000 }, env = process.env) {
  if (!MODELS[model]) throw new Error(`알 수 없는 모델: ${model}`);

  if (model === "gemini-3-flash") {
    const key = env.GEMINI_API_KEY;
    if (!key) throw new AiKeyMissing(model);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxOutTokens, temperature: 0.4 },
        }),
      });
    if (!res.ok) throw new Error(`gemini ${res.status}`);
    const j = await res.json();
    return {
      text: j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "",
      inTokens: j?.usageMetadata?.promptTokenCount ?? 0,
      outTokens: j?.usageMetadata?.candidatesTokenCount ?? 0,
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
