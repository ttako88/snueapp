// ============================================================
// POST /api/admin/members/delete — 회원 계정 강제 삭제 (owner 전용)
// ============================================================
// ⚠️ 비가역(L3). 안전장치: owner 만 · 본인 삭제 금지 · 운영진(staff) 삭제 금지 ·
//    사유 필수. 기존 삭제 파이프라인 재사용: prepare(hold·detach) → auth 삭제(cascade).
//    깡통(미인증) 계정은 enforcement hold 없이 깨끗이 지워지고 학번·아이디가 풀린다.
import { NextResponse } from "next/server";
import { serviceClient, requireUser, NO_STORE } from "../../../../lib/server/verification/auth.mjs";

export const runtime = "nodejs";
const json = (b, s) => NextResponse.json(b, { status: s, headers: NO_STORE });

export async function POST(request) {
  let svc;
  try { svc = serviceClient(); } catch { return json({ error: "service_unavailable" }, 503); }

  const who = await requireUser(request, svc);
  if (who.error) return json({ error: who.error }, who.status);

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }
  const { memberId, reason } = body || {};
  if (typeof memberId !== "string" || !memberId) return json({ error: "bad_request" }, 400);
  if (typeof reason !== "string" || reason.trim().length < 2) return json({ error: "reason_required" }, 400);

  // 호출자는 owner 여야 한다 (강제 삭제는 최고권한만).
  let callerRole = null;
  try { const { data } = await svc.rpc("svc_reviewer_role", { p_actor_id: who.userId }); callerRole = data ?? null; } catch { callerRole = null; }
  if (callerRole !== "owner") return json({ error: "forbidden" }, 403);

  // 본인 삭제 금지.
  if (memberId === who.userId) return json({ error: "cannot_delete_self" }, 400);

  // 대상이 운영진(moderator/operator/owner)이면 이 도구로는 삭제 금지 — 일반 회원만.
  let targetRole = null;
  try { const { data } = await svc.rpc("svc_reviewer_role", { p_actor_id: memberId }); targetRole = data ?? null; } catch { targetRole = null; }
  if (targetRole !== null) return json({ error: "cannot_delete_staff" }, 403);

  // 삭제 준비(제재/사건 시 hold, 콘텐츠 detach). 미인증 깡통은 hold 없이 통과.
  try {
    await svc.rpc("prepare_account_deletion", { p_member_id: memberId });
    await svc.rpc("detach_member_content", { p_member_id: memberId });
  } catch { return json({ error: "prepare_failed" }, 500); }

  // auth.users 삭제 → members 및 참조 테이블(account_identity·consents·academic 등) cascade.
  const { error: dErr } = await svc.auth.admin.deleteUser(memberId);
  if (dErr) return json({ error: "delete_failed" }, 500);

  return json({ ok: true }, 200);
}
