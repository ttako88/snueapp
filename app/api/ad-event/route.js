// ============================================================
// POST /api/ad-event — 스폰서 노출·클릭 집계 기록 (S6)
// ============================================================
// targetedAds flag OFF 면 아무것도 안 하고 disabled(휴면). 로그인 사용자만
// (requireUser) 기록해 익명 스팸으로 노출수를 부풀리지 못하게 한다. 집계는
// 스폰서×일 카운터만 — 개인·세그먼트 없음(svc_sponsor_event).
// ============================================================
import { NextResponse } from "next/server";
import { serviceClient, requireUser, NO_STORE } from "../../lib/server/verification/auth.mjs";
import { isEnabled } from "../../lib/features.js";

export const runtime = "nodejs";
const json = (body, status) => NextResponse.json(body, { status, headers: NO_STORE });

export async function POST(request) {
  if (!isEnabled("targetedAds")) return json({ status: "disabled" }, 200);

  let svc;
  try { svc = serviceClient(); }
  catch { return json({ error: "service_unavailable" }, 503); }

  const who = await requireUser(request, svc);
  if (who.error) return json({ error: who.error }, who.status);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "bad_request" }, 400); }

  // 클라 sponsor_id 를 받지 않는다. 서버가 발급한 delivery token 만 받고,
  // sponsor_id 는 DB 함수가 token 에서 복원한다(위조·증폭 차단).
  const token = body?.token;
  const kind = body?.kind;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof token !== "string" || !UUID_RE.test(token)) return json({ error: "bad_token" }, 400);
  if (kind !== "impression" && kind !== "click") return json({ error: "bad_kind" }, 400);

  // 세션에서 검증된 member_id 를 넘긴다. DB 가 delivery 소유자와 대조한다.
  const { data, error } = await svc.rpc("svc_ad_event", {
    p_member_id: who.userId, p_token: token, p_kind: kind,
  });
  if (error) return json({ error: "record_failed" }, 500);
  return json({ status: data?.status ?? "ok" }, 200);
}
