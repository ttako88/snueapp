// ============================================================
// POST /api/track — 이용 이벤트 수집 (S3)
// ============================================================
// 설계 근거: docs/ANALYTICS_DESIGN_DRAFT_2026-07-22.md, 025_usage_events.sql.
//
// 얇은 층이다. 진짜 판정(allowlist·동의 분기·세그먼트)은 DB 의 svc_track_event 가
// 한다. 이 라우트는 (1) 세션 검증으로 member_id 를 얻고, (2) 형식만 1차로 거르고,
// (3) service_role 로 RPC 를 부른다 — begin_verification 과 같은 신뢰경계다.
//
// 왜 클라이언트가 세그먼트를 안 보내나: 클라 파생값은 신뢰하지 않는다(GPT MUST).
// 학과·학년 세그먼트는 서버가 member_academic 에서 읽는다.
//
// flag(productAnalytics) 가 OFF 면 아무것도 수집하지 않고 disabled 로 응답한다 —
// 라우트가 존재해도 휴면이다.
// ============================================================
import { NextResponse } from "next/server";
import { serviceClient, requireUser, NO_STORE } from "../../lib/server/verification/auth.mjs";
import { isEnabled } from "../../lib/features.js";

export const runtime = "nodejs";

const json = (body, status) => NextResponse.json(body, { status, headers: NO_STORE });

// 라우트 층의 1차 형식 검사. 최종 allowlist 는 DB registry 가 판정한다.
const EVENT_RE = /^[a-z][a-z0-9_]{0,39}$/;
const TARGET_RE = /^[a-z][a-z0-9_]{0,39}$/;

export async function POST(request) {
  // flag OFF = 휴면. 수집 경로를 아예 열지 않는다.
  if (!isEnabled("productAnalytics")) return json({ status: "disabled" }, 200);

  let svc;
  try { svc = serviceClient(); }
  catch { return json({ error: "service_unavailable" }, 503); }

  const who = await requireUser(request, svc);
  if (who.error) return json({ error: who.error }, who.status);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "bad_request" }, 400); }

  const event = body?.event;
  // target 은 없을 수 있다(예: error). 있으면 슬러그여야 한다.
  const target = body?.target == null ? null : body.target;
  if (typeof event !== "string" || !EVENT_RE.test(event)) {
    return json({ error: "bad_event" }, 400);
  }
  if (target !== null && (typeof target !== "string" || !TARGET_RE.test(target))) {
    return json({ error: "bad_target" }, 400);
  }

  const { data, error } = await svc.rpc("svc_track_event", {
    p_member_id: who.userId,
    p_event: event,
    p_target: target,
  });
  if (error) return json({ error: "track_failed" }, 500);
  // data.status 는 'ok' | 'not_allowed'. 미등록 이벤트도 200 으로 조용히 무시한다
  // (계측 오류가 UX 를 깨지 않게). 로그로만 남길 수 있으나 여기선 상태만 반환한다.
  return json({ status: data?.status ?? "ok" }, 200);
}
