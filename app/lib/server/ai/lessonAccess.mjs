// ============================================================
// lessonAccess.mjs — 지도안 생성 자금원(funding_source) 판정 (순수 함수)
// ============================================================
// 소유자 지갑에서 실제 돈이 나가는 경로라 "누가 어떤 자격으로 생성하는가" 를
// 한 곳에서 결정한다. RPC 호출(preview·reviewer_role)은 라우트가 하고, 여기서는
// 그 결과만 받아 결정한다 — 그래야 이 표를 mocking 없이 테스트할 수 있다.
//
// funding_source 는 요청당 정확히 하나다 (GPT R2 Q7):
//   OWNER_BYPASS → FREE_ENTITLEMENT → NORMAL_PAID_PATH_IF_ENABLED → DENY
//
// migration 028 미적용 상태로 코드가 먼저 배포될 수 있다. 그때는 preview RPC 가
// 없어 previewAvailable=false 가 되고, 기존 owner-only 동작으로 폴백한다(fail-closed).

/**
 * @param {object} p
 * @param {boolean} p.previewAvailable  preview RPC 가 정상 응답했나(=028 적용됨)
 * @param {string|null} p.previewSource  preview 가 판정한 source ('owner'|'entitlement'|'none'|null)
 * @param {boolean} p.publicOn           lessonPlanPublic flag
 * @param {boolean} p.isOwnerFallback    폴백 경로에서 reviewer_role === 'owner' 인가
 * @returns {{source:'owner'|'entitlement'|'paid'} | {deny:true}}
 */
export function classifyFunding({ previewAvailable, previewSource, publicOn, isOwnerFallback }) {
  if (previewAvailable) {
    if (previewSource === "owner") return { source: "owner" };
    if (previewSource === "entitlement") return { source: "entitlement" };
    // preview 가 자격 없음(none)으로 판정 — 공개 상태면 일반 경로, 아니면 거부.
    return publicOn ? { source: "paid" } : { deny: true };
  }
  // 028 미적용/판정 불가 → 기존 게이트. 공개면 일반 경로, 아니면 owner 만.
  if (publicOn) return { source: "paid" };
  return isOwnerFallback ? { source: "owner" } : { deny: true };
}

/** 폴백(owner 확인)을 위해 reviewer_role 조회가 필요한 상황인지. */
export function needsOwnerFallback({ previewAvailable, publicOn }) {
  return !previewAvailable && !publicOn;
}

import { randomUUID } from "node:crypto";

// 예약↔소비/환불의 멱등 키. **난수(UUID)를 쓴다** — Date.now() 만으로는
// 같은 사용자의 같은 ms 동시요청이 같은 키를 받아 "예약 1건 · 생성 2건" 으로
// quota 를 우회할 수 있다(GPT R3 ACTIVATION_BLOCKER). uuid 로 충돌을 없앤다.
export function newRequestId(prefix, uid, purpose) {
  return `${prefix}:${uid}:${purpose}:${randomUUID()}`;
}
