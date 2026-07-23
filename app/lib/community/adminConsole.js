// 관리자 콘솔 RPC 래퍼 (028).
//
// 권한 경계는 DB 다 — 각 함수가 첫 문장에서 require_permission(...) 을 부르고
// 변경은 audit_logs 에 남긴다. 화면을 우회해 RPC 를 직접 불러도 막힌다.
// 여기서는 호출만 감싼다. PII(실명·학번·이메일·auth id)는 서버가 반환하지 않는다.

import { supabase } from "../supabase/client";

const NO = { error: { message: "unavailable" } };

// ── 권한 미러 (UX 전용) ──────────────────────────────────
// 028 의 role_permissions 시드와 같은 표. 화면 탭 노출·버튼 표시에만 쓴다.
// ⚠️ 실제 경계는 DB(각 RPC 의 require_permission)다. 여기를 통과해도 허용 아님.
export const PERMISSIONS_BY_ROLE = {
  owner: [
    "member.read_basic", "member.detail", "moderation.sanction", "board.notice",
    "sponsor.manage", "flag.manage", "entitlement.read", "entitlement.manage_cost",
    "audit.read", "analytics.read",
  ],
  operator: [
    "member.read_basic", "member.detail", "moderation.sanction", "board.notice",
    "sponsor.manage", "entitlement.read", "audit.read", "analytics.read",
  ],
  moderator: [],
  member: [],
};

/** role 이 perm 을 가지는지 (화면 미러). */
export function roleHasPerm(role, perm) {
  return (PERMISSIONS_BY_ROLE[role] ?? []).includes(perm);
}

// 028(이용권 migration)이 아직 운영에 적용되지 않아 RPC 가 없는 상태인지 판별.
// 그 경우 화면은 오류가 아니라 "아직 활성화 안 됨" 으로 안내한다(붕괴 방지).
// PostgREST 는 함수 부재 시 PGRST202, 또는 "Could not find the function" 메시지를 준다.
export function isNotActivated(err) {
  if (!err) return false;
  const code = err.code || "";
  const msg = (err.message || "").toLowerCase();
  return code === "PGRST202"
    || msg.includes("could not find the function")
    || (msg.includes("function") && msg.includes("does not exist"));
}

/** 현재 로그인 사용자가 가진 관리 권한 목록(문자열 배열). 탭 노출 판정용. */
export async function myAdminPermissions() {
  if (!supabase) return NO;
  return supabase.rpc("my_admin_permissions");
}

/** 회원 목록(커서 페이지네이션). PII 미반환. */
export async function adminListMembers({ search = null, status = null, role = null,
  cursor = null, cursorId = null, limit = 30 } = {}) {
  if (!supabase) return NO;
  return supabase.rpc("admin_list_members", {
    p_search: search, p_status: status, p_role: role,
    p_cursor: cursor, p_cursor_id: cursorId, p_limit: limit,
  });
}

/** 단일 회원 상세(제재·이용권 이력 요약). PII 미반환. */
export async function adminMemberDetail(memberId) {
  if (!supabase) return NO;
  return supabase.rpc("admin_member_detail", { p_member_id: memberId });
}

/** 활성 이용권 현황(부여받은 회원 닉네임 포함, PII 미반환). */
export async function adminListEntitlements(key = null) {
  if (!supabase) return NO;
  return supabase.rpc("admin_list_entitlements", { p_key: key });
}

/** 이용권 부여 — owner(entitlement.manage_cost)만. reason 필수. */
export async function grantEntitlement({ memberId, key, grantType, quota = null,
  expiresAt = null, reason }) {
  if (!supabase) return NO;
  return supabase.rpc("grant_entitlement", {
    p_member_id: memberId, p_key: key, p_grant_type: grantType,
    p_quota: quota, p_expires_at: expiresAt, p_reason: reason,
  });
}

/** 이용권 회수 — owner(entitlement.manage_cost)만. reason 필수. */
export async function revokeEntitlement({ grantId, reason }) {
  if (!supabase) return NO;
  return supabase.rpc("revoke_entitlement", { p_grant_id: grantId, p_reason: reason });
}

/** 회원 메모 저장/삭제(빈값=삭제) — member.detail 권한. */
export async function setMemberNote({ memberId, note }) {
  if (!supabase) return NO;
  return supabase.rpc("set_member_note", { p_member_id: memberId, p_note: note });
}

/** 역할 부여/변경 — owner 만(grant_role 이 DB 에서 재검사·마지막 owner 보호). reason 필수. */
export async function setMemberRole({ memberId, role, reason }) {
  if (!supabase) return NO;
  return supabase.rpc("grant_role", { p_member_id: memberId, p_role: role, p_reason: reason });
}

/** 계정 강제 삭제 — owner 전용 서버 라우트(비가역). reason 필수. */
export async function deleteMember({ memberId, reason }) {
  if (!supabase) return { error: { message: "unavailable" } };
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return { error: { message: "unauthorized" } };
  let res, data;
  try {
    res = await fetch("/api/admin/members/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ memberId, reason }),
    });
    data = await res.json().catch(() => null);
  } catch { return { error: { message: "network" } }; }
  if (!res.ok || data?.ok !== true) return { error: { message: data?.error || "delete_failed" } };
  return { data: { ok: true } };
}
