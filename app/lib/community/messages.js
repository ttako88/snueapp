// 알림함(운영 메시지) 래퍼 — 제재 안내·인증 결과 등 받은 메시지.
import { supabase } from "../supabase/client";

const NO = { error: { message: "unavailable" } };

export async function listMyMessages(limit = 50) {
  if (!supabase) return NO;
  return supabase.rpc("list_my_messages", { p_limit: limit });
}

export async function markMessageRead(id) {
  if (!supabase) return NO;
  return supabase.rpc("mark_message_read", { p_id: id });
}

export async function myUnreadMessageCount() {
  if (!supabase) return NO;
  return supabase.rpc("my_unread_message_count");
}
