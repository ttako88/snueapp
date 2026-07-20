// 강의조회 모듈 회귀 테스트 (node --test)
// 대상: app/lib/courseSearch.js — 순수함수라 DB·화면 없이 검증 가능.
import test from "node:test";
import assert from "node:assert/strict";
import { searchCourses, groupResults, periodLabel, cleanProfessors } from "../app/lib/courseSearch.js";

// 최소 fixture (실제 courses.json 스키마와 동일한 필드)
const C = (name, extra = {}) => ({
  name,
  section: "A",
  type: "전공",
  professor: "김교수",
  room: "101",
  day: "월",
  periods: [1, 2],
  grade: 1,
  group: "A",
  dept: "국어",
  semester: "2026-2",
  reqGroup: null,
  groupLabel: null,
  ...extra,
});

const ROWS = [
  C("삶과철학의이해", { type: "교양", dept: "공통", groupLabel: "중점교양 · 철학의 기초 (택1)", professor: "전성은" }),
  C("국어교육론", { professor: "이교수", day: "화", periods: [3, 4] }),
  C("국어교육론", { section: "B", professor: "박교수", day: "수", periods: [5] }),
  C("수학교육론", { dept: "수학", grade: 2, semester: "2026-1" }),
];

test("검색어: 과목명 부분일치 + 공백 무시", () => {
  assert.equal(searchCourses(ROWS, { q: "국어" }).length, 2);
  assert.equal(searchCourses(ROWS, { q: "삶과 철학" }).length, 1, "공백 넣어도 잡혀야");
});

test("검색어: 교수명으로도 찾아짐", () => {
  assert.equal(searchCourses(ROWS, { q: "박교수" }).length, 1);
});

test("필터: 학기·유형·학년·학과·요일", () => {
  assert.equal(searchCourses(ROWS, { semester: "2026-1" }).length, 1);
  assert.equal(searchCourses(ROWS, { type: "교양" }).length, 1);
  assert.equal(searchCourses(ROWS, { grade: 2 }).length, 1);
  assert.equal(searchCourses(ROWS, { grade: "2" }).length, 1, "문자열 학년도 동작");
  assert.equal(searchCourses(ROWS, { dept: "수학" }).length, 1);
  assert.equal(searchCourses(ROWS, { day: "화" }).length, 1);
});

test("빈 필터는 '전체'로 취급 — 아무것도 안 거름", () => {
  assert.equal(searchCourses(ROWS, {}).length, ROWS.length);
  assert.equal(searchCourses(ROWS, { q: "", semester: "", grade: "" }).length, ROWS.length);
});

test("필터 조합은 AND", () => {
  assert.equal(searchCourses(ROWS, { q: "국어교육론", day: "수" }).length, 1);
  assert.equal(searchCourses(ROWS, { type: "교양", grade: 2 }).length, 0);
});

test("groupResults: 같은 과목명은 하나로 묶고 분반을 안에 담는다", () => {
  const g = groupResults(searchCourses(ROWS, { q: "국어교육론" }));
  assert.equal(g.length, 1);
  assert.equal(g[0].sections.length, 2);
  assert.deepEqual(g[0].professors, ["이교수", "박교수"]);
});

// 실제 courses.json의 지저분한 원본을 그대로 넣어 검증 (강의실 문자열이 섞여 있음)
test("cleanProfessors: 교수명에 섞인 강의실·잔여 쉼표를 걷어낸다", () => {
  assert.deepEqual(cleanProfessors("진현정,남영민 E-407,"), ["진현정", "남영민"]);
  assert.deepEqual(cleanProfessors("남영민, 진현정 연강403,"), ["남영민", "진현정"]);
  assert.deepEqual(cleanProfessors("김교수"), ["김교수"]);
  assert.deepEqual(cleanProfessors(""), []);
  assert.deepEqual(cleanProfessors(null), []);
});

test("groupResults: 여러 학과에 걸친 과목은 depts를 전부 모은다", () => {
  const rows = [
    C("융합교육", { dept: "윤리", section: "A", professor: "진현정,남영민 E-407," }),
    C("융합교육", { dept: "국어", section: "B", professor: "진현정,권성옥 E-407," }),
    C("융합교육", { dept: "수학", section: "C", professor: "남영민, 진현정 연강403," }),
  ];
  const g = groupResults(rows)[0];
  assert.deepEqual(g.depts, ["윤리", "국어", "수학"]);
  // 교수는 정리되고 중복 제거돼야 (강의실 토큰 없이)
  assert.deepEqual(g.professors, ["진현정", "남영민", "권성옥"]);
  assert.deepEqual(g.grades, [1]);
});

test("groupResults: 학기가 다르면 별개 항목", () => {
  const rows = [C("같은과목", { semester: "2026-1" }), C("같은과목", { semester: "2026-2" })];
  assert.equal(groupResults(rows).length, 2);
});

test("groupResults: 교양은 성격(핵심/중점/자율)으로 분류된다", () => {
  const g = groupResults(searchCourses(ROWS, { q: "삶과철학" }));
  assert.equal(g[0].cat, "중점교양");
});

test("periodLabel: 연강·단일교시·미정", () => {
  assert.equal(periodLabel([1, 2]), "1~2교시 · 09:00–10:50");
  assert.equal(periodLabel([3]), "3교시 · 11:00–11:50");
  assert.equal(periodLabel([]), "시간 미정");
  assert.equal(periodLabel(undefined), "시간 미정");
});

test("periodLabel: 순서가 뒤섞여 들어와도 정렬해서 표시", () => {
  assert.equal(periodLabel([2, 1]), "1~2교시 · 09:00–10:50");
});
