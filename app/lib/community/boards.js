// 게시판 슬러그 ↔ 식별자 해석.
//
// 구 스키마는 posts.board 에 슬러그 문자열을 그대로 넣었다. 신 스키마는
// boards 테이블을 두고 posts.board_id 로 참조한다. 라우트는 여전히 슬러그
// (/board/free)를 쓰므로 그 사이를 여기서 번역한다.
//
// 슬러그를 id 로 착각해 그대로 넣으면 안 된다 — 타입도 다르고, 우연히
// 숫자로 보이는 슬러그가 생기면 엉뚱한 게시판에 글이 들어간다.

import { supabase } from "../supabase/client";

// 슬러그→id 는 배포 중에 변하지 않으므로 세션 동안 캐시한다.
// 실패는 캐시하지 않는다 — 로그인 직후처럼 권한이 나중에 생기는 경우가 있다.
const cache = new Map();

/**
 * 슬러그에 해당하는 board id 를 돌려준다.
 * 없거나 읽을 수 없으면 null. 호출부가 "존재하지 않는 게시판" 으로 처리한다.
 */
export async function resolveBoardId(slug) {
  if (!slug) return null;
  if (cache.has(slug)) return cache.get(slug);
  const { data, error } = await supabase
    .from("boards")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (error || !data) return null;
  cache.set(slug, data.id);
  return data.id;
}

/** 목록 화면용 — 접근 가능한 게시판만 (RLS 가 걸러준다) */
export function fetchBoards() {
  return supabase
    .from("boards")
    .select("id, slug, name, icon, teaser, sort, access")
    .order("sort", { ascending: true });
}

/** 슬러그를 못 찾았을 때 호출부의 { data, error } 계약에 맞춰 돌려줄 응답 */
export function unknownBoardResult() {
  return { data: null, error: { message: "unknown board" } };
}
