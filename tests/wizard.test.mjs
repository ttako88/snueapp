// 시간표 마법사 엔진 회귀 테스트 (node --test)
// 실행: npm test  (또는 node --test tests/)
// 대상: app/lib/wizard.js — 순수함수라 DB·화면 없이 검증 가능.
// 이력: 2026-07-20 "필수 그룹 택1" 도입 때 세션 임시폴더에서 검증하던 것을
//       Gate 2에서 저장소로 이식 (감사보고서 12.11 — 회귀 안전망).
import test from "node:test";
import assert from "node:assert/strict";
import { generateTimetables } from "../app/lib/wizard.js";

const C = (name, day, periods, extra = {}) => ({ name, day, periods, professor: "p", room: "r", ...extra });

test("필수 그룹: 분반 3개 중 고정과 안 겹치는 분반을 자동 선택", () => {
  const base = [C("전공A", "월", [1, 2])];
  const required = [
    C("재이수과목", "월", [1, 2], { section: "A" }), // 고정과 충돌
    C("재이수과목", "화", [1, 2], { section: "B" }),
    C("재이수과목", "수", [3, 4], { section: "C" }),
  ];
  const r = generateTimetables({ base, required, candidates: [] });
  assert.equal(r.infeasible, null);
  assert.equal((r.requiredFixed || []).length, 0, "그룹이므로 requiredFixed는 비어야");
  assert.equal(r.results[0].courses.filter((c) => c.name === "재이수과목").length, 1);
  assert.ok(!r.results[0].courses.some((c) => c.name === "재이수과목" && c.section === "A"), "충돌 분반 제외");
});

test("필수 그룹 전체가 고정과 겹치면 infeasible", () => {
  const base = [C("전공A", "월", [1, 2]), C("전공B", "화", [1, 2])];
  const required = [
    C("재이수과목", "월", [1, 2], { section: "A" }),
    C("재이수과목", "화", [1, 2], { section: "B" }),
  ];
  const r = generateTimetables({ base, required, candidates: [] });
  assert.ok(r.infeasible);
});

test("필수 단일 강좌는 requiredFixed로 고정되고 학점에 반영", () => {
  const r = generateTimetables({ base: [], required: [C("단일필수", "금", [5, 6])], candidates: [] });
  assert.ok((r.requiredFixed || []).some((c) => c.name === "단일필수"));
  assert.equal(r.results[0].totalCredits, 2);
});

test("회귀: 후보만 있을 때 우선순위·최대충전 동작", () => {
  const candidates = [
    C("교양1", "월", [1, 2], { priority: 1 }),
    C("교양2", "월", [1, 2], { priority: 2 }), // 교양1과 충돌
    C("교양3", "화", [3, 4], { priority: 3 }),
  ];
  const r = generateTimetables({ base: [], required: [], candidates });
  assert.ok(r.results.length >= 2);
  assert.ok(r.results[0].courses.some((c) => c.name === "교양1"), "1위 조합에 우선순위 1 포함");
  assert.ok(r.results[0].courses.some((c) => c.name === "교양3"), "빈 시간은 최대로 채움");
});

test("필수 그룹 + 후보 혼합: 모든 조합에 필수가 정확히 1개, 충돌 회피", () => {
  const base = [C("전공A", "월", [1, 2])];
  const required = [
    C("재이수", "화", [1, 2], { section: "A" }),
    C("재이수", "수", [1, 2], { section: "B" }),
  ];
  const candidates = [
    C("교양X", "화", [1, 2], { priority: 1 }), // 재이수A와 충돌 가능
    C("교양Y", "목", [5, 6], { priority: 2 }),
  ];
  const r = generateTimetables({ base, required, candidates });
  assert.equal(r.infeasible, null);
  assert.ok(r.results.every((cb) => cb.courses.filter((c) => c.name === "재이수").length === 1));
  assert.ok(
    r.results.every((cb) => {
      const hasX = cb.courses.some((c) => c.name === "교양X");
      const hasA = cb.courses.some((c) => c.name === "재이수" && c.section === "A");
      return !(hasX && hasA);
    }),
    "충돌 쌍이 같은 조합에 공존하면 안 됨"
  );
});

test("같은 reqGroup(대체과목)은 한 유닛 — 조합마다 1개만", () => {
  const required = [
    C("운동과웰니스", "월", [3, 4], { reqGroup: "GY4" }),
    C("운동과건강디자인", "화", [3, 4], { reqGroup: "GY4" }),
  ];
  const r = generateTimetables({ base: [], required, candidates: [] });
  assert.ok(r.results.every((cb) => cb.courses.filter((c) => c.reqGroup === "GY4").length === 1));
});

test("고정 과목끼리 겹치면 infeasible 메시지", () => {
  const base = [C("전공A", "월", [1, 2]), C("전공B", "월", [2, 3])];
  const r = generateTimetables({ base, required: [], candidates: [] });
  assert.ok(r.infeasible);
});

test("조건: 공강 요일·1,2교시 회피가 후보를 거른다", () => {
  const candidates = [
    C("금요교양", "금", [3, 4], { priority: 1 }),
    C("아침교양", "화", [1, 2], { priority: 2 }),
    C("오후교양", "화", [5, 6], { priority: 3 }),
  ];
  const r = generateTimetables({ base: [], required: [], candidates, freeDays: ["금"], avoidEarly: true });
  const names = r.results[0].courses.map((c) => c.name);
  assert.ok(!names.includes("금요교양"));
  assert.ok(!names.includes("아침교양"));
  assert.ok(names.includes("오후교양"));
});

test("학점 상한을 넘는 후보 조합은 만들지 않는다", () => {
  const base = [C("전공A", "월", [1, 2, 3, 4])]; // 4학점 고정
  const candidates = [C("교양빅", "화", [1, 2, 3, 4], { priority: 1 })];
  const r = generateTimetables({ base, required: [], candidates, maxCredits: 6 });
  assert.ok(r.results.every((cb) => cb.totalCredits <= 6));
});
