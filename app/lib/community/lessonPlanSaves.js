// 지도안 저장/불러오기 + 내 이용권 상태 래퍼.
import { supabase } from "../supabase/client";

const NO = { error: { message: "unavailable" } };

export async function saveLessonPlan({ planType, title, body }) {
  if (!supabase) return NO;
  const { data, error } = await supabase.rpc("save_lesson_plan", {
    p_plan_type: planType, p_title: title, p_body: body,
  });
  if (error) return { error };
  if (data?.ok !== true) return { error: { message: data?.reason || "save_failed" } };
  return { data };
}

export async function listMyLessonPlans() {
  if (!supabase) return NO;
  return supabase.rpc("list_my_lesson_plans");
}

export async function getMyLessonPlan(id) {
  if (!supabase) return NO;
  return supabase.rpc("get_my_lesson_plan", { p_id: id });
}

export async function deleteMyLessonPlan(id) {
  if (!supabase) return NO;
  return supabase.rpc("delete_my_lesson_plan", { p_id: id });
}

/** 내 지도안 이용권 상태 — { allowed, source: 'owner'|'entitlement'|'none', remaining? } */
export async function myLessonPlanAccess() {
  if (!supabase) return NO;
  return supabase.rpc("my_lesson_plan_access");
}
