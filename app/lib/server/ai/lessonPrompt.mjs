// ============================================================
// lessonPrompt.mjs — 지도안 프롬프트 조립 (서버 전용, 단일 출처)
// ============================================================
// 왜 따로 뺐나
//   프롬프트가 route.js 와 gen-lesson-samples.mjs 에 **각각 복사돼** 있었다.
//   샘플로 품질을 튜닝해도 실제 앱에는 반영되지 않는 구조였고, 한쪽만
//   고치면 조용히 어긋난다. 품질 개선의 단일 출처를 여기로 만든다.
//
// 버전을 두는 이유
//   프롬프트 개선은 "좋아진 것 같다" 로는 판정할 수 없다. 같은 조건으로
//   양쪽을 돌려 비교해야 한다. `--prompt v2` 로 갈아끼울 수 있게 한다.
//
// 데이터 주입
//   app/data/lessonPrompt/ 의 CSV 가 있으면 근거로 끼워 넣는다.
//   **없어도 동작한다** — 있으면 품질이 올라가는 구조지 전제조건이 아니다.
// ============================================================
import { PLAN_TYPES, TEACHING_MODELS } from "../../lessonPlan.js";

if (typeof window !== "undefined") {
  throw new Error("lessonPrompt.mjs 는 서버 전용입니다");
}

export const PROMPT_VERSIONS = ["v1", "v2", "v3"];

// 기본판을 v2 로 둔다 — 근거는 A/B 실측(2026-07-22, 10건 × 3조건).
//   · 단계별 시간 표기: v1 은 1~9 개로 들쭉날쭉, v2 는 6~10 개로 일정
//   · 원가는 25% 비싸다 (₩17.6 → ₩22.0). 비싼 이유가 "생각을 더 한다" 이고
//     그 값이 일관성으로 나오므로 낼 만하다고 판단했다.
// 되돌리려면 이 줄을 "v1" 로 바꾸거나 LESSON_PROMPT_VERSION=v1 을 넣으면 된다.
export const DEFAULT_PROMPT_VERSION = process.env.LESSON_PROMPT_VERSION ?? "v2";

// ── 시스템 프롬프트 ─────────────────────────────────────────
const SYSTEM_V1 = `당신은 대한민국 초등학교 교사입니다. 2022 개정 교육과정에 따라
초등 수업지도안을 작성합니다.

지켜야 할 것:
- 초등학생 발달 수준에 맞는 표현을 씁니다. 중·고등학교 수업이 아닙니다.
- 발문(교사의 질문)은 실제로 교실에서 말하는 문장으로 씁니다.
- 활동은 주어진 수업 시간 안에 실제로 끝날 수 있는 분량으로 합니다.
- 성취기준 코드를 지어내지 않습니다. 정확히 모르면 코드를 쓰지 말고
  학습목표만 서술합니다.
- 학생 개인정보나 실명을 만들어 넣지 않습니다.
- 표는 마크다운 표로 씁니다.`;

// v2 는 "교생이 지도교사에게 실제로 지적받는 것" 을 제약으로 옮긴 판이다.
// 추측이 아니라 검증 대상이다 — v1 과 나란히 뽑아 비교한다.
const SYSTEM_V2 = `당신은 대한민국 초등학교 교사입니다. 2022 개정 교육과정에 따라
교육실습생이 제출할 수업지도안을 작성합니다.

지켜야 할 것:
- 초등학생 발달 수준에 맞는 표현을 씁니다. 중·고등학교 수업이 아닙니다.
- 발문은 **교사가 실제로 입 밖에 내는 문장 그대로** 씁니다.
  ("~에 대해 발문한다" 처럼 요약하지 않습니다.)
- 시간 배분을 분 단위로 적고, **합이 주어진 수업 시간과 정확히 맞아야** 합니다.
- 활동은 그 시간 안에 실제로 끝나야 합니다. 초등학생은 준비·이동·정리에
  시간이 걸립니다. 활동을 욕심내지 않습니다.
- 학생의 예상 반응을 적을 때는 **틀린 반응도 함께** 적고, 교사가 어떻게
  되돌릴지 씁니다. 모범답안만 나열하지 않습니다.
- 성취기준 코드는 **주어진 근거에 있는 것만** 씁니다. 근거에 없으면 코드를
  쓰지 말고 학습목표만 서술합니다. 코드를 지어내는 것이 가장 큰 감점입니다.
- 평가는 활동과 이어져야 합니다. 수업에서 하지 않은 것을 평가하지 않습니다.
- 학생 개인정보나 실명을 만들어 넣지 않습니다.
- 표는 마크다운 표로 씁니다.`;

