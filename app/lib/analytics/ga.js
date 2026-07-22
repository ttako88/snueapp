// ============================================================
// ga.js — GA4 Basic Consent Mode 헬퍼 (S5, GPT 검수 반영)
// ============================================================
// 원칙 (검수 MUST)
//   · **Basic Consent Mode**: 상세통계 동의(product_analytics=true) 전에는 GA 태그를
//     아예 로드하지 않는다 → Google 로 가는 요청 0(cookieless ping 포함 0).
//     (Advanced 모드는 denied 여도 모델링용 ping 을 보내 opt-in 취지와 어긋난다.)
//   · 동의된 사용자에게만 렌더되는 단일 인라인 부트스트랩이 (1) consent default
//     denied 를 dataLayer 에 먼저 넣고 (2) analytics_storage 만 granted 로 올린 뒤
//     (3) config 하고 (4) gtag.js 로더를 스스로 주입한다 → 순서가 보장된다.
//   · 익명 방문·페이지뷰만. 학과·학년·학번·회원ID·쿼리 미전송. IP 익명화.
// ============================================================

// 측정 ID는 클라이언트에 그대로 박히는 공개값이라 시크릿이 아니다. env 를 우선
// 쓰되(교체·회전 편의), 없으면 등록된 SNUE 속성 ID 로 폴백한다(2026-07-23).
export const GA_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || "G-T287GHDNWQ";

// 측정 ID 형식 검증 — 인라인 스크립트에 넣기 전에 반드시 통과해야 한다(주입 차단).
export const GA_ID_RE = /^G-[A-Z0-9]{4,20}$/;
export function gaReady() {
  return !!GA_ID && GA_ID_RE.test(GA_ID);
}

// 동의된 사용자에게만 렌더하는 인라인 부트스트랩. default denied → analytics granted
// → config → 로더 주입 순서를 한 블록에서 보장한다. GA_ID 는 형식검증된 값만.
export function bootstrapHtml() {
  if (!gaReady()) return "";
  const id = GA_ID;
  return (
    "window.dataLayer=window.dataLayer||[];" +
    "function gtag(){dataLayer.push(arguments);}window.gtag=gtag;" +
    "gtag('consent','default',{'ad_storage':'denied','ad_user_data':'denied'," +
    "'ad_personalization':'denied','analytics_storage':'denied'});" +
    "gtag('consent','update',{'analytics_storage':'granted'});" +
    "gtag('js',new Date());" +
    "gtag('config','" + id + "',{'anonymize_ip':true,'send_page_view':false});" +
    "var s=document.createElement('script');s.async=true;" +
    "s.src='https://www.googletagmanager.com/gtag/js?id=" + id + "';" +
    "document.head.appendChild(s);"
  );
}

// 페이지뷰 1건 — 경로만. 학과·학년 등 커스텀 차원은 붙이지 않는다.
export function pageview(path) {
  if (typeof window === "undefined" || !window.gtag || !gaReady()) return;
  window.gtag("event", "page_view", { page_path: path });
}

// 동의 철회·로그아웃·계정전환 시 즉시 거부로 되돌린다(이미 로드된 태그 대비).
export function denyConsent() {
  if (typeof window === "undefined" || !window.gtag) return;
  window.gtag("consent", "update", {
    analytics_storage: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
}
