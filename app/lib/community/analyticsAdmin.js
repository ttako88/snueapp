// 운영자 대시보드 RPC 래퍼 (S4).
//
// 권한 경계는 DB 다 — analytics_* 함수가 첫 문장에서 actor_role_check('operator')
// 를 부르고 조회를 audit 로 남긴다. 화면을 우회해 RPC 를 직접 불러도 막힌다.
// 여기서는 집계만 받는다. 개인 단위 원시행은 서버가 애초에 반환하지 않는다.

import { supabase } from "../supabase/client";

export async function analyticsOverview() {
  if (!supabase) return { error: { message: "unavailable" } };
  return supabase.rpc("analytics_overview");
}

// 직전 완결 ISO 주 세그먼트(불변 스냅샷). 기간 파라미터 없음 — 주간 단일 cadence.
export async function analyticsEventSegments(event) {
  if (!supabase) return { error: { message: "unavailable" } };
  return supabase.rpc("analytics_event_segments", { p_event: event });
}

export async function analyticsDaily(event, days = 30) {
  if (!supabase) return { error: { message: "unavailable" } };
  return supabase.rpc("analytics_daily", { p_event: event, p_days: days });
}
