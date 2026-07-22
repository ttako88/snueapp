// 지도안 프롬프트 조립 회귀 테스트.
// 이 로직은 소유자 지갑에서 돈을 쓰는 경로(/api/lesson-plan)의 입력이라
// 조용히 어긋나면 비싸다. 특히 "근거 데이터가 없어도 동작한다" 는 불변식과
// "선택 옵션은 값이 있을 때만 줄이 들어간다" 를 고정한다.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLessonPrompt, buildEvidence, PROMPT_VERSIONS, DEFAULT_PROMPT_VERSION,
} from "../app/lib/server/ai/lessonPrompt.mjs";

const base = {
  planType: "brief", grade: 5, subject: "국어",
  unit: "글쓴이의 주장", duration: 40, model: "direct",
};

test("기본판은 v2", () => {
  assert.equal(DEFAULT_PROMPT_VERSION, "v2");
  assert.ok(PROMPT_VERSIONS.includes("v1"));
  assert.ok(PROMPT_VERSIONS.includes("v2"));
});

test("필수 항목이 프롬프트에 들어간다", () => {
  const b = buildLessonPrompt(base);
  assert.match(b.prompt, /5학년/);
  assert.match(b.prompt, /국어/);
  assert.match(b.prompt, /글쓴이의 주장/);
  assert.match(b.prompt, /40분/);
  assert.match(b.prompt, /직접교수/);
});

test("v2 시스템 프롬프트에 '틀린 반응' 제약이 있다", () => {
  const b = buildLessonPrompt(base, { version: "v2" });
  assert.equal(b.version, "v2");
  assert.match(b.system, /틀린 반응/);
});

test("v1 은 그 제약이 없다", () => {
  const b = buildLessonPrompt(base, { version: "v1" });
  assert.equal(b.version, "v1");
  assert.doesNotMatch(b.system, /틀린 반응/);
});

test("모르는 버전은 v1 로 떨어진다", () => {
  assert.equal(buildLessonPrompt(base, { version: "v99" }).version, "v1");
});

test("선택 옵션은 값이 있을 때만 줄이 들어간다", () => {
  const empty = buildLessonPrompt(base);
  assert.doesNotMatch(empty.prompt, /학습자 특성/);
  assert.doesNotMatch(empty.prompt, /중점을 둘 활동/);

  const filled = buildLessonPrompt({ ...base, learners: "발표를 꺼려요", focus: "모둠 토의" });
  assert.match(filled.prompt, /학습자 특성: 발표를 꺼려요/);
  assert.match(filled.prompt, /중점을 둘 활동: 모둠 토의/);
});

test("근거 데이터가 없어도 동작한다 (핵심 불변식)", () => {
  const b1 = buildLessonPrompt(base, { data: null });
  const b2 = buildLessonPrompt(base, { data: { empty: true } });
  assert.equal(b1.hasEvidence, false);
  assert.equal(b2.hasEvidence, false);
  assert.ok(b1.prompt.length > 0);
});

test("근거 데이터가 있으면 성취기준을 끼운다", () => {
  const data = {
    empty: false,
    units: [{ subject: "국어", grade: 5, term: 1, unitNo: 4, unit: "글쓴이의 주장",
              totalPeriods: 8, periodNo: 1, period: "주장 살펴보기", codes: ["[6국02-03]"],
              publisher: "국정" }],
    standards: new Map([["[6국02-03]",
      { code: "[6국02-03]", text: "글쓴이의 주장을 파악한다.", subject: "국어" }]]),
    rubrics: new Map(),
    modelSteps: new Map(),
  };
  const b = buildLessonPrompt(base, { data });
  assert.equal(b.hasEvidence, true);
  assert.match(b.prompt, /\[6국02-03\]/);
  assert.match(b.prompt, /이 목록에 없는 코드는 쓰지 마세요/);
});

test("단원이 안 맞으면 근거를 안 끼운다", () => {
  const data = {
    empty: false,
    units: [{ subject: "수학", grade: 3, term: 1, unitNo: 2, unit: "각과 직각",
              totalPeriods: 4, periodNo: 1, period: "각", codes: [], publisher: "국정" }],
    standards: new Map(), rubrics: new Map(), modelSteps: new Map(),
  };
  // base 는 5학년 국어라 위 수학 단원과 안 맞는다
  assert.equal(buildLessonPrompt(base, { data }).hasEvidence, false);
});

test("알 수 없는 planType·model 은 던진다", () => {
  assert.throws(() => buildLessonPrompt({ ...base, planType: "없음" }));
  assert.throws(() => buildLessonPrompt({ ...base, model: "없음" }));
});

test("세안은 구조가 더 길다", () => {
  const brief = buildLessonPrompt({ ...base, planType: "brief" });
  const full = buildLessonPrompt({ ...base, planType: "full" });
  assert.match(full.prompt, /단원 개관/);
  assert.doesNotMatch(brief.prompt, /단원 개관/);
});
