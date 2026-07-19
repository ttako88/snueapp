// 시간표 공용 도구 (상수·색·자동채움·그룹핑 로직). 데이터는 파싱해둔 JSON에서.
import COURSES from "../data/courses.json";

export const ALL_COURSES = COURSES;
export const DAYS = ["월", "화", "수", "목", "금"];

// 보유한 학기 데이터 (파싱된 강의시간표 4개 학기분)
export const SEMESTERS = ["2025-1", "2025-2", "2026-1", "2026-2"];
export const SEMESTER_LABELS = {
  "2025-1": "2025년 1학기",
  "2025-2": "2025년 2학기",
  "2026-1": "2026년 1학기",
  "2026-2": "2026년 2학기",
};
export const DEFAULT_SEMESTER = "2026-2"; // 이번 학기(가장 최신 데이터)

// 교시별 시각 (서울교대: 50분 수업+10분 쉬는시간, 4교시 후 점심 40분)
export const PERIOD_TIMES = [
  { p: 1, start: "09:00", end: "09:50" },
  { p: 2, start: "10:00", end: "10:50" },
  { p: 3, start: "11:00", end: "11:50" },
  { p: 4, start: "12:00", end: "12:50" },
  { p: 5, start: "13:30", end: "14:20" },
  { p: 6, start: "14:30", end: "15:20" },
  { p: 7, start: "15:30", end: "16:20" },
  { p: 8, start: "16:30", end: "17:20" },
];

// 심화과정 13개 → 군(A/B) 자동 결정
export const DEPARTMENTS = [
  { name: "윤리", group: "A" },
  { name: "국어", group: "A" },
  { name: "사회", group: "A" },
  { name: "수학", group: "A" },
  { name: "과학", group: "A" },
  { name: "체육", group: "A" },
  { name: "음악", group: "B" },
  { name: "미술", group: "B" },
  { name: "생활과학", group: "B" },
  { name: "교육", group: "B" },
  { name: "영어", group: "B" },
  { name: "컴퓨터", group: "B" },
  { name: "유아특수", group: "B" },
];
export function groupOf(dept) {
  const d = DEPARTMENTS.find((x) => x.name === dept);
  return d ? d.group : "A";
}

// 강의 하나를 식별하는 안정적 키 (학기 포함 — 같은 강의가 매 학기 반복 개설되므로 필수)
export const courseId = (c) =>
  `${c.semester}|${c.grade}${c.group}|${c.name}|${c.section}|${c.day}${c.periods.join("")}`;

// 자동 채움: 내 학년+심화과정+학기의 전공·심화·교직 + 학년 공통필수(교양 제외).
// reqGroup은 2026 공식 교육과정 정답표 기준(파싱 단계에서 과목명→요건 매핑).
// 채움 규칙:
//  ① 유닛 = 같은 reqGroup(택1 요건) 또는 같은 과목명(분반 묶음) — 유닛당 1강좌만.
//     (분반이 여러 개인 필수과목이 통째로 들어가던 문제도 이걸로 함께 해결)
//  ② 심화자유선택(SF:*)은 자동채움에서 제외 — 전 학과 공용 풀이라 본인이 고르는 과목.
//  ③ 배치 순서: 필수(이름 1종) 유닛 먼저 자리 확보 → 택1 유닛은 빈 시간에 맞는
//     멤버를 고름(충돌 회피). 남는 극소수 겹침은 원본 시간표 자체의 실제 중복임.
//  ④ 마지막으로 "공통"과 "특정학과"가 우연히 겹치면 특정학과 쪽을 남기고 공통 제외.
export function autofillCourses(grade, dept, semester = DEFAULT_SEMESTER) {
  const g = groupOf(dept);
  const raw = ALL_COURSES.filter(
    (c) =>
      c.semester === semester &&
      c.grade === grade &&
      c.type !== "교양" &&
      !(c.reqGroup && c.reqGroup.startsWith("SF:")) &&
      (c.dept === dept || (c.dept === "공통" && c.group === g))
  );
  // ① 유닛으로 묶기
  const units = new Map();
  for (const c of raw) {
    const k = c.reqGroup || "n:" + c.name;
    if (!units.has(k)) units.set(k, []);
    units.get(k).push(c);
  }
  // ③ 필수(단일 과목명) 유닛 먼저, 택1 유닛은 빈자리에 맞는 멤버 선택
  const occ = new Set();
  const fits = (c) => c.periods.every((p) => !occ.has(c.day + p));
  const isSingle = (ms) => new Set(ms.map((m) => m.name)).size === 1;
  const ordered = [...units.values()].sort((a, b) => (isSingle(a) ? 0 : 1) - (isSingle(b) ? 0 : 1));
  let result = [];
  for (const ms of ordered) {
    const pick = ms.find(fits) || ms[0];
    for (const p of pick.periods) occ.add(pick.day + p);
    result.push(pick);
  }
  // ④ "공통"과 "특정학과"가 우연히 시간이 겹치면 특정학과 쪽을 남기고 공통 쪽 제외
  const slotMap = new Map();
  for (const c of result) {
    for (const p of c.periods) {
      const slot = c.day + p;
      if (!slotMap.has(slot)) slotMap.set(slot, []);
      slotMap.get(slot).push(c);
    }
  }
  const excluded = new Set();
  for (const list of slotMap.values()) {
    if (list.length < 2) continue;
    if (new Set(list.map((c) => c.name)).size < 2) continue; // 같은 과목 다른 분반은 충돌 아님
    const hasCommon = list.some((c) => c.dept === "공통");
    const hasSpecific = list.some((c) => c.dept !== "공통");
    if (hasCommon && hasSpecific) {
      for (const c of list) if (c.dept === "공통") excluded.add(c);
    }
  }
  if (excluded.size) result = result.filter((c) => !excluded.has(c));
  return result;
}

