// 게시판 표시 헬퍼 테스트 (node --test) — 의존성 없는 순수함수
import test from "node:test";
import assert from "node:assert/strict";
import { authorLabel, fmtDate } from "../app/lib/board-fmt.js";

test("authorLabel: 익명이면 '익명'", () => {
  assert.equal(authorLabel({ is_anonymous: true, author_nickname: "새록이" }), "익명");
});

test("authorLabel: 닉네임 표시, 없으면 탈퇴 처리", () => {
  assert.equal(authorLabel({ is_anonymous: false, author_nickname: "새록이" }), "새록이");
  assert.equal(authorLabel({ is_anonymous: false, author_nickname: null }), "탈퇴한 사용자");
});

test("fmtDate: YYYY.MM.DD HH:mm 형식", () => {
  const s = fmtDate(new Date(2026, 6, 20, 9, 5).toISOString());
  assert.equal(s, "2026.07.20 09:05");
});
