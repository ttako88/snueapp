// 목표 평점 역산 회귀 테스트 (node --test)
import test from "node:test";
import assert from "node:assert/strict";
import { requiredAverage, maxReachableGpa, MAX_GPA } from "../app/lib/gpaTarget.js";

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test("남은 학점이 0 이하면 계산 불가", () => {
  assert.equal(requiredAverage({ currentPoints: 0, gradedCredits: 0, targetGpa: 4, remainingCredits: 0 }), null);
  assert.equal(requiredAverage({ currentPoints: 0, gradedCredits: 0, targetGpa: 4, remainingCredits: -3 }), null);
});

test("기본 역산: 30학점 3.0 이수, 30학점으로 3.5 목표 → 4.0 필요", () => {
  const r = requiredAverage({ currentPoints: 3.0 * 30, gradedCredits: 30, targetGpa: 3.5, remainingCredits: 30 });
  assert.equal(r.status, "ok");
  assert.ok(near(r.required, 4.0), `required=${r.required}`);
});

test("첫 학기(누적 없음)면 목표 그대로가 필요 평균", () => {
  const r = requiredAverage({ currentPoints: 0, gradedCredits: 0, targetGpa: 3.8, remainingCredits: 18 });
  assert.ok(near(r.required, 3.8));
});

test("이미 목표를 넘었으면 already (0점을 받아도 달성)", () => {
  const r = requiredAverage({ currentPoints: 4.5 * 60, gradedCredits: 60, targetGpa: 3.0, remainingCredits: 12 });
  assert.equal(r.status, "already");
  assert.equal(r.required, 0);
});

test("만점을 받아도 못 넘으면 impossible", () => {
  // 60학점 2.0, 남은 6학점으로 4.0 목표는 불가능
  const r = requiredAverage({ currentPoints: 2.0 * 60, gradedCredits: 60, targetGpa: 4.0, remainingCredits: 6 });
  assert.equal(r.status, "impossible");
  assert.ok(r.required > MAX_GPA, `required=${r.required}`);
});

test("경계: 정확히 만점이 필요하면 impossible이 아니라 ok", () => {
  // 30학점 3.5, 남은 30학점 → 목표 4.0이면 필요 평균 4.5 (딱 만점)
  const r = requiredAverage({ currentPoints: 3.5 * 30, gradedCredits: 30, targetGpa: 4.0, remainingCredits: 30 });
  assert.equal(r.status, "ok");
  assert.ok(near(r.required, 4.5));
});

test("숫자가 아닌 입력도 안전하게 처리", () => {
  const r = requiredAverage({ currentPoints: null, gradedCredits: undefined, targetGpa: "3.0", remainingCredits: "10" });
  assert.equal(r.status, "ok");
  assert.ok(near(r.required, 3.0));
});

test("도달 가능한 최대 평점", () => {
  // 30학점 3.0 + 남은 30학점 만점 → (90+135)/60 = 3.75
  assert.ok(near(maxReachableGpa({ currentPoints: 90, gradedCredits: 30, remainingCredits: 30 }), 3.75));
});

test("도달 최대: 이수 이력이 없으면 만점", () => {
  assert.ok(near(maxReachableGpa({ currentPoints: 0, gradedCredits: 0, remainingCredits: 18 }), MAX_GPA));
});

test("도달 최대: 학점이 전혀 없으면 0", () => {
  assert.equal(maxReachableGpa({ currentPoints: 0, gradedCredits: 0, remainingCredits: 0 }), 0);
});
