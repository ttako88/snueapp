// 통합교과는 같은 단원번호·출판사 안에도 여러 책의 차시가 있다.
// API가 교과서ID를 보존하지 않으면 화면은 그중 하나를 임의 선택하게 된다.
import test from "node:test";
import assert from "node:assert/strict";
import { loadAll } from "../app/lib/server/ai/lessonData.mjs";
import { buildUnitList } from "../app/lib/server/ai/unitList.mjs";

test("통합교과 API 선택지는 책별 교과서ID를 보존한다", () => {
  const body = buildUnitList(loadAll().units, { grade: 1, subject: "통합" });
  const ids = new Set(body.map((u) => u.textbookId).filter(Boolean));
  assert.equal(ids.size, 8, "1학년 통합은 1·2학기 8권을 구분해야 한다");
  assert.ok(body.every((u) => typeof u.textbookId === "string"));
  assert.ok(body.some((u) => u.textbookId === "mirae-2022-integrated-1-1-1386" && u.textbookName === "학교"));
});

test("단일 교과서 v1 행도 API 선택지에서 빈 교과서ID로 유지된다", () => {
  const body = buildUnitList(loadAll().units, { grade: 5, subject: "국어" });
  assert.ok(body.length > 0);
  assert.ok(body.every((u) => u.textbookId === ""));
});
