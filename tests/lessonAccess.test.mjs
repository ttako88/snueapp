// 지도안 자금원 판정표 테스트 — 소유자 지갑을 지키는 게이트라 표를 못 박는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFunding, needsOwnerFallback, newRequestId } from "../app/lib/server/ai/lessonAccess.mjs";

// ── 028 적용됨(previewAvailable=true) ──
test("preview owner → owner (공개 여부 무관)", () => {
  assert.deepEqual(
    classifyFunding({ previewAvailable: true, previewSource: "owner", publicOn: false, isOwnerFallback: false }),
    { source: "owner" });
});

test("preview entitlement → entitlement (비공개여도 이용권으로 통과)", () => {
  assert.deepEqual(
    classifyFunding({ previewAvailable: true, previewSource: "entitlement", publicOn: false, isOwnerFallback: false }),
    { source: "entitlement" });
});

test("preview none + 비공개 → 거부", () => {
  assert.deepEqual(
    classifyFunding({ previewAvailable: true, previewSource: "none", publicOn: false, isOwnerFallback: false }),
    { deny: true });
});

test("preview none + 공개 → paid", () => {
  assert.deepEqual(
    classifyFunding({ previewAvailable: true, previewSource: "none", publicOn: true, isOwnerFallback: false }),
    { source: "paid" });
});

// ── 028 미적용(previewAvailable=false) → 기존 게이트로 폴백 ──
test("미적용 + 비공개 + owner → owner (기존 동작 보존)", () => {
  assert.deepEqual(
    classifyFunding({ previewAvailable: false, previewSource: null, publicOn: false, isOwnerFallback: true }),
    { source: "owner" });
});

test("미적용 + 비공개 + 비owner → 거부 (fail-closed)", () => {
  assert.deepEqual(
    classifyFunding({ previewAvailable: false, previewSource: null, publicOn: false, isOwnerFallback: false }),
    { deny: true });
});

test("미적용 + 공개 → paid", () => {
  assert.deepEqual(
    classifyFunding({ previewAvailable: false, previewSource: null, publicOn: true, isOwnerFallback: false }),
    { source: "paid" });
});

// ── 폴백 필요 여부 ──
test("폴백은 미적용 + 비공개일 때만 필요", () => {
  assert.equal(needsOwnerFallback({ previewAvailable: false, publicOn: false }), true);
  assert.equal(needsOwnerFallback({ previewAvailable: false, publicOn: true }), false);
  assert.equal(needsOwnerFallback({ previewAvailable: true, publicOn: false }), false);
  assert.equal(needsOwnerFallback({ previewAvailable: true, publicOn: true }), false);
});

// ── 불변식: entitlement 는 절대 SR/결제를 유발하지 않는다 ──
test("entitlement 판정은 paid 로 새지 않는다", () => {
  for (const publicOn of [true, false]) {
    const d = classifyFunding({ previewAvailable: true, previewSource: "entitlement", publicOn, isOwnerFallback: false });
    assert.deepEqual(d, { source: "entitlement" });
  }
});

// ── request_id 충돌 저항 (GPT R3 ACTIVATION_BLOCKER PASS_CONDITION) ──
// 같은 사용자·같은 목적·같은 시각(병렬)이라도 request_id 는 전부 달라야 한다.
// Date.now() 만 쓰면 같은 ms 에 충돌해 예약 1건·생성 2건으로 quota 를 우회한다.
test("newRequestId: 같은 시각 대량 생성에도 전부 유일하다", () => {
  const uid = "11111111-2222-3333-4444-555555555555";
  const ids = new Set();
  const N = 20000;
  for (let i = 0; i < N; i++) ids.add(newRequestId("ent", uid, "lesson_plan_brief"));
  assert.equal(ids.size, N, "모든 request_id 가 유일해야 한다");
});

test("newRequestId: 형식은 prefix:uid:purpose:uuid", () => {
  const id = newRequestId("ent", "abc", "lesson_plan_full");
  const m = /^ent:abc:lesson_plan_full:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
  assert.ok(m, `형식 불일치: ${id}`);
});
