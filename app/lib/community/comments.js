// 댓글 데이터 접근 (커뮤니티 도메인 경계 — posts.js와 같은 원칙)
import { supabase } from "../supabase/client";

export function fetchComments(postId) {
  return supabase
    .from("comments")
    .select("id, body, author_nickname, is_anonymous, created_at, deleted_at")
    .eq("post_id", postId)
    .is("deleted_at", null)
    .order("id", { ascending: true });
}

// 내 댓글 id 집합 — comment_owners RLS(본인 행만 보임) 이용
export async function fetchOwnedCommentIds(commentIds) {
  if (!commentIds.length) return new Set();
  const { data } = await supabase
    .from("comment_owners")
    .select("comment_id")
    .in("comment_id", commentIds);
  return new Set((data || []).map((o) => o.comment_id));
}

export function createComment({ postId, body, isAnonymous }) {
  return supabase.from("comments").insert({ post_id: postId, body, is_anonymous: isAnonymous });
}

export function softDeleteComment(id) {
  return supabase.from("comments").update({ deleted_at: new Date().toISOString() }).eq("id", id);
}
