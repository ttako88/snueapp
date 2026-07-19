import Link from "next/link";
import { BOARDS } from "../lib/boards";

// 게시판 목록. 실제 글 읽기·쓰기는 로그인 후 각 게시판 안에서.
export default function BoardPage() {
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <h2 className="text-lg font-bold text-[#0c4470]">게시판</h2>

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
              <span className="shrink-0 text-[#0c4470]/25">›</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
