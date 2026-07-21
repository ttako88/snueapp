// courseKey 파서 회귀 테스트.
//
// 이 파서가 만드는 키는 강의평가 대상의 영구 식별자다. 규칙이 바뀌면 이미
// 쌓인 평가가 다른 과목에 붙거나 흩어진다. 그래서 실제 courses.json 에서
// 관찰한 오염 유형을 하나씩 고정해 둔다 — 여기 있는 사례는 전부 실측이다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { courseKeyOf, professorKeyOf, subjectOf } from "../app/lib/courseKey.js";

test("과목명: 괄호·로마숫자·문장부호를 제거해도 구분이 유지된다", () => {
  assert.equal(courseKeyOf("체육실기지도I(육상.체조)"), "체육실기지도i육상체조");
  // 다른 과목이 같은 키로 뭉치면 안 된다
  assert.notEqual(courseKeyOf("음악실기지도I"), courseKeyOf("음악실기지도II"));
});

test("교수: 공동 담당 순서가 달라도 같은 키", () => {
  assert.equal(professorKeyOf("신주영, 심재표"), professorKeyOf("심재표, 신주영"));
  assert.equal(professorKeyOf("진현정, 김정원"), professorKeyOf("김정원/진현정"));
});

test("교수: 강의실이 붙어도 이름만 남는다", () => {
  const base = professorKeyOf("진현정");
  assert.equal(professorKeyOf("진현정 연강403"), base);
  assert.equal(professorKeyOf("연강403, 진현정"), base);
  assert.equal(professorKeyOf("인404(교) 진현정"), base);
  assert.equal(professorKeyOf("진현정 인공지능정보교육실"), base);
  assert.equal(professorKeyOf("융합-세미나1 진현정"), base);
});

test("교수: 강의실 번호 조각이 이름으로 둔갑하지 않는다", () => {
  // "연강403, 406" 의 뒷조각이 한때 "406" 이라는 교수로 들어갔었다
  assert.equal(professorKeyOf("김영흥, 임은애 연강403, 406"),
               professorKeyOf("임은애, 김영흥 연강406, 403"));
  assert.match(professorKeyOf("김영흥, 임은애 연강403, 406"), /^[가-힣]+$/);
  // 강의실 코드만 있는 값은 키가 되지 않는다
  assert.equal(professorKeyOf("E-311"), null);
  assert.equal(professorKeyOf("연강403"), null);
});

test("교수: 주차 구간 표기를 무시한다", () => {
  const a = professorKeyOf("김주한(1~7)/신주희(8-15)");
  const b = professorKeyOf("김주한(8~15)/신주희(1-7)");
  const c = professorKeyOf("김주한(1-7)/신주희(8-15)");
  assert.equal(a, b);
  assert.equal(a, c);
});

test("교수: 트랙명이 앞에 붙어도 서로 다른 교수가 합쳐지지 않는다", () => {
  // "입체조형 이대철" 에서 앞 토큰을 고르면 교수 4명이 한 키가 됐었다
  const x = professorKeyOf("입체조형 이대철");
  const y = professorKeyOf("입체조형 김병주");
  assert.notEqual(x, y);
  assert.equal(x, professorKeyOf("이대철"));
});

test("교수: 미배정 자리표시자는 키를 만들지 않는다", () => {
  for (const p of ["신규강사", "신규강사A", "강사", "강사B", "미정"]) {
    assert.equal(professorKeyOf(p), null, `${p} 는 사람이 아니다`);
  }
  // 실명에 자리표시자가 섞인 경우 실명만 남는다
  assert.equal(professorKeyOf("이옥지(강사A)"), professorKeyOf("이옥지"));
  assert.equal(professorKeyOf("서예린, 강사A 연강403, 410"), professorKeyOf("서예린"));
});

test("교수: 자리표시자와 겹치는 실명을 잘라먹지 않는다", () => {
  // "미정" 을 부분 문자열로 지웠더니 실존 교수 "강미정" 이 "강" 이 되어
  // 통째로 사라졌었다. 이름 안에 들어갈 수 있는 말은 토큰 단위로만 거른다.
  assert.equal(professorKeyOf("강미정"), "강미정");
  assert.equal(professorKeyOf("강미정 연강403"), "강미정");
  // 그래도 자리표시자 단독은 여전히 걸러진다
  assert.equal(professorKeyOf("미정"), null);
  assert.equal(professorKeyOf("<폐강>"), null);
});

test("교수: 영문 이름은 공백을 포함한 채로 살린다", () => {
  assert.equal(professorKeyOf("Catherine Guilfoyle"), "catherineguilfoyle");
  assert.notEqual(professorKeyOf("Philip Jung"), professorKeyOf("Kim Secil Jin"));
});

test("교수: '외 N명' 과 중복 표기를 흡수한다", () => {
  assert.equal(professorKeyOf("진현정 외 2명"), professorKeyOf("진현정"));
  assert.equal(professorKeyOf("진현정, 진현정"), professorKeyOf("진현정"));
});

test("subject: DB CHECK 제약을 항상 만족한다", () => {
  const s = subjectOf({ name: "체육실기지도I(육상.체조)", professor: "신주영, 심재표" });
  assert.match(s.courseKey, /^[0-9a-z가-힣]{1,80}$/);
  assert.match(s.professorKey, /^[0-9a-z가-힣]{1,40}$/);
  // 표시용은 원문 그대로 — 사용자에게는 원문이 보여야 한다
  assert.equal(s.courseNameDisplay, "체육실기지도I(육상.체조)");
});

test("subject: 키를 못 만들면 null 이지 예외가 아니다", () => {
  assert.equal(subjectOf({ name: "미술", professor: "신규강사" }), null);
  assert.equal(subjectOf({ name: "", professor: "진현정" }), null);
  assert.equal(subjectOf({}), null);
  assert.equal(subjectOf(null), null);
});
