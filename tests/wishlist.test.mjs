// 시간표 장바구니 회귀 테스트 (node --test)
// 대상: app/lib/wishlist.js 의 순수 로직 (저장소 함수는 브라우저 전용이라 제외)
import test from "node:test";
import assert from "node:assert/strict";
import {
  comboSignature,
  buildEntry,
  addEntry,
  removeEntry,
  entriesForSemester,
  WISHLIST_MAX,
} from "../app/lib/wishlist.js";

const C = (name, day, periods, section = "A") => ({ name, section, day, periods });

test("comboSignature: 순서가 달라도 같은 조합이면 같은 서명", () => {
  const a = [C("국어", "월", [1, 2]), C("수학", "화", [3])];
  const b = [C("수학", "화", [3]), C("국어", "월", [1, 2])];
  assert.equal(comboSignature(a), comboSignature(b));
});

test("comboSignature: 교시 순서가 뒤바뀌어도 동일", () => {
  assert.equal(comboSignature([C("국어", "월", [2, 1])]), comboSignature([C("국어", "월", [1, 2])]));
});

test("comboSignature: 분반이 다르면 다른 조합", () => {
  assert.notEqual(comboSignature([C("국어", "월", [1], "A")]), comboSignature([C("국어", "월", [1], "B")]));
});

test("comboSignature: 빈 조합·null도 안전", () => {
  assert.equal(comboSignature([]), "");
  assert.equal(comboSignature(null), "");
});

test("addEntry: 같은 학기의 동일 조합은 중복으로 거절", () => {
  const courses = [C("국어", "월", [1, 2])];
  const e1 = buildEntry("2026-2", courses, { now: 1000 });
  const e2 = buildEntry("2026-2", [...courses].reverse(), { now: 2000 });
  const first = addEntry([], e1);
  assert.equal(first.ok, true);
  const second = addEntry(first.list, e2);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "duplicate");
  assert.equal(second.list.length, 1, "거절됐으면 목록은 그대로");
});

test("addEntry: 학기가 다르면 같은 조합이어도 담긴다", () => {
  const courses = [C("국어", "월", [1, 2])];
  const r1 = addEntry([], buildEntry("2026-1", courses, { now: 1 }));
  const r2 = addEntry(r1.list, buildEntry("2026-2", courses, { now: 2 }));
  assert.equal(r2.ok, true);
  assert.equal(r2.list.length, 2);
});

test("addEntry: 최신 항목이 맨 위로", () => {
  const r1 = addEntry([], buildEntry("2026-2", [C("가", "월", [1])], { now: 1 }));
  const r2 = addEntry(r1.list, buildEntry("2026-2", [C("나", "화", [2])], { now: 2 }));
  assert.equal(r2.list[0].courses[0].name, "나");
});

test("addEntry: 상한을 넘으면 담지 않고 기존 것을 말없이 버리지 않는다", () => {
  let list = [];
  for (let i = 0; i < WISHLIST_MAX; i++) {
    const r = addEntry(list, buildEntry("2026-2", [C(`과목${i}`, "월", [i + 1])], { now: i }));
    assert.equal(r.ok, true);
    list = r.list;
  }
  const over = addEntry(list, buildEntry("2026-2", [C("초과", "금", [8])], { now: 999 }));
  assert.equal(over.ok, false);
  assert.equal(over.reason, "full");
  assert.equal(over.list.length, WISHLIST_MAX, "기존 항목이 유지돼야");
});

test("removeEntry: id로 지우고 나머지는 유지", () => {
  const e1 = buildEntry("2026-2", [C("가", "월", [1])], { now: 1 });
  const e2 = buildEntry("2026-2", [C("나", "화", [2])], { now: 2 });
  const list = [e1, e2];
  const after = removeEntry(list, e1.id);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, e2.id);
});

test("entriesForSemester: 해당 학기만 골라낸다", () => {
  const list = [
    buildEntry("2026-1", [C("가", "월", [1])], { now: 1 }),
    buildEntry("2026-2", [C("나", "화", [2])], { now: 2 }),
  ];
  assert.equal(entriesForSemester(list, "2026-2").length, 1);
  assert.equal(entriesForSemester(list, "2026-2")[0].semester, "2026-2");
});

test("buildEntry: 라벨·학점을 담고 저장시각을 기록", () => {
  const e = buildEntry("2026-2", [C("가", "월", [1])], { label: "A안", totalCredits: 18, now: 0 });
  assert.equal(e.label, "A안");
  assert.equal(e.totalCredits, 18);
  assert.equal(e.semester, "2026-2");
  assert.ok(e.id);
  assert.ok(e.savedAt);
});