// ── 시간표 셋업 저장/불러오기 (localStorage 공용 헬퍼) ──
// 강의 탭의 시간표 위젯과 설정 페이지가 같은 로직을 쓰도록 여기 한 곳에 모아둠.
export function loadTimetableSetup() {
  try {
    return JSON.parse(localStorage.getItem("ttSetup") || "null");
  } catch {
    return null;
  }
}
export function saveTimetableSetup(grade, dept, semester) {
  const setup = { grade, dept, semester };
  localStorage.setItem("ttSetup", JSON.stringify(setup));
  localStorage.setItem("ttCourses", JSON.stringify(autofillCourses(grade, dept, semester)));
  return setup;
}

// 두 강의가 시간이 겹치는지
export function conflicts(a, b) {
  if (a.day !== b.day) return false;
  return a.periods.some((p) => b.periods.includes(p));
}

// ── 이수요건(택1) 그룹핑 ──
// 학교 원본 엑셀의 셀 배경색으로 "이 강의들 중 하나만 들으면 됨"을 표시해둔 걸
// 파싱 단계에서 reqGroup(같은 색+"택1" 표시)으로 뽑아뒀음. 같은 reqGroup이면
// 이름이 달라도(예: 운동과웰니스 ↔ 운동과건강디자인) 사실상 같은 이수단위.
// reqGroup이 없는 강의는 "같은 과목명"으로만 묶어 분반을 하나로 접음.
export function groupKeyOf(c) {
  return c.reqGroup || `name:${c.semester}:${c.grade}${c.group}:${c.name}`;
}

// 강의 배열을 groupKeyOf 기준으로 묶어 "대표 한 줄" 목록으로 변환.
// 검색결과·후보목록에서 분반을 낱개로 노출하지 않고 하나로 접어 보여줄 때 사용.
export function groupCourses(list) {
  const map = new Map();
  for (const c of list) {
    const k = groupKeyOf(c);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(c);
  }
  return [...map.entries()].map(([key, members]) => ({
    key,
    members,
    label: members[0].groupLabel || members[0].name,
    isMulti: members.length > 1,
  }));
}

// 과목명 → 파스텔 색 (이름 해시로 안정적 배정)
const PALETTE = [
  { bg: "#e3eefb", bar: "#4b86c7" },
  { bg: "#e8f5ea", bar: "#57a06f" },
  { bg: "#fbeede", bar: "#d98a3d" },
  { bg: "#f6e6f0", bar: "#c86aa0" },
  { bg: "#fdecec", bar: "#d9636f" },
  { bg: "#eee9f7", bar: "#8a72c4" },
  { bg: "#e3f1f3", bar: "#4aa0a8" },
  { bg: "#fef4da", bar: "#c79a2e" },
];
export function colorFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
