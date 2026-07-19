import Link from "next/link";
import { BOARDS } from "../lib/boards";

// 게시판 목록 — 카테고리 구조만 먼저 확정 (2026-07-19). 글쓰기는 계정 시스템 이후.
export default function BoardPage() {
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div>
        <h2 className="text-lg font-bold text-[#0c4470]">게시판</h2>
        <p className="mt-0.5 text-xs text-[#0c4470]/50">
          계정 시스템이 준비되면 하나씩 열릴 예정이에요. 어떤 게시판이 있는지 먼저 둘러보세요!
        </p>
      </div>

      <ul className="flex flex-col gap-2">
        {BOARDS.map((b) => (
          <li key={b.slug}>
            <Link
              href={`/board/${b.slug}`}
              className="flex items-center gap-3 rounded-2xl bg-white p-3.5 shadow-sm active:bg-[#eaf6fd]"
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#eaf6fd] text-xl">
                {b.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-bold text-[#0c4470]">{b.name}</span>
                <span className="block truncate text-xs text-[#0c4470]/50">{b.teaser}</span>
              </span>
              <span className="shrink-0 rounded-full bg-black/5 px-2 py-0.5 text-[10px] font-bold text-[#0c4470]/40">
                준비 중
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
