"use client";
// 모더레이션 — 신고 큐·게시물 숨김·직접 제재. (다음 배포에서 활성화)
import Placeholder from "../Placeholder";
export default function ModerationPage() {
  return (
    <Placeholder title="모더레이션"
      lines={[
        "신고 접수 큐를 보고 게시물을 숨기거나 사건을 종료해요.",
        "회원 직접 제재(정지·강퇴·해제)는 감사 일관성을 위해 내부 사건을 만들어 처리해요.",
        "인증 심사는 기존 /admin/verification 을 그대로 써요.",
      ]} />
  );
}
