// 글 상호작용 데이터 접근 — 추천·스크랩·신고.
// 화면(app/board/*)은 이 함수들만 호출하고 Supabase 쿼리를 직접 쓰지 않는다.
// 보안 경계는 여기가 아니라 DB(RLS·definer 함수)다.
//
// 시그니처는 추측하지 않고 운영 카탈로그에서 확인한 값이다
// (scripts/manual/diag-rpc-contracts.mjs). 이름·인자·반환을 짐작해서
// 붙이면 빌드는 통과하고 런타임에서만 터진다.

import { supabase } from "../supabase/client";
import { asBigintParam, invalidIdResult } from "./ids";

/** 추천/반대 값. 같은 값을 다시 누르면 취소다(DB가 토글로 처리). */
export const VOTE = { UP: 1, DOWN: -1, CANCEL: 0 };

/** 신고 사유 — DB check 제약과 같은 목록이어야 한다 */
export const REPORT_REASONS = [
  { code: "abuse", label: "욕설·괴롭힘" },
  { code: "hate", label: "혐오 표현" },
  { code: "privacy", label: "개인정보 노출" },
  { code: "obscene_illegal", label: "음란물·불법" },
  { code: "spam", label: "스팸·도배" },
  { code: "fraud", label: "사기·거래 사고" },
  { code: "misinfo", label: "허위 정보" },
  { code: "copyright", label: "저작권 침해" },
  { code: "off_topic", label: "게시판 주제와 무관" },
  { code: "other", label: "기타" },
];

/**
 * 추천/반대. p_value 는 smallint 라 숫자로 넘긴다.
 * 반환은 jsonb — 서버가 계산한 최신 집계가 들어온다.
 */
export function votePost(postId, value) {
  const p = asBigintParam(postId);
  if (p === null) return Promise.resolve(invalidIdResult());
  if (![VOTE.UP, VOTE.DOWN, VOTE.CANCEL].includes(value)) {
    return Promise.resolve({ data: null, error: { message: "invalid vote value" } });
  }
  return supabase.rpc("vote_post", { p_post_id: p, p_value: value });
}

/** 스크랩 토글. 반환 jsonb 로 현재 상태가 온다. */
export function toggleBookmark(postId) {
  const p = asBigintParam(postId);
  if (p === null) return Promise.resolve(invalidIdResult());
  return supabase.rpc("toggle_bookmark", { p_post_id: p });
}

/** 내 스크랩 목록. 커서 페이지네이션 인자는 기본값이 있어 생략 가능. */
export function listMyBookmarks({ limit = 50, before = null, beforePost = null } = {}) {
  return supabase.rpc("list_my_bookmarks", {
    p_limit: limit,
    p_before: before,
    p_before_post: beforePost === null ? null : asBigintParam(beforePost),
  });
}

/**
 * 신고. target_type 은 'post' 또는 'comment'.
 * detail 은 500자 제한이라 여기서 잘라 보낸다 — 서버 거부보다 낫다.
 */
export function submitReport({ targetType, targetId, reasonCode, detail }) {
  const p = asBigintParam(targetId);
  if (p === null) return Promise.resolve(invalidIdResult());
  if (!["post", "comment"].includes(targetType)) {
    return Promise.resolve({ data: null, error: { message: "invalid target type" } });
  }
  if (!REPORT_REASONS.some((r) => r.code === reasonCode)) {
    return Promise.resolve({ data: null, error: { message: "invalid reason" } });
  }
  return supabase.rpc("submit_report", {
    p_target_type: targetType,
    p_target_id: p,
    p_reason_code: reasonCode,
    p_detail: (detail ?? "").slice(0, 500) || null,
  });
}
