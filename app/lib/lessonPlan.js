// 수업지도안(약안·세안) 생성 옵션.
//
// 이 파일은 화면과 서버가 함께 쓴다 — 선택지가 두 곳에 따로 있으면
// 화면에서 고를 수 있는데 서버가 거부하는 상태가 생긴다.
//
// ⚠️ 성취기준 데이터는 아직 없다. 2022 개정 교육과정 과목별 내용체계를
//    구조화하는 작업이 진행 중이고, 그게 들어와야 "성취기준 코드로 근거를
//    다는" 단계가 된다. 지금은 교과·학년·단원을 사람이 적는다.

export const SUBJECTS = [
  "국어", "수학", "사회", "과학", "영어", "도덕",
  "체육", "음악", "미술", "실과", "통합", "창의적체험활동",
];

export const GRADES = [1, 2, 3, 4, 5, 6];

/** 1~2학년은 통합교과라 교과 목록이 다르다. 고르면 안 되는 조합을 막는다. */
export function subjectsForGrade(grade) {
  if (grade === 1 || grade === 2) {
    return ["국어", "수학", "통합", "창의적체험활동"];
  }
  return SUBJECTS.filter((s) => s !== "통합");
}

/**
 * 수업모형. 초등에서 실제로 쓰는 것들이고, 각 모형의 단계가 지도안의
 * "전개" 구조를 결정한다 — 모형을 고르면 전개 틀이 따라온다.
 */
export const TEACHING_MODELS = [
  { key: "direct", label: "직접교수", steps: "설명 → 시범 → 안내된 연습 → 독립된 연습" },
  { key: "inquiry", label: "탐구학습", steps: "문제 인식 → 가설 설정 → 탐구 설계 → 자료 해석 → 결론" },
  { key: "cooperative", label: "협동학습", steps: "과제 제시 → 모둠 활동 → 발표 공유 → 정리" },
  { key: "problem", label: "문제해결", steps: "문제 확인 → 해결 계획 → 실행 → 검토" },
  { key: "discussion", label: "토의토론", steps: "논제 파악 → 입장 정리 → 토의 → 합의·정리" },
  { key: "play", label: "놀이중심", steps: "놀이 안내 → 탐색 → 놀이 → 나누기 (저학년)" },
  { key: "response", label: "반응중심", steps: "텍스트 만나기 → 반응 형성 → 반응 명료화 → 반응 심화 (문학)" },
  { key: "value", label: "가치갈등", steps: "갈등 상황 제시 → 입장 선택 → 근거 토론 → 가치 명료화 (도덕)" },
  // 아래 둘은 자료 수집 목록에는 있었는데 여기 없어서 어긋났다.
  // 계약(docs/LESSON_DATA_CONTRACT.md §6)상 이 파일이 원본이므로 여기에 맞춘다.
  { key: "project", label: "프로젝트", steps: "주제 정하기 → 계획 → 탐구·제작 → 발표 → 성찰 (여러 차시)" },
  { key: "concept", label: "개념형성", steps: "사례 제시 → 속성 찾기 → 개념 정의 → 적용·확인" },
];

// ⚠️ maxOutTokens 는 **생각 토큰 + 본문 토큰**을 합쳐서 묶는 한도다.
//   추론 모델(gemini-3.6-flash)은 생각에만 800~1,600 토큰을 쓴다.
//   처음에 본문 기준으로만 잡았다가 10건 전부 문장 중간에서 잘렸다
//   (finishReason=MAX_TOKENS). 본문 목표치에 생각 몫을 더해서 잡는다.
//
//   실측(2026-07-22)
//     프롬프트 v1: 생각 1,332~1,739
//     프롬프트 v2: 생각 1,715~2,508  ← 제약을 조일수록 **생각이 늘어난다**
//   v2 로 10건 뽑았더니 여유분 2,000 으로는 3건이 잘렸다. 프롬프트를 고치면
//   생각량도 같이 변하므로, 여유분은 관측 최대치(2,508)에 마진을 얹어 잡는다.
//   ⚠️ 프롬프트를 바꾸면 이 값을 다시 실측할 것. 생각량은 프롬프트에 딸린다.
const THINK_HEADROOM = 3200;

export const PLAN_TYPES = [
  {
    key: "brief", label: "약안", pages: "A4 1~2장",
    desc: "본시 전개 중심. 도입·전개·정리와 발문 위주",
    bodyTokens: 2200,
    maxOutTokens: 2200 + THINK_HEADROOM,
  },
  {
    key: "full", label: "세안", pages: "A4 3~5장",
    desc: "단원 개관·학습자 실태·차시 계획·본시 전개·판서·평가까지",
    bodyTokens: 4500,
    maxOutTokens: 4500 + THINK_HEADROOM,
  },
];

