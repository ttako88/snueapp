"use client"; // 스크랩 목록을 Supabase에서 불러옴

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "../../lib/identity/useAuth";
import { supabase } from "../../lib/supabase/client";
import { listMyBookmarks } from "../../lib/community/interactions";
import { fmtDate } from "../../lib/board-fmt";

// 글에서 스크랩(북마크)은 되는데 모아볼 화면이 없었다 — 이 페이지가 그걸 보여준다.
export default function BookmarksPage() {
  const { session, loading } = useAuth();
  const [rows, setRows] = useState([]);
  const [state, setState] = useState("idle"); // idle | loading | ok | empty | error

  useEffect(() => {
    let alive = true;
    (async () => {
      if (loading) return;
      if (!session || !supabase) { if (alive) setState("idle"); return; }
      setState("loading");
      const { data, error } = await listMyBookmarks({ limit: 50 });
      if (!alive) return;
      if (error) setState("error");
      else { setRows(data || []); setState((data || []).length ? "ok" : "empty"); }
    })();
    return () => { alive = false; };
  }, [session, loading]);

  return (
    <Shell>
      {loading && <Muted>확인 중이에요…</Muted>}

      {!loading && !session && (
        <div className="rounded-2xl border border-dashed border-[#0095da]/30 bg-white p-5 text-center">
          <p className="text-sm text-[#0c4470]/50">로그인하면 스크랩한 글을 모아볼 수 있어요.</p>
          <Link href="/login" className="mt-3 inline-block rounded-full bg-[#0095da] px-4 py-2 text-sm font-bold text-white">로그인하기</Link>
        </div>
      )}

      {session && state === "loading" && <Muted>불러오는 중…</Muted>}
      {session && state === "error" && <p className="py-8 text-center text-sm text-[#0c4470]/50">불러오지 못했어요.</p>}
      {session && state === "empty" && (
        <p className="py-10 text-center text-sm text-[#0c4470]/40">아직 스크랩한 글이 없어요.<br />글 아래 <b>스크랩</b>을 누르면 여기 모여요.</p>
      )}
      {session && state === "ok" && (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.post_id}>
              <Link href={`/board/${r.board_slug}/${r.post_id}`} className="block rounded-xl bg-white p-3 shadow-sm active:bg-[#eaf6fd]">
                <p className="line-clamp-2 font-medium text-[#0c4470]">{r.title}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-[#0c4470]/50">
                  <span>{r.author_nickname || "익명"}</span>
                  <span>·</span>
                  <span>{fmtDate(r.created_at)}</span>
                  {r.comment_count > 0 && <span>· 댓글 {r.comment_count}</span>}
                  {r.bookmarked_at && <span className="text-[#0095da]">· 스크랩 {fmtDate(r.bookmarked_at)}</span>}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center gap-2">
        <Link href="/settings" className="text-[#0c4470]/50">‹</Link>
        <h2 className="text-lg font-bold text-[#0c4470]">내 스크랩</h2>
      </div>
      {children}
    </div>
  );
}
function Muted({ children }) {
  return <p className="text-sm text-[#0c4470]/50">{children}</p>;
}