// v3 = v2 에서 "틀린 반응" 요구만 손본 판이다.
//   문제: v2 에서 그 제약은 8개 bullet 중 하나로 묻혀 10건 중 3건만 지켜졌다.
//   가설: 소프트한 문장 지시로는 약하다. **구체적 표기 규약**으로 못박으면
//         본시 학습 표에서 물리적으로 자리를 차지하므로 지켜질 확률이 오른다.
//   그래서 "예상 반응을 ○/✗ 두 줄로 쪼개고 오답 뒤에 되돌리기 발문" 을 형식으로
//   지정한다. 단, **억지 오답 방지** — 오답이 없는 발문엔 넣지 말라고 함께 건다
//   (근거 없는 것을 지어내지 않는 이 프로젝트의 규율과 같은 방향).
//   추측이 아니라 v2 와 나란히 뽑아 "오답+되돌리기" 출현율로 판정한다.
const SYSTEM_V3 = `당신은 대한민국 초등학교 교사입니다. 2022 개정 교육과정에 따라
교육실습생이 제출할 수업지도안을 작성합니다.

지켜야 할 것:
- 초등학생 발달 수준에 맞는 표현을 씁니다. 중·고등학교 수업이 아닙니다.
- 발문은 **교사가 실제로 입 밖에 내는 문장 그대로** 씁니다.
  ("~에 대해 발문한다" 처럼 요약하지 않습니다.)
- 시간 배분을 분 단위로 적고, **합이 주어진 수업 시간과 정확히 맞아야** 합니다.
- 활동은 그 시간 안에 실제로 끝나야 합니다. 초등학생은 준비·이동·정리에
  시간이 걸립니다. 활동을 욕심내지 않습니다.
- 본시 학습 표의 **전개 단계**에서, 핵심 발문에는 학생의 예상 반응을 아래
  형식으로 두 줄로 나눠 적습니다.
    ○ 예상 반응: (학생이 흔히 하는 옳은 답)
    ✗ 자주 나오는 오답: (실제로 자주 나오는 틀린 답) → 되돌리기: (교사가 어떻게
      다시 물어 바로잡는지, 실제 발문 문장으로)
  모범답안만 나열하지 않습니다. 다만 **오답이 잘 없는 단순 발문에는 억지로
  만들지 않습니다** — 없는 오답을 지어내는 것도 감점입니다.
- 성취기준 코드는 **주어진 근거에 있는 것만** 씁니다. 근거에 없으면 코드를
  쓰지 말고 학습목표만 서술합니다. 코드를 지어내는 것이 가장 큰 감점입니다.
- 평가는 활동과 이어져야 합니다. 수업에서 하지 않은 것을 평가하지 않습니다.
- 학생 개인정보나 실명을 만들어 넣지 않습니다.
- 표는 마크다운 표로 씁니다.`;

const SYSTEMS = { v1: SYSTEM_V1, v2: SYSTEM_V2, v3: SYSTEM_V3 };

// ── 본문 구조 ───────────────────────────────────────────────
const STRUCTURE = {
  full: `1. 단원 개관
2. 단원 학습 목표
3. 학습자 실태 (일반적인 수준으로)
4. 차시별 지도 계획 (표)
5. 본시 학습 (표: 학습 단계 / 교수·학습 활동 / 시간 / 자료 및 유의점)
6. 판서 계획
7. 평가 계획 (평가 기준 상·중·하)`,
  brief: `1. 학습 목표
2. 본시 학습 (표: 학습 단계 / 교수·학습 활동 / 시간 / 자료 및 유의점)
3. 평가 관점`,
};

// ── 근거 블록 (데이터가 있을 때만) ──────────────────────────
/**
 * CSV 에서 온 근거를 프롬프트에 끼울 텍스트로 만든다.
 * 데이터가 없으면 **빈 문자열** — 그러면 v1 과 같은 프롬프트가 된다.
 */
