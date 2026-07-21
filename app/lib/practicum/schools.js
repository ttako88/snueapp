// 실습 협력학교 데이터 접근.
//
// 원본은 매 학기 학사공지에 올라오는 "교육실습 협력학교 배정 현황표"(hwp) 다.
// scripts/manual/parse-hwp-schools.mjs 로 뽑고 NEIS 로 보강해
// app/data/practicumSchools.json 에 넣어 둔다. 학기마다 갱신해야 한다.

import data from "../../data/practicumSchools.json";

export const PRACTICUM_SEMESTER = data._meta?.semester ?? null;
export const PRACTICUM_SUMMARY = data._summary ?? null;

/** 학교 목록 — 이름순. neisCode 가 없는 학교도 포함한다(정보는 부족해도 존재하므로). */
export const SCHOOLS = [...data.schools].sort((a, b) =>
  a.short.localeCompare(b.short, "ko"));

export function findSchool(shortName) {
  return SCHOOLS.find((s) => s.short === shortName) ?? null;
}

/** 급식 조회가 가능한 학교인지 — neisCode 가 있어야 한다. */
export const hasMeal = (s) => Boolean(s?.neisCode);

/**
 * 실습 5단계. design.md 10.1 절 표를 그대로 옮겼다.
 * 학년·학기로 지금 어떤 실습인지 판단하는 데 쓴다.
 */
export const PRACTICUM_STAGES = [
  { grade: 2, term: 1, name: "관찰실습", weeks: 1, credit: "P/F", hours: 40,
    focus: "학교 교육환경 실태 파악, 교사 활동·학생 관찰을 통한 교직 이해" },
  { grade: 2, term: 2, name: "참가실습", weeks: 2, credit: "1학점", hours: 80,
    focus: "교육활동 참여, 기초 수업 경험, 담임교사 역할 인식" },
  { grade: 3, term: 1, name: "수업실습", weeks: 2, credit: "1학점", hours: 80,
    focus: "교수·학습 원리 이해, 수업 설계·실행 능력 신장" },
  { grade: 3, term: 2, name: "운영실습", weeks: 2, credit: "1학점", hours: 80,
    focus: "수업 심화 + 학급경영(창의적 체험활동 포함), 교직실무" },
  { grade: 4, term: 1, name: "종합실습", weeks: 2, credit: "1학점", hours: 80,
    focus: "학교 교육활동 전반 이해, 창의적 수업 설계·실행" },
];

export function stageFor(grade, term) {
  return PRACTICUM_STAGES.find((s) => s.grade === grade && s.term === term) ?? null;
}

/**
 * 실습 전후 일정 흐름 (design.md 10.3).
 * 마지막 항목이 중요하다 — 설문을 안 내면 성적 조회가 막힌다.
 */
export const PRACTICUM_TIMELINE = [
  { step: "실습학교 예비소집", note: "제출서류를 이때 낸다" },
  { step: "사전교육 Ⅰ", note: "교무처 주관" },
  { step: "사전교육 Ⅱ", note: "학년별 지도교수" },
  { step: "실습 기간", note: "1~2주, 현장" },
  { step: "현장지도", note: "실습지도교수 방문" },
  { step: "사후지도", note: "학년별 지도교수" },
  { step: "실습 설문 제출", note: "⚠️ 미제출 시 성적 조회 불가", critical: true },
];

/**
 * 예비소집일에 내는 제출서류 (design.md 10.4).
 * 결핵검진은 결핵예방법에 따라 초등 실습생 필수라 빠뜨리면 실습을 못 간다.
 */
export const PRACTICUM_DOCUMENTS = [
  { name: "결핵검진 결과서", note: "결핵예방법상 초등 실습 대상자 필수", critical: true },
  { name: "실습생 신상카드", note: "학교 양식" },
  { name: "건강진단서", note: "학교에 따라 요구" },
];

/**
 * 실습 전 체크리스트 (design.md 21.3 실전 팁에서).
 * 앱이 실제로 도움이 되는 지점 — 선배들이 알려주는 것들이다.
 */
export const PRACTICUM_CHECKLIST = [
  { key: "tb", label: "결핵검진 받기", when: "실습 2~3주 전", critical: true },
  { key: "docs", label: "제출서류 챙기기", when: "예비소집일" },
  { key: "meal", label: "급식비 입금", when: "실습 전후", note: "행정실 계좌로 직접 입금한다" },
  { key: "timetable", label: "첫날 학년부장께 전체 시간표 받기", when: "실습 1일차",
    note: "지도교사·담임 시간표를 파악해 둔다" },
  { key: "names", label: "학생 이름·얼굴 익히기", when: "실습 1~2일차" },
  { key: "gift", label: "선물은 동료와 상의해 정하기", when: "실습 마지막 주",
    note: "⚠️ 청탁금지법(김영란법) 위반 소지가 있다. 금액·품목을 함께 정하는 편이 안전하다",
    critical: true },
  { key: "survey", label: "실습 설문 제출", when: "실습 후",
    note: "미제출 시 성적 조회가 막힌다", critical: true },
];

/** 실습 중 지켜야 할 것 (design.md 21.3). */
export const PRACTICUM_MANNERS = [
  "학생과 개인 연락처·SNS 교환 금지",
  "복장·흡연 규정은 학교 방침을 따른다",
  "출결이 성적에 직접 반영된다 — 결석이 전체 실습일수의 20%를 넘으면 이수 불가",
];
