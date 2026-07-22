"use client";
// 작업·감사 — 관리자 행위 로그. (다음 배포에서 활성화)
import Placeholder from "../Placeholder";
export default function AuditPage() {
  return (
    <Placeholder title="작업·감사"
      lines={[
        "이용권 부여·회수, 제재, 공지 등 관리자 행위가 시각과 사유와 함께 남아요.",
        "모든 관리 RPC가 audit_logs 에 기록을 남기고 있어요.",
        "여기서 그 로그를 필터로 열람하게 만드는 중이에요.",
      ]} />
  );
}
