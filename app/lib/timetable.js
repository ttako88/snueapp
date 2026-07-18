// 시간표 공용 도구 (상수·색·자동채움 로직). 데이터는 파싱해둔 JSON에서.
import COURSES from "../data/courses-2026-2.json";

export const SEMESTER = "2026-2";
export const ALL_COURSES = COURSES;
export const DAYS = ["월", "화", "수", "목", "금"];

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

// 강의 하나를 식별하는 안정적 키
export const courseId = (c) =>
  `${c.grade}${c.group}|${c.name}|${c.section}|${c.day}${c.periods.join("")}`;

// 자동 채움: 내 학년+심화과정의 전공·심화·교직 + 학년 공통필수(교양 제외)
export function autofillCourses(grade, dept) {
  const g = groupOf(dept);
  return ALL_COURSES.filter(
    (c) =>
      c.grade === grade &&
      (c.dept === dept || (c.dept === "공통" && c.group === g && c.type !== "교양"))
  );
}

// 내 학년이 고를 수 있는 교양 후보
export function liberalCourses(grade) {
  return ALL_COURSES.filter((c) => c.grade === grade && c.type === "교양");
}

// 두 강의가 시간이 겹치는지
export function conflicts(a, b) {
  if (a.day !== b.day) return false;
  return a.periods.some((p) => b.periods.includes(p));
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
