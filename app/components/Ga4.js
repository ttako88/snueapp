"use client";
// ============================================================
// Ga4 — GA4 로더 (S5, Basic Consent Mode). GPT 최종검수 B3 반영.
// ============================================================
// 불변식: "비동의 문서에는 GA 태그가 존재하지 않고 Google 요청이 0."
//   · 동의 전에는 <Script> 를 렌더하지 않아 태그가 문서에 없다.
//   · 한 번 로드된 태그는 denyConsent() 만으로 사라지지 않는다(공식 흐름도 unload
//     절차가 없다). 그래서 **철회·로그아웃·계정전환**이 감지되면 window.location
//     .reload() 로 깨끗한 문서로 full navigation 한다 → 다음 문서엔 gtag.js·bootstrap
//     이 없다. 계정전환 시 이전 사용자의 granted 를 승계하지 않는다.
//   · 동의 GRANT 도 깨끗한 문서에서 로드돼야 한다: 동의 설정 UI(consent.js)가
//     product_analytics 토글 성공 후 full navigation 을 일으킨다(활성화 시 배선).
//
// 활성화 시 app/layout 에 <Ga4/> 를 얹는다(현재는 미배선=완전 휴면).
import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { isEnabled } from "../lib/features.js";
import { useAuth } from "../lib/identity/useAuth";
import { gaReady, bootstrapHtml, pageview } from "../lib/analytics/ga.js";
import { getMyConsents } from "../lib/community/consent.js";

export default function Ga4() {
  const pathname = usePathname();
  const { session } = useAuth();
  const userId = session?.user?.id ?? null;
  const enabled = isEnabled("ga4") && gaReady();
  const [consented, setConsented] = useState(false);
  // GA 태그가 이 문서에서 로드된 대상 사용자(없으면 null).
  const loadedForRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      let ok = false;
      if (enabled && userId) {
        const { data } = await getMyConsents();
        ok = data?.product_analytics?.granted === true;
      }
      if (!alive) return;

      // 이미 태그가 로드된 문서에서 (계정전환 || 로그아웃 || 철회)가 감지되면
      // 태그를 없앨 방법이 reload 뿐이다 → 깨끗한 문서로 full navigation.
      const loadedFor = loadedForRef.current;
      if (loadedFor !== null && (loadedFor !== userId || !ok)) {
        if (typeof window !== "undefined") window.location.reload();
        return;
      }
      setConsented(ok);
    })();
    return () => { alive = false; };
  }, [enabled, userId]);

  // 동의자에 한해 경로 변경 시 페이지뷰(경로만).
  useEffect(() => {
    if (enabled && consented && pathname) pageview(pathname);
  }, [enabled, consented, pathname]);

  if (!enabled || !consented) return null;
  // 동의된 사용자에게만: 인라인 부트스트랩이 default denied→granted→config→로더주입.
  return (
    <Script
      id="ga-bootstrap"
      strategy="afterInteractive"
      onLoad={() => { loadedForRef.current = userId; }}
      dangerouslySetInnerHTML={{ __html: bootstrapHtml() }}
    />
  );
}
