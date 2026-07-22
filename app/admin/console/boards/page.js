"use client";
// 게시판 운영 — 게시판별 공지 작성·고정. (다음 배포에서 활성화)
import Placeholder from "../Placeholder";
export default function BoardsPage() {
  return (
    <Placeholder title="게시판 운영"
      lines={[
        "게시판별 공지를 바로 작성하고 상단에 고정해요.",
        "게시글 숨김·복원도 여기서 처리해요.",
        "기존 set_post_notice(운영자 공지 고정) RPC 위에 UI를 올리는 중이에요.",
      ]} />
  );
}
