// 게시글 데이터 접근 (커뮤니티 도메인 경계 — 감사보고서 12.6).
// 화면(app/board/*)은 이 함수들만 호출하고 Supabase 쿼리를 직접 쓰지 않는다.
// 보안 경계는 여기가 아니라 DB RLS다 — 이 모듈은 "쿼리를 한 곳에 모아
// 정책 변경 시 수정 지점을 예측 가능하게" 하는 코드 경계일 뿐이다.
import { supabase } from "../supabase/client";

// 목록: 삭제 안 된 글, 최신순. 허용 필드만 선택.
export function fetchBoardPosts(board) {
  return supabase
    .from("posts")
    .select("id, title, author_nickname, is_anonymous, created_at")
    .eq("board", board)
    .is("deleted_at", null)
    .order("id", { ascending: false });
}

// 글 목록의 댓글 수 집계 (삭제된 댓글 제외)
export async function fetchCommentCounts(postIds) {
  const { data } = await supabase
    .from("comments")
    .select("post_id")
    .in("post_id", postIds)
    .is("deleted_at", null);
  const counts = {};
  for (const c of data || []) counts[c.post_id] = (counts[c.post_id] || 0) + 1;
  return counts;
}

export function createPost({ board, title, body, isAnonymous }) {
  return supabase
    .from("posts")
    .insert({ board, title, body, is_anonymous: isAnonymous })
    .select("id")
    .single();
}

export function fetchPost(id) {
  return supabase
    .from("posts")
    .select("id, title, body, author_nickname, is_anonymous, created_at, updated_at, deleted_at")
    .eq("id", id)
    .maybeSingle();
}

// 내 글인지 — post_owners RLS(본인 행만 보임)를 그대로 이용: 조회되면 내 것
export async function isPostOwner(id) {
  const { data } = await supabase.from("post_owners").select("post_id").eq("post_id", id).maybeSingle();
  return Boolean(data);
}

export function updatePost(id, { title, body }) {
  return supabase.from("posts").update({ title, body }).eq("id", id);
}

// soft delete만 — 하드 삭제는 DB 정책상 아무도 불가
export function softDeletePost(id) {
  return supabase.from("posts").update({ deleted_at: new Date().toISOString() }).eq("id", id);
}
