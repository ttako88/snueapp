"use client"; // 글 목록을 Supabase에서 불러와 채우므로 브라우저에서 동작

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import SkeletonList from "../../components/SkeletonList";
import { boardBySlug } from "../../lib/boards";
import { authorLabel, fmtDate } from "../../lib/board-fmt";
import { supabase } from "../../lib/supabase/client";
import { fetchBoardPosts, fetchCommentCounts } from "../../lib/community/posts";
import { useAuth } from "../../lib/identity/useAuth";

export default function BoardListPage() {
  const { slug } = useParams();
  const board = boardBySlug(slug);
  const { session, loading: authLoading } = useAuth();

  const [posts, setPosts] = useState([]);
  const [commentCounts, setCommentCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!board || !supabase || authLoading || !session) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetchBoardPosts(slug).then(async ({ data, error: err }) => {
      if (cancelled) return;
      if (err || !data) {
        setError(true);
        setLoading(false);
        return;
      }
      setPosts(data);
      setLoading(false);
      if (data.length === 0) return;
      const counts = await fetchCommentCounts(data.map((p) => p.id));
      if (cancelled) return;
      setCommentCounts(counts);
    });
    return () => {
      cancelled = true;
    };
  }, [slug, board, session, authLoading]);

  if (!board) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm text-[#0c4470]/50">존재하지 않는 게시판이에요.</p>
        <Link href="/board" className="mt-2 inline-block text-sm font-bold text-[#0095da]">
          ‹ 게시판 목록으로
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center gap-2">
        <Link href="/board" className="text-[#0c4470]/50">‹ 게시판</Link>
        <h2 className="text-lg font-bold text-[#0c4470]">
          {board.icon} {board.name}
        </h2>
      </div>

      {!authLoading && session && (
        <Link
          href={`/board/${slug}/new`}
          className="rounded-xl bg-[#0095da] py-2.5 text-center text-sm font-bold text-white active:opacity-80"
        >
          + 글쓰기
        </Link>
      )}

      {authLoading && <SkeletonList count={5} />}

      {!authLoading && !session && (
        <div className="rounded-2xl border border-dashed border-[#0095da]/30 bg-white p-5 text-center">
          <p className="text-sm text-[#0c4470]/50">로그인하면 글을 보고 쓸 수 있어요.</p>
          <Link href="/login" className="mt-3 inline-block rounded-full bg-[#0095da] px-4 py-2 text-sm font-bold text-white active:opacity-80">
            로그인하기
          </Link>
        </div>
      )}

      {!authLoading && session && loading && <SkeletonList count={5} />}

      {!authLoading && session && error && (
        <p className="py-10 text-center text-sm text-[#0c4470]/50">글 목록을 불러오지 못했어요.</p>
      )}

      {!authLoading && session && !loading && !error && posts.length === 0 && (
        <p className="py-10 text-center text-sm text-[#0c4470]/40">
          아직 글이 없어요. 첫 글을 남겨보세요!
        </p>
      )}

      {!authLoading && session && !loading && !error && posts.length > 0 && (
        <ul className="flex flex-col gap-2">
          {posts.map((p) => (
            <li key={p.id}>
              <Link href={`/board/${slug}/${p.id}`} className="block rounded-xl bg-white p-3 shadow-sm active:bg-[#eaf6fd]">
                <p className="line-clamp-2 font-medium text-[#0c4470]">
                  {p.title}
                  {commentCounts[p.id] > 0 && (
                    <span className="ml-1.5 text-xs font-bold text-[#0095da]">[{commentCounts[p.id]}]</span>
                  )}
                </p>
                <p className="mt-1 text-xs text-[#0c4470]/50">
                  {authorLabel(p)} · {fmtDate(p.created_at)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
