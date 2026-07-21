// 학생 인증 데이터 접근 — 신청자 조회 + 심사자 처리.
//
// 제출(begin_verification)은 여기 없다. 그건 service_role 전용이라
// 브라우저에서 부를 수 없고 서버 라우트를 거쳐야 한다. 학번 HMAC 을
// 서버에서 계산해야 하기 때문이다.
//
// 시그니처는 운영 카탈로그 확인값이다.

import { supabase } from "../supabase/client";
import { authedPost } from "./apiFetch";
import { asBigintParam, invalidIdResult } from "./ids";

/**
 * 심사용 서류 열람 URL. 서버가 권한을 다시 확인하고 60초짜리 signed URL 을
 * 발급한다. 경로는 서버가 DB 에서 찾는다 — 여기서 경로를 보낼 수 없다.
 * 열람 사실은 서버가 audit_logs 에 남긴다.
 */
export async function requestDocumentUrl(requestId) {
  const id = asBigintParam(requestId);
  if (id === null) return { error: { code: "bad_request" } };
  return authedPost("/api/verification/document", { requestId: id });
}

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

/**
 * 신청 1건의 상태. 위 VERIFICATION_STATUS_LABEL 은 "회원" 의 상태라 값이 다르다
 * — 섞어 쓰면 화면에 빈칸이 뜬다. DB check 제약(002)과 같은 7종.
 */
export const REQUEST_STATUS_LABEL = {
  uploading: "업로드 대기",
  submitted: "심사 대기",
  approved: "승인됨",
  rejected: "반려됨",
  withdrawn: "철회함",
  upload_expired: "기한 만료",
  expired_unreviewed: "미심사 만료",
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
