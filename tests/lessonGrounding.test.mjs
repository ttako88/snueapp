// 지도안 그라운딩 계약 테스트.
//
// GPT 가 채운 근거 CSV(성취기준·단원구성·평가기준·모형전개)가 실제로 프롬프트에
// 주입되는지 고정한다. 데이터가 로드는 되는데 프롬프트에 안 꽂히면(매칭·연결
// 문제) "성취기준 코드를 지어내지 말라" 는 제약만 남고 근거가 비어 품질이 떨어진다.
// 단원명을 하드코딩하지 않고 **로드된 데이터에서 골라** 검증하므로 CSV 가 바뀌어도
// 계약만 지키면 통과한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAll } from "../app/lib/server/ai/lessonData.mjs";
import { buildLessonPrompt } from "../app/lib/server/ai/lessonPrompt.mjs";
import { defaultModelFor } from "../app/lib/lessonPlan.js";

const data = loadAll();
const base = (u) => ({
  planType: "full", grade: u.grade, subject: u.subject, unit: u.unit, duration: 40,
  model: defaultModelFor(u.subject, u.grade),
  goal: "", learners: "", focus: "", materials: "", evaluation: "", request: "",
});

test("근거 CSV 가 로드된다(비어 있지 않음)", () => {
  assert.equal(data.empty, false, "app/data/lessonPrompt 의 CSV 가 로드돼야 한다");
  assert.ok(data.standards.size > 100, `성취기준 ${data.standards.size}건`);
  assert.ok(data.units.length > 100, `단원 ${data.units.length}건`);
  assert.ok(data.rubrics.size > 50, `평가기준 ${data.rubrics.size}개 코드`);
  assert.ok(data.modelSteps.size >= 1, `모형 ${data.modelSteps.size}개`);
});

test("성취기준코드가 붙은 단원을 고르면 성취기준·차시가 프롬프트에 주입된다", () => {
  const unit = data.units.find((u) => u.codes && u.codes.length > 0);
  assert.ok(unit, "성취기준코드가 연결된 단원이 최소 1개는 있어야 한다");
  const built = buildLessonPrompt(base(unit), { data });
  assert.equal(built.hasEvidence, true);
  assert.match(built.prompt, /교과서 단원 정보/, "차시 정보 주입");
  assert.match(built.prompt, /관련 성취기준/, "성취기준 주입");
  // 주입된 코드가 실제 그 단원의 코드여야 한다
  assert.ok(unit.codes.some((c) => built.prompt.includes(c)), "그 단원의 실제 코드가 들어가야 한다");
});

test("정규화 매칭: 단원명 공백이 달라도 근거를 놓치지 않는다", () => {
  const unit = data.units.find((u) => u.codes.length > 0 && /\s/.test(u.unit));
  if (!unit) return; // 공백 있는 단원이 없으면 통과(해당 없음)
  const built = buildLessonPrompt({ ...base(unit), unit: unit.unit.replace(/\s+/g, "") }, { data });
  assert.match(built.prompt, /관련 성취기준/, "공백 제거 입력도 성취기준 주입");
});

test("모형 발화 예시가 선택 모형에 맞게 주입된다", () => {
  const unit = data.units.find((u) => u.codes.length > 0);
  const built = buildLessonPrompt(base(unit), { data });
  assert.match(built.prompt, /교사 발화 예시/, "모형 단계별 교사 발화 주입");
});

test("데이터가 없으면 근거 없이도 동작한다(전제조건 아님)", () => {
  const unit = data.units.find((u) => u.codes.length > 0) ?? { grade: 3, subject: "국어", unit: "x" };
  const built = buildLessonPrompt(base(unit), { data: null });
  assert.equal(built.hasEvidence, false);
  assert.ok(built.prompt.length > 0, "근거 없이도 프롬프트는 만들어진다");
});
