// NEIS 급식 파싱 회귀 테스트.
// 실측 데이터(2026-07-22 개운초)에서 뽑은 실제 모양들을 고정한다.
import test from "node:test";
import assert from "node:assert/strict";
import { parseDishes } from "../app/lib/mealParse.js";

test("괄호형 알레르기 번호", () => {
  const r = parseDishes("반미샌드위치 (2.5.6.10)");
  assert.equal(r.length, 1);
  assert.equal(r[0].name, "반미샌드위치");
  assert.deepEqual(r[0].allergens, ["2", "5", "6", "10"]);
});

test("접미형 — 이름에 번호가 붙음", () => {
  assert.deepEqual(parseDishes("우유2"), [{ name: "우유", allergens: ["2"] }]);
  assert.deepEqual(parseDishes("사과주스13"), [{ name: "사과주스", allergens: ["13"] }]);
});

test("가운뎃점 구분 + '-초' 접두 (실측 모양)", () => {
  // "양지쌀국수(주찬)-초5·6·13·15·16·18"
  // 이름 끝의 '-초' 는 다듬어서 뗀다.
  const r = parseDishes("양지쌀국수(주찬)-초5·6·13·15·16·18");
  assert.equal(r[0].name, "양지쌀국수(주찬)");
  assert.deepEqual(r[0].allergens, ["5", "6", "13", "15", "16", "18"]);
});

test("번호 없는 반찬", () => {
  assert.deepEqual(parseDishes("단무지무침"), [{ name: "단무지무침", allergens: [] }]);
});

test("번호 없이 '-초' 만 붙은 경우도 다듬는다 (실측)", () => {
  // "수수친환경쌀밥-초" — 알레르기 번호 없이 초등용 접미만
  assert.deepEqual(parseDishes("수수친환경쌀밥-초"),
    [{ name: "수수친환경쌀밥", allergens: [] }]);
});

test("'초' 로 끝나는 실제 이름은 깨지 않는다", () => {
  // 하이픈이 없으면 손대지 않는다. "고추" "식초" 등을 보호.
  assert.deepEqual(parseDishes("고추"), [{ name: "고추", allergens: [] }]);
  assert.deepEqual(parseDishes("양파식초무침"), [{ name: "양파식초무침", allergens: [] }]);
});

test("<br/> 로 여러 줄", () => {
  const r = parseDishes("우유2<br/>단무지무침<br/>사과주스13");
  assert.equal(r.length, 3);
  assert.deepEqual(r.map((d) => d.name), ["우유", "단무지무침", "사과주스"]);
});

test("<br> (닫힘 없는 태그)도 처리", () => {
  assert.equal(parseDishes("김치<br>깍두기").length, 2);
});

test("빈 입력·null 은 빈 배열", () => {
  assert.deepEqual(parseDishes(""), []);
  assert.deepEqual(parseDishes(null), []);
  assert.deepEqual(parseDishes(undefined), []);
});

test("빈 줄은 건너뛴다", () => {
  assert.equal(parseDishes("우유2<br/><br/>김치").length, 2);
});

test("유효 범위 밖 숫자는 알레르기로 치지 않는다", () => {
  // 알레르기 번호는 1~19. "라면99" 의 99 는 번호가 아니다 → 이름에 남는다.
  const r = parseDishes("라면99");
  assert.equal(r[0].name, "라면99");
  assert.deepEqual(r[0].allergens, []);
});

test("이름 안의 괄호는 보존 (접미형)", () => {
  // 괄호가 알레르기 괄호가 아니라 이름의 일부인 경우
  const r = parseDishes("불고기(소)5");
  assert.equal(r[0].name, "불고기(소)");
  assert.deepEqual(r[0].allergens, ["5"]);
});
