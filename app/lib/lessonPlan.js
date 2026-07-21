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
];

export const PLAN_TYPES = [
  {
    key: "brief", label: "약안", pages: "A4 1~2장",
    desc: "본시 전개 중심. 도입·전개·정리와 발문 위주",
    maxOutTokens: 2200,
  },
  {
    key: "full", label: "세안", pages: "A4 3~5장",
    desc: "단원 개관·학습자 실태·차시 계획·본시 전개·판서·평가까지",
    maxOutTokens: 4500,
  },
];

export const DURATIONS = [40, 80];  // 초등 1차시 40분, 블록수업 80분

/** 화면 입력을 서버로 보내기 전에 여기서 먼저 거른다. */
export function validatePlanInput(v) {
  if (!PLAN_TYPES.some((t) => t.key === v?.planType)) return "지도안 종류를 골라주세요.";
  if (!GRADES.includes(Number(v?.grade))) return "학년을 골라주세요.";
  if (!subjectsForGrade(Number(v.grade)).includes(v?.subject)) {
    return "그 학년에서 고를 수 없는 교과예요.";
  }
  if (!TEACHING_MODELS.some((m) => m.key === v?.model)) return "수업모형을 골라주세요.";
  if (!DURATIONS.includes(Number(v?.duration))) return "수업 시간을 골라주세요.";
  const unit = String(v?.unit ?? "").trim();
  if (unit.length < 2 || unit.length > 60) return "단원·주제를 2~60자로 적어주세요.";
  const goal = String(v?.goal ?? "").trim();
  if (goal.length > 200) return "학습목표는 200자 이내로 적어주세요.";
  return null;
}
