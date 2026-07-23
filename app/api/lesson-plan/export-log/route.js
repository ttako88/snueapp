// ============================================================
// POST /api/lesson-plan/export-log — 지도안 내보내기(docx/hwp/pdf) 기록
// ============================================================
// 내보내기는 클라이언트에서 일어나므로, 어떤 형식으로 뽑았는지 서버가 모른다.
// 클라가 { runId, format } 을 보내면 해당 run 의 내보내기 시각을 남긴다(035).
// 부수효과라 실패해도 사용자 흐름을 막지 않는다.
import { NextResponse } from "next/server";
import { serviceClient, requireUser, NO_STORE } from "../../../lib/server/verification/auth.mjs";

export const runtime = "nodejs";
const json = (body, status) => NextResponse.json(body, { status, headers: NO_STORE });

export async function POST(request) {
  let svc;
  try { svc = serviceClient(); } catch { return json({ error: "service_unavailable" }, 503); }

  const who = await requireUser(request, svc);
  if (who.error) return json({ error: who.error }, who.status);

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }
  const runId = String(body?.runId ?? "");
  const format = String(body?.format ?? "");
  if (!runId || !["docx", "hwp", "pdf"].includes(format)) return json({ error: "bad_request" }, 400);

  // svc_mark_lesson_export 는 member 소유를 검증하고 timestamp 만 갱신한다.
  const { data, error } = await svc.rpc("svc_mark_lesson_export", {
    p_member_id: who.userId, p_run_id: runId, p_format: format,
  });
  if (error) return json({ ok: false }, 200); // 부수효과 실패는 조용히
  return json({ ok: data === true }, 200);
}
