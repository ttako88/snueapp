// 지도안 생성 분석 콘솔 RPC 래퍼 (035).
// 권한 경계는 DB — admin_lesson_* 가 require_permission('analytics.read') 로 막는다.
import { supabase } from "../supabase/client";

const NO = { error: { message: "unavailable" } };

/** 일일 집계 + 효용지표(업그레이드율·재사용분포·내보내기전환). p_day 없으면 오늘(KST). */
export async function lessonAnalyticsOverview(day = null) {
  if (!supabase) return NO;
  return supabase.rpc("admin_lesson_analytics_overview", { p_day: day });
}

/** 실행 내역 목록(닉네임 포함, 필터·커서). */
export async function lessonRunsList({ limit = 50, before = null,
  planType = null, subject = null, grade = null } = {}) {
  if (!supabase) return NO;
  return supabase.rpc("admin_lesson_runs_list", {
    p_limit: limit, p_before: before,
    p_plan_type: planType, p_subject: subject, p_grade: grade,
  });
}
