import Link from "next/link";
import { notFound } from "next/navigation";
import { boardBySlug } from "../../lib/boards";

// 게시판 상세 자리 — 계정 시스템(Phase 2) 완성 후 실제 글 목록으로 교체될 예정.
export default async function BoardDetailPage({ params }) {
  const { slug } = await params;
  const board = boardBySlug(slug);
  if (!board) notFound();

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <Link href="/board" className="absolute left-4 top-4 text-sm text-[#0c4470]/50">
        ‹ 게시판
      </Link>
      <span className="text-5xl">{board.icon}</span>
      <h2 className="text-xl font-bold text-[#0c4470]">{board.name}</h2>
      <p className="text-sm text-[#0c4470]/50">{board.teaser}</p>
      <p className="mt-2 max-w-[260px] text-xs text-[#0c4470]/40">
        계정 시스템이 만들어지면 이 게시판에서 글을 쓰고 볼 수 있게 돼요. 조금만 기다려주세요!
      </p>
    </div>
  );
}
