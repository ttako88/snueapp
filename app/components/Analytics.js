"use client";
// ============================================================
// Analytics — 화면 진입 계측(screen_view) + GA4 마운트 (활성화 배선)
// ============================================================
// 레이아웃 한 곳에 얹어 전 화면을 덮는다. 개별 화면마다 track 을 심지 않아도
// 경로 변경마다 screen_view 를 보낸다. 규칙은 track.js 와 동일:
//   · productAnalytics flag OFF 면 track() 이 스스로 no-op(휴면).
//   · 허용 target 만 보낸다(서버 registry 가 최종 판정하지만, 클라에서도
//     registry 에 있는 slug 로만 매핑해 헛요청을 줄인다). 모르는 경로는 안 보낸다.
//   · PII 없음: 경로를 slug 로만 환원(쿼리·id 미포함).
// GA4(<Ga4/>)도 여기서 마운트한다 — 동의·env·flag 3중 게이트라 조건 안 맞으면 스스로 null.
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { track } from "../lib/track.js";
import Ga4 from "./Ga4";

// 경로 → registry screen_view target slug. 긴 접두사부터 검사. 없으면 계측 안 함.
const ROUTES = [
  ["/practicum/lesson-plan", "lesson_plan"],
  ["/settings/verification", "verification"],
  ["/admin/verification", "verification"],
  ["/admin/analytics", "settings"], // 운영자 화면은 settings 범주로 (별도 slug 없음)
  ["/calendar", "calendar"],
  ["/courses", "courses"],
  ["/board", "board"],
  ["/settings", "settings"],
  ["/notice", "notice"],
];

function slugFor(pathname) {
  if (pathname === "/") return "home";
  for (const [prefix, slug] of ROUTES) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) return slug;
  }
  return null; // 모르는 경로는 보내지 않는다
}

export default function Analytics() {
  const pathname = usePathname();
  useEffect(() => {
    const slug = slugFor(pathname || "");
    if (slug) track("screen_view", slug);
  }, [pathname]);
  return <Ga4 />;
}
