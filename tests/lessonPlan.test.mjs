// 지도안 옵션 스키마 회귀 테스트.
// 2단계 옵션(필수 4 + 선택)과 수업모형 자동 추천을 고정한다.
import test from "node:test";
import assert from "node:assert/strict";
import {
  validatePlanInput, withDefaults, defaultModelFor,
  subjectsForGrade, TEACHING_MODELS,
} from "../app/lib/lessonPlan.js";

const base = { planType: "brief", grade: 5, subject: "국어", unit: "글쓴이의 주장", duration: 40 };

test("필수 4개만으로 통과 (수업모형 없이도)", () => {
  assert.equal(validatePlanInput(base), null);
});

test("수업모형을 안 고르면 교과·학년으로 추천", () => {
  assert.equal(withDefaults(base).model, "direct");
  assert.equal(withDefaults({ ...base, subject: "도덕" }).model, "value");
  assert.equal(withDefaults({ ...base, subject: "과학" }).model, "inquiry");
  assert.equal(withDefaults({ ...base, grade: 2, subject: "통합" }).model, "play");
  assert.equal(withDefaults({ ...base, subject: "실과" }).model, "problem");
});

test("고른 모형은 유지된다", () => {
  assert.equal(withDefaults({ ...base, model: "inquiry" }).model, "inquiry");
});

test("모르는 모형은 거부 (조용히 기본값으로 바꾸지 않는다)", () => {
  assert.ok(validatePlanInput({ ...base, model: "없는거" }));
  assert.equal(validatePlanInput({ ...base, model: "inquiry" }), null);
});

test("추천 모형은 전부 실제 존재하는 키다", () => {
  const keys = new Set(TEACHING_MODELS.map((m) => m.key));
  for (const subject of ["국어", "수학", "과학", "도덕", "실과", "미술", "통합"]) {
    for (const grade of [1, 2, 3, 4, 5, 6]) {
      if (!subjectsForGrade(grade).includes(subject)) continue;
      assert.ok(keys.has(defaultModelFor(subject, grade)),
        `${grade}학년 ${subject} 추천 모형이 목록에 없다`);
    }
  }
});

test("선택 항목 글자수 상한", () => {
  assert.ok(validatePlanInput({ ...base, request: "가".repeat(301) }));
  assert.equal(validatePlanInput({ ...base, request: "가".repeat(300) }), null);
});

test("필수 항목 누락은 거부", () => {
  assert.ok(validatePlanInput({ ...base, grade: null }));
  assert.ok(validatePlanInput({ ...base, unit: "" }));
  assert.ok(validatePlanInput({ ...base, duration: 33 }));
});

test("학년-교과 조합 검증 (1학년에 과학 없음)", () => {
  assert.ok(validatePlanInput({ ...base, grade: 1, subject: "과학" }));
  assert.equal(validatePlanInput({ ...base, grade: 1, subject: "국어" }), null);
});

test("교과서ID는 선택값이며 안전한 형식만 통과", () => {
  const textbookId = "mirae-2022-integrated-1-1-1386";
  assert.equal(validatePlanInput({ ...base, textbookId }), null);
  assert.equal(withDefaults({ ...base, textbookId }).textbookId, textbookId);
  assert.ok(validatePlanInput({ ...base, textbookId: "잘못된 ID" }));
  assert.equal(withDefaults(base).textbookId, "");
});
