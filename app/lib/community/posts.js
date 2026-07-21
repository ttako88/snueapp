// 게시글 데이터 접근 (커뮤니티 도메인 경계 — 감사보고서 12.6).
// 화면(app/board/*)은 이 함수들만 호출하고 Supabase 쿼리를 직접 쓰지 않는다.
// 보안 경계는 여기가 아니라 DB RLS다 — 이 모듈은 "쿼리를 한 곳에 모아
// 정책 변경 시 수정 지점을 예측 가능하게" 하는 코드 경계일 뿐이다.
import { supabase } from "../supabase/client";
import { asBigintParam, invalidIdResult } from "./ids";
import { resolveBoardId, unknownBoardResult } from "./boards";

// 목록: 삭제 안 된 글, 최신순. 허용 필드만 선택.
//
// 라우트는 슬러그를 주지만 신 스키마는 board_id 로 참조한다.
// 슬러그를 그대로 넣지 않고 boards 에서 해석한다.
export async function fetchBoardPosts(slug) {
  const boardId = await resolveBoardId(slug);
  if (boardId === null) return unknownBoardResult();
  return supabase
    .from("posts")
    .select("id, title, author_nickname, is_anonymous, created_at")
    .eq("board_id", boardId)
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

// board 는 슬러그로 들어온다. board_id 로 번역해 넣는다.
// author_nickname 은 클라이언트가 정하지 않는다 — 트리거가 채운다.
export async function createPost({ board, title, body, isAnonymous }) {
  const boardId = await resolveBoardId(board);
  if (boardId === null) return unknownBoardResult();
  return supabase
    .from("posts")
    .insert({ board_id: boardId, title, body, is_anonymous: isAnonymous })
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

// soft delete만 — 하드 삭제는 DB 정책상 아무도 불가.
//
// 직접 UPDATE 가 아니라 definer RPC 를 쓴다. 007_soft_delete_rpc.sql 이
// authenticated 의 deleted_at 컬럼 UPDATE 권한을 회수했기 때문이다.
// 근본 원인은 RLS UPDATE 가 결과 행이 SELECT 정책으로도 보이길 요구하는데
// posts_select 가 `deleted_at is null` 이라, 삭제하는 순간 결과 행이
// 가시성을 잃어 직접 UPDATE 는 구조적으로 거부된다는 것이다.
//
// id 는 bigint 다. Number 로 바꾸면 2^53 을 넘는 순간 값이 뭉개지므로
// 문자열 그대로 넘긴다. 형식만 검증한다.
export function softDeletePost(id) {
  const p = asBigintParam(id);
  if (p === null) return Promise.resolve(invalidIdResult());
  return supabase.rpc("soft_delete_post", { p_post_id: p });
}
