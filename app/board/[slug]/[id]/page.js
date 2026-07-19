"use client"; // 글·댓글을 Supabase에서 불러와 채우므로 브라우저에서 동작

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { boardBySlug } from "../../../lib/boards";
import { authorLabel, fmtDate } from "../../../lib/board-fmt";
import { supabase } from "../../../lib/supabase";
import { useAuth } from "../../../lib/useAuth";

export default function PostDetailPage() {
  const { slug, id } = useParams();
  const router = useRouter();
  const board = boardBySlug(slug);
  const { session, profile, loading: authLoading } = useAuth();

  const [post, setPost] = useState(null);
  const [isOwner, setIsOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [saving, setSaving] = useState(false);

  const [comments, setComments] = useState([]);
  const [ownedCommentIds, setOwnedCommentIds] = useState(new Set());
  const [commentBody, setCommentBody] = useState("");
  const [commentAnon, setCommentAnon] = useState(false);
  const [postingComment, setPostingComment] = useState(false);

  async function loadPost() {
    setLoading(true);
    setError(false);
    const { data, error: err } = await supabase
      .from("posts")
      .select("id, title, body, author_nickname, is_anonymous, created_at, updated_at, deleted_at")
      .eq("id", id)
      .maybeSingle();
    if (err || !data || data.deleted_at) {
      setError(true);
      setLoading(false);
      return;
    }
    setPost(data);
    setEditTitle(data.title);
    setEditBody(data.body);
    setLoading(false);
    const { data: own } = await supabase.from("post_owners").select("post_id").eq("post_id", id).maybeSingle();
    setIsOwner(Boolean(own));
  }

  async function loadComments() {
    const { data } = await supabase
      .from("comments")
      .select("id, body, author_nickname, is_anonymous, created_at, deleted_at")
      .eq("post_id", id)
      .is("deleted_at", null)
      .order("id", { ascending: true });
    setComments(data || []);
    if (data && data.length) {
      const { data: own } = await supabase
        .from("comment_owners")
        .select("comment_id")
        .in("comment_id", data.map((c) => c.id));
      setOwnedCommentIds(new Set((own || []).map((o) => o.comment_id)));
    } else {
      setOwnedCommentIds(new Set());
    }
  }

  useEffect(() => {
    if (!board || !supabase || authLoading || !session) return;
    loadPost();
    loadComments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, board, session, authLoading]);

  async function saveEdit() {
    const t = editTitle.trim();
    const b = editBody.trim();
    if (!t || !b) return;
    setSaving(true);
    const { error: err } = await supabase.from("posts").update({ title: t, body: b }).eq("id", id);
    setSaving(false);
    if (err) {
      alert(`수정에 실패했어요 (${err.message})`);
      return;
    }
    setEditing(false);
    loadPost();
  }

  async function deletePost() {
    if (!confirm("정말 삭제할까요? 되돌릴 수 없어요.")) return;
    const { error: err } = await supabase.from("posts").update({ deleted_at: new Date().toISOString() }).eq("id", id);
    if (err) {
      alert(`삭제에 실패했어요 (${err.message})`);
      return;
    }
    router.push(`/board/${slug}`);
  }

  async function submitComment() {
    const b = commentBody.trim();
    if (!b) return;
    setPostingComment(true);
    const { error: err } = await supabase.from("comments").insert({ post_id: Number(id), body: b, is_anonymous: commentAnon });
    setPostingComment(false);
    if (err) {
      alert(`댓글 등록에 실패했어요 (${err.message})`);
      return;
    }
    setCommentBody("");
    loadComments();
  }

  async function deleteComment(cid) {
    if (!confirm("댓글을 삭제할까요?")) return;
    const { error: err } = await supabase.from("comments").update({ deleted_at: new Date().toISOString() }).eq("id", cid);
    if (err) {
      alert(`삭제에 실패했어요 (${err.message})`);
      return;
    }
    loadComments();
  }

  if (!board) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm text-[#0c4470]/50">존재하지 않는 게시판이에요.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <Link href={`/board/${slug}`} className="text-sm text-[#0c4470]/50">‹ {board.name}</Link>

      {authLoading && <p className="py-10 text-center text-sm text-[#0c4470]/40">확인 중...</p>}

      {!authLoading && !session && (
        <div className="rounded-2xl border border-dashed border-[#0095da]/30 bg-white p-5 text-center">
          <p className="text-sm text-[#0c4470]/50">로그인하면 글을 볼 수 있어요.</p>
          <Link href="/login" className="mt-3 inline-block rounded-full bg-[#0095da] px-4 py-2 text-sm font-bold text-white active:opacity-80">
            로그인하기
          </Link>
        </div>
      )}

      {!authLoading && session && loading && <p className="py-10 text-center text-sm text-[#0c4470]/40">불러오는 중... 🦌</p>}

      {!authLoading && session && !loading && error && (
        <p className="py-10 text-center text-sm text-[#0c4470]/50">글을 찾을 수 없어요. 삭제됐을 수 있어요.</p>
      )}

      {!authLoading && session && !loading && !error && post && (
        <>
          <article className="rounded-2xl bg-white p-4 shadow-sm">
            {editing ? (
              <div className="flex flex-col gap-2">
                <input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  maxLength={100}
                  className="w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
                />
                <textarea
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  rows={8}
                  maxLength={10000}
                  className="w-full resize-none rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => setEditing(false)}
                    className="rounded-xl bg-black/5 px-4 py-2 text-sm font-medium text-[#0c4470]/60"
                  >
                    취소
                  </button>
                  <button
                    onClick={saveEdit}
                    disabled={saving}
                    className="flex-1 rounded-xl bg-[#0095da] py-2 text-sm font-bold text-white active:opacity-80 disabled:opacity-40"
                  >
                    {saving ? "저장 중..." : "저장"}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="mb-3 flex items-start justify-between gap-2 border-b border-black/5 pb-3">
                  <div className="min-w-0">
                    <h2 className="font-bold text-[#0c4470]">{post.title}</h2>
                    <p className="mt-1 text-xs text-[#0c4470]/50">
                      {authorLabel(post)} · {fmtDate(post.created_at)}
                      {post.updated_at ? " (수정됨)" : ""}
                    </p>
                  </div>
                  {isOwner && (
                    <div className="flex shrink-0 gap-1.5">
                      <button onClick={() => setEditing(true)} className="text-xs font-bold text-[#0095da]">수정</button>
                      <button onClick={deletePost} className="text-xs font-bold text-[#d05b6a]">삭제</button>
                    </div>
                  )}
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-[#0c4470]/90">{post.body}</p>
              </>
            )}
          </article>

          {/* 댓글 */}
          <section className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="mb-2 text-xs font-bold text-[#0c4470]/40">댓글 {comments.length}</p>
            {comments.length === 0 ? (
              <p className="py-4 text-center text-xs text-[#0c4470]/35">아직 댓글이 없어요.</p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {comments.map((c) => (
                  <li key={c.id} className="border-b border-black/5 pb-2.5 last:border-0 last:pb-0">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-bold text-[#0c4470]/60">
                        {authorLabel(c)} <span className="font-normal text-[#0c4470]/35">· {fmtDate(c.created_at)}</span>
                      </p>
                      {ownedCommentIds.has(c.id) && (
                        <button onClick={() => deleteComment(c.id)} className="shrink-0 text-[11px] font-bold text-[#d05b6a]/80">
                          삭제
                        </button>
                      )}
                    </div>
                    <p className="mt-0.5 whitespace-pre-wrap text-sm text-[#0c4470]/85">{c.body}</p>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-3 flex flex-col gap-2 border-t border-black/5 pt-3">
              <textarea
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                placeholder={profile ? `${profile.nickname}(으)로 댓글 남기기` : "댓글을 입력해주세요"}
                rows={2}
                maxLength={2000}
                className="w-full resize-none rounded-xl bg-[#f2f6fa] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
              />
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-1.5 text-xs text-[#0c4470]/60">
                  <input
                    type="checkbox"
                    checked={commentAnon}
                    onChange={(e) => setCommentAnon(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[#0095da]"
                  />
                  익명
                </label>
                <button
                  onClick={submitComment}
                  disabled={postingComment || !commentBody.trim()}
                  className="rounded-full bg-[#0095da] px-4 py-1.5 text-xs font-bold text-white active:opacity-80 disabled:opacity-40"
                >
                  {postingComment ? "등록 중..." : "댓글 등록"}
                </button>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