export const DURATIONS = [40, 80];  // 초등 1차시 40분, 블록수업 80분

// ── 옵션 2단계 ──────────────────────────────────────────────
// 옵션이 많으면 아무도 안 쓰고, 적으면 품질이 안 나온다. 그래서 나눈다.
//   1단계(필수 4개)  — 이것만 채우면 바로 생성된다. "딸깍" 이 성립하는 지점.
//   2단계(선택, 접힘) — 채우면 좋아지지만 없어도 된다.
//
// 수업모형을 필수에서 뺀 이유: 교생이 처음 쓸 때 8개 모형 중 뭘 골라야 할지
// 모른다. 고르라고 강요하면 거기서 멈춘다. 교과·학년으로 기본값을 추천하고,
// 아는 사람만 바꾸게 한다.
export const REQUIRED_FIELDS = ["grade", "subject", "unit", "duration"];

/** 선택 항목별 글자 수 상한. 프롬프트에 그대로 들어가므로 상한이 필요하다. */
export const OPTIONAL_LIMITS = {
  goal: 200,        // 교사가 의도한 학습목표
  learners: 200,    // 학습자 특성 (수준차·분위기 등)
  focus: 150,       // 중점을 둘 활동
  materials: 150,   // 교실에서 쓸 수 있는 기자재
  evaluation: 150,  // 평가 방식
  request: 300,     // 지도교사 요구사항 (자유입력)
};

const OPTIONAL_LABELS = {
  goal: "학습목표", learners: "학습자 특성", focus: "중점 활동",
  materials: "기자재", evaluation: "평가 방식", request: "지도교사 요구사항",
};

/**
 * 교과·학년으로 수업모형 기본값을 고른다.
 * 사용자가 안 고르면 이게 쓰인다 — 아무거나 넣지 않고 교과 관행을 따른다.
 */
export function defaultModelFor(subject, grade) {
  if (subject === "도덕") return "value";
  if (subject === "과학") return "inquiry";
  if (subject === "통합" || Number(grade) <= 2) return "play";
  if (subject === "미술" || subject === "음악" || subject === "체육") return "cooperative";
  if (subject === "실과") return "problem";
  return "direct";   // 국어·수학·사회·영어의 기본
}

/** 화면 입력을 서버로 보내기 전에 여기서 먼저 거른다. */
export function validatePlanInput(v) {
  if (!PLAN_TYPES.some((t) => t.key === v?.planType)) return "지도안 종류를 골라주세요.";
  if (!GRADES.includes(Number(v?.grade))) return "학년을 골라주세요.";
  if (!subjectsForGrade(Number(v.grade)).includes(v?.subject)) {
    return "그 학년에서 고를 수 없는 교과예요.";
  }
  if (!DURATIONS.includes(Number(v?.duration))) return "수업 시간을 골라주세요.";
  const unit = String(v?.unit ?? "").trim();
  if (unit.length < 2 || unit.length > 60) return "단원·주제를 2~60자로 적어주세요.";

  // 실제 교과서 목록에서 고른 경우에만 들어오는 선택 키다. 서버에서도
  // 형식을 확인해 임의 문자열이 근거 필터를 바꾸지 못하게 한다. 빈 값은
  // 자유 입력과 기존 v1 요청의 하위 호환을 위해 허용한다.
  const textbookId = String(v?.textbookId ?? "").trim();
  if (textbookId && !/^[a-z0-9][a-z0-9-]{2,119}$/.test(textbookId)) {
    return "교과서 선택 정보를 다시 골라주세요.";
  }

  // 수업모형은 선택이다. 다만 **값이 왔다면** 아는 값이어야 한다 —
  // 모르는 값을 조용히 기본값으로 바꾸면 사용자가 고른 것과 다른 게 나온다.
  if (v?.model && !TEACHING_MODELS.some((m) => m.key === v.model)) {
    return "수업모형을 다시 골라주세요.";
  }

  for (const [k, max] of Object.entries(OPTIONAL_LIMITS)) {
    const s = String(v?.[k] ?? "").trim();
    if (s.length > max) return `${OPTIONAL_LABELS[k]}은(는) ${max}자 이내로 적어주세요.`;
  }
  return null;
}

/** 검증을 통과한 입력에 기본값을 채워 넣는다. 서버·화면이 같은 결과를 쓰도록. */
export function withDefaults(v) {
  return {
    ...v,
    textbookId: String(v?.textbookId ?? "").trim(),
    model: v.model || defaultModelFor(v.subject, v.grade),
  };
}
