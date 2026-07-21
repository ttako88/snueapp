// 학생 인증 데이터 접근 — 신청자 조회 + 심사자 처리.
//
// 제출(begin_verification)은 여기 없다. 그건 service_role 전용이라
// 브라우저에서 부를 수 없고 서버 라우트를 거쳐야 한다. 학번 HMAC 을
// 서버에서 계산해야 하기 때문이다.
//
// 시그니처는 운영 카탈로그 확인값이다.

import { supabase } from "../supabase/client";
import { asBigintParam, invalidIdResult } from "./ids";

/** 반려 사유 — DB check 제약과 같은 목록이어야 한다 */
export const REJECT_REASONS = [
  { code: "unreadable", label: "글자를 알아볼 수 없음" },
  { code: "mismatch", label: "정보가 일치하지 않음" },
  { code: "expired_doc", label: "유효기간이 지난 서류" },
  { code: "wrong_doc", label: "제출 서류 종류가 다름" },
  { code: "suspected_forgery", label: "위·변조 의심" },
  { code: "other", label: "기타" },
];

export const DOC_TYPE_LABEL = {
  student_card: "학생증",
  smart_id: "모바일 학생증",
  enrollment_cert: "재학증명서",
  leave_cert: "학적증명서",
};

export const VERIFICATION_STATUS_LABEL = {
  pending: "미제출",
  under_review: "심사 중",
  submitted: "심사 대기",
  verified: "인증 완료",
  rejected: "반려됨",
};

/** 내 신청 이력 (일반 사용자) */
export function listMyVerificationRequests() {
  return supabase.rpc("get_my_verification_requests");
}

/** 내 신청 철회 */
export function withdrawVerification(requestId) {
  const p = asBigintParam(requestId);
  if (p === null) return Promise.resolve(invalidIdResult());
  return supabase.rpc("withdraw_verification", { p_request_id: p });
}

/**
 * 심사 대기 목록 (operator 이상).
 * 권한이 없으면 DB 가 'not allowed' 로 거부한다 — 화면에서 미리 막더라도
 * 그건 UX 이고 실제 경계는 여기가 아니다.
 */
export function listVerificationRequests() {
  return supabase.rpc("list_verification_requests");
}

/**
 * 승인 또는 반려.
 * 반려일 때만 사유 코드가 필요하고, 승인일 때 사유를 넣으면 DB 가 거부한다
 * (status='rejected' 와 reject_reason_code 존재가 양방향 제약이다).
 */
export function reviewVerification({ requestId, approve, rejectCode }) {
  const p = asBigintParam(requestId);
  if (p === null) return Promise.resolve(invalidIdResult());
  if (!approve && !REJECT_REASONS.some((r) => r.code === rejectCode)) {
    return Promise.resolve({ data: null, error: { message: "반려 사유를 골라주세요." } });
  }
  return supabase.rpc("review_verification", {
    p_request_id: p,
    p_approve: approve,
    p_reject_code: approve ? null : rejectCode,
  });
}
