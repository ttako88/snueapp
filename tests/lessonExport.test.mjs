// 지도안 마크다운 → HTML 변환 회귀 테스트.
// AI 가 내는 표(| |)·<br>·**굵게**·## 제목이 <pre> 원문이 아니라 실제 표·폼으로
// 렌더돼야 한다("캡처해서 바로 제출"). 여기서 그 변환을 고정한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lessonPlanToHtml } from "../app/lib/lessonExport.js";

test("마크다운 표는 실제 <table> 로 변환된다", () => {
  const md = [
    "| 단계 | 활동 | 시간 |",
    "|---|---|---|",
    "| 도입 | 동기유발 | 5분 |",
    "| 전개 | 문제해결 | 30분 |",
  ].join("\n");
  const html = lessonPlanToHtml(md);
  assert.match(html, /<table>/);
  assert.match(html, /<th>단계<\/th>/);
  assert.match(html, /<td>동기유발<\/td>/);
  assert.match(html, /<td>30분<\/td>/);
  // 구분행(|---|)은 데이터 행으로 새지 않는다
  assert.doesNotMatch(html, /<td>---<\/td>/);
});

test("칸 안 <br> 은 실제 줄바꿈, **굵게**는 <strong>", () => {
  const html = lessonPlanToHtml("| 도입<br>정리 | **핵심** |");
  assert.match(html, /도입<br\/>정리/);
  assert.match(html, /<strong>핵심<\/strong>/);
});

test("## 제목·--- 구분선·- 목록을 구조로 변환", () => {
  const html = lessonPlanToHtml("## 학습목표\n- 첫째\n- 둘째\n---\n일반 문단");
  assert.match(html, /<h3>학습목표<\/h3>/); // ##(2) → h3
  assert.match(html, /<ul><li>첫째<\/li><li>둘째<\/li><\/ul>/);
  assert.match(html, /<hr\/>/);
  assert.match(html, /<p>일반 문단<\/p>/);
});

test("HTML 특수문자는 이스케이프된다(주입 차단)", () => {
  const html = lessonPlanToHtml("일반 <script>alert(1)</script> 텍스트");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
