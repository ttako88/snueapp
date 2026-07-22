// ============================================================
// track.js — 이용 이벤트 클라이언트 헬퍼 (S3)
// ============================================================
// UI 곳곳에서 track("screen_view","home") 처럼 부른다. 실제 수집·동의 분기·
// 세그먼트는 서버(/api/track → svc_track_event)가 한다. 여기서는 보내기만 한다.
//
// 원칙
//   · flag(productAnalytics) 가 OFF 면 아무것도 안 한다(휴면).
//   · 텔레메트리는 UX 를 절대 못 깬다 — 비차단(fire-and-forget). 실패는 무시한다
//     (best-effort). 부가 계측이 본 기능을 막지 않게 하는 것이지, 판정을 삼키는
//     방어가 아니다.
//   · 세그먼트·개인정보를 여기서 붙이지 않는다. event 이름과 target 슬러그만 보낸다.
//   · 인증 토큰은 authedPost(검증된 세션 경로)로 실어 보낸다. 서버는 토큰에서
//     얻은 uid 만 신뢰하고, 세그먼트는 서버가 member_academic 에서 읽는다.
// ============================================================
import { isEnabled } from "./features.js";
import { authedPost } from "./community/apiFetch.js";

const SLUG_RE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * 이용 이벤트 1건 전송(비차단). 허용 이벤트·target 은 서버 registry 가 최종 판정한다.
 * @param {string} event  예: "screen_view" | "button_click" | ...
 * @param {string|null} [target] 예: "home" | "create_post". 없으면 생략.
 */
export function track(event, target = null) {
  if (!isEnabled("productAnalytics")) return;
  if (typeof event !== "string" || !SLUG_RE.test(event)) return;
  if (target != null && (typeof target !== "string" || !SLUG_RE.test(target))) return;
  if (typeof window === "undefined") return;

  // 기다리지 않는다. authedPost 는 스스로 오류를 삼켜 결과 객체로 돌려주므로
  // 여기서는 반환 프라미스를 그냥 흘려보낸다(계측이 UX 를 막지 않게).
  void authedPost("/api/track", target == null ? { event } : { event, target });
}
