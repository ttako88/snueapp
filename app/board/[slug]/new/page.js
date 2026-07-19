"use client"; // 글쓰기는 로그인 세션이 필요하므로 브라우저에서 처리

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { boardBySlug } from "../../../lib/boards";
import { createPost } from "../../../lib/community/posts";
import { useAuth } from "../../../lib/identity/useAuth";

export default function NewPostPage() {
  const { slug } = useParams();
  const router = useRouter();
  const board = boardBySlug(slug);
  const { session, profile, loading, profileLoading } = useAuth();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!board) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm text-[#0c4470]/50">존재하지 않는 게시판이에요.</p>
      </div>
    );
  }

  async function submit() {
    const t = title.trim();
    const b = body.trim();
    if (!t) return setError("제목을 입력해주세요.");
    if (!b) return setError("내용을 입력해주세요.");
    setBusy(true);
    setError(null);
    const { data, error: err } = await createPost({ board: slug, title: t, body: b, isAnonymous });
    setBusy(false);
    if (err) {
      setError(`글을 등록하지 못했어요 (${err.message})`);
      return;
    }
    router.push(`/board/${slug}/${data.id}`);
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center gap-2">
        <Link href={`/board/${slug}`} className="text-[#0c4470]/50">‹ {board.name}</Link>
        <h2 className="text-lg font-bold text-[#0c4470]">글쓰기</h2>
      </div>

      {(loading || profileLoading) && <p className="py-8 text-center text-sm text-[#0c4470]/40">확인 중...</p>}

      {!loading && !profileLoading && !session && (
        <div className="rounded-2xl border border-dashed border-[#0095da]/30 bg-white p-5 text-center">
          <p className="text-sm text-[#0c4470]/50">글을 쓰려면 먼저 로그인해주세요.</p>
          <Link href="/login" className="mt-3 inline-block rounded-full bg-[#0095da] px-4 py-2 text-sm font-bold text-white active:opacity-80">
            로그인하기
          </Link>
        </div>
      )}

      {!loading && !profileLoading && session && !profile && (
        <div className="rounded-2xl border border-dashed border-[#0095da]/30 bg-white p-5 text-center">
          <p className="text-sm text-[#0c4470]/50">닉네임 설정을 먼저 마쳐주세요.</p>
          <Link href="/login" className="mt-3 inline-block rounded-full bg-[#0095da] px-4 py-2 text-sm font-bold text-white active:opacity-80">
            계속하기
          </Link>
        </div>
      )}

      {!loading && !profileLoading && session && profile && (
        <div className="flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-sm">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="제목"
            maxLength={100}
            className="w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="내용을 입력해주세요"
            rows={10}
            maxLength={10000}
            className="w-full resize-none rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
          />
          <label className="flex items-center gap-2 text-sm text-[#0c4470]">
            <input
              type="checkbox"
              checked={isAnonymous}
              onChange={(e) => setIsAnonymous(e.target.checked)}
              className="h-4 w-4 accent-[#0095da]"
            />
            익명으로 작성 ({profile.nickname} 대신 "익명"으로 표시돼요)
          </label>

          {error && <p className="rounded-lg bg-[#fdecec] px-3 py-2 text-xs text-[#d05b6a]">{error}</p>}

          <button
            onClick={submit}
            disabled={busy}
            className="rounded-xl bg-[#0095da] py-2.5 text-sm font-bold text-white active:opacity-80 disabled:opacity-40"
          >
            {busy ? "등록 중..." : "등록하기"}
          </button>
        </div>
      )}
    </div>
  );
}