export function buildEvidence(v, data) {
  if (!data || data.empty) return "";
  const lines = [];

  // 1) 해당 학년·교과·단원의 차시 정보
  const units = (data.units ?? []).filter(
    (u) => u.subject === v.subject && u.grade === Number(v.grade)
      && (v.unit ?? "").includes(u.unit));
  if (units.length) {
    const u0 = units[0];
    lines.push(`## 교과서 단원 정보 (${u0.publisher})`);
    lines.push(`${u0.grade}학년 ${u0.term}학기 ${u0.unitNo}단원 「${u0.unit}」 · 총 ${u0.totalPeriods}차시`);
    lines.push("");
    lines.push("| 차시 | 학습 내용 |");
    lines.push("|---|---|");
    for (const u of units.slice(0, 12)) lines.push(`| ${u.periodNo} | ${u.period} |`);
    lines.push("");
  }

  // 2) 성취기준 — **지어내기를 막는 것이 핵심 목적**이다
  const codes = new Set(units.flatMap((u) => u.codes));
  const stds = [...codes].map((c) => data.standards?.get(c)).filter(Boolean);
  if (stds.length) {
    lines.push("## 관련 성취기준 (이 목록에 없는 코드는 쓰지 마세요)");
    for (const s of stds) lines.push(`- ${s.code} ${s.text}`);
    lines.push("");

    // 3) 평가기준
    const rubs = stds.flatMap((s) => (data.rubrics?.get(s.code) ?? []).map((r) => ({ ...r, code: s.code })));
    if (rubs.length) {
      lines.push("## 평가 기준 참고");
      lines.push("| 성취기준 | 평가요소 | 상 | 중 | 하 |");
      lines.push("|---|---|---|---|---|");
      for (const r of rubs.slice(0, 6)) {
        lines.push(`| ${r.code} | ${r.element} | ${r.high} | ${r.mid} | ${r.low} |`);
      }
      lines.push("");
    }
  }

  // 4) 수업모형 전개 — 실제 교사 발화
  const steps = data.modelSteps?.get(v.model) ?? [];
  if (steps.length) {
    const m = TEACHING_MODELS.find((x) => x.key === v.model);
    lines.push(`## ${m?.label ?? v.model} 모형 단계별 교사 발화 예시`);
    lines.push("(실제 지도안에서 뽑은 문장입니다. 말투를 참고하세요.)");
    for (const s of steps.slice(0, 12)) {
      lines.push(`- **${s.name}**${s.ratio ? ` (약 ${s.ratio}%)` : ""}: "${s.utterance}"`);
    }
    lines.push("");
  }

  if (!lines.length) return "";
  return `\n\n---\n# 참고 자료\n아래는 확인된 자료입니다. 이 범위 안에서 작성해 주세요.\n\n${lines.join("\n")}`;
}

// ── 조립 ────────────────────────────────────────────────────
/**
 * @param {object} v      화면 입력 (validatePlanInput 통과분)
 * @param {object} opts   { version, data }
 * @returns {{ system: string, prompt: string, version: string, hasEvidence: boolean }}
 */
export function buildLessonPrompt(v, { version = DEFAULT_PROMPT_VERSION, data = null } = {}) {
  const ver = SYSTEMS[version] ? version : "v1";
  const type = PLAN_TYPES.find((t) => t.key === v.planType);
  const model = TEACHING_MODELS.find((m) => m.key === v.model);
  if (!type) throw new Error(`알 수 없는 지도안 종류: ${v.planType}`);
  if (!model) throw new Error(`알 수 없는 수업모형: ${v.model}`);

  const evidence = buildEvidence(v, data);

  const head = [
    `아래 조건으로 ${type.label}(${type.pages})을 작성해 주세요.`,
    "",
    `- 학년: ${v.grade}학년`,
    `- 교과: ${v.subject}`,
    `- 단원·주제: ${v.unit}`,
    `- 수업 시간: ${v.duration}분`,
    `- 수업모형: ${model.label} (${model.steps})`,
  ];
  // 선택 옵션들. 없으면 줄 자체를 넣지 않는다 — 빈 항목을 보여 주면
  // 모델이 "해당 없음" 같은 군더더기를 만들어 낸다.
  if (v.goal) head.push(`- 교사가 의도한 학습목표: ${v.goal}`);
  if (v.learners) head.push(`- 학습자 특성: ${v.learners}`);
  if (v.focus) head.push(`- 중점을 둘 활동: ${v.focus}`);
  if (v.materials) head.push(`- 교실에서 쓸 수 있는 것: ${v.materials}`);
  if (v.evaluation) head.push(`- 평가 방식: ${v.evaluation}`);
  if (v.request) head.push(`- 지도교사 요구사항: ${v.request}`);

  const tail = [
    "",
    "구성:",
    STRUCTURE[v.planType] ?? STRUCTURE.brief,
    "",
    "본시 학습의 전개는 위 수업모형 단계를 따라 주세요.",
  ];

  return {
    system: SYSTEMS[ver],
    prompt: head.join("\n") + "\n" + tail.join("\n") + evidence,
    version: ver,
    hasEvidence: Boolean(evidence),
  };
}
