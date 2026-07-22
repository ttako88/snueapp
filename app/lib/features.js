// 기능 모듈 스위치판 — "붙였다 뗐다" 하는 곳.
//
// 밤샘 자율작업(2026-07-21)에서 만든 기능들은 전부 "모듈"로 준비돼 있고,
// 여기 enabled를 true/false로 바꾸는 것만으로 앱에 붙거나 떨어진다.
//
// ── 쓰는 법 ──────────────────────────────────────────────
//   기능 켜기 = 해당 항목 enabled: true 로 한 줄 수정
//   기능 끄기 = enabled: false
//   needsDb: true 인 모듈은 켜기 전에 supabase/migrations/pending/ 의
//            해당 SQL을 먼저 적용해야 한다 (안 하면 화면은 뜨지만 저장 실패).
//   requires: 먼저 끝나 있어야 하는 선행 조건. 안 지키면 사고 나는 것들이라
//            주석이 아니라 필드로 박아둠.
// ────────────────────────────────────────────────────────
//
// ⚠️ 이 파일은 UX 스위치일 뿐 보안 경계가 아니다.
//    권한의 최종 기준은 DB(RLS·definer 함수)이며, 여기서 켜도 DB가 막으면 막힌다.
//    (감사보고서 12.8 "permissions.js는 UX 미러" 원칙과 동일)

export const FEATURES = {
  // ── 정보 축 (DB 불필요 — 켜면 즉시 동작) ──
  courseSearch: {
    enabled: true,
    label: "강의조회",
    summary: "courses.json 기반 강의 검색·상세. 학과·학년·학기·교수 필터",
    needsDb: false,
    requires: null,
  },

  // ── 커뮤니티 축 (DB 필요) ──
  courseReview: {
    enabled: false,
    label: "강의평가",
    summary: "1인1회·수정불가 강의평 + 시험정보(족보) + 티켓 이코노미",
    needsDb: true,
    requires: "과목 마스터 적재 (private.course_review_subjects 가 비어 있으면 평가 대상이 없다)",
  },
  boardNotice: {
    enabled: true,
    label: "게시판 공지 고정",
    summary: "운영자/owner가 게시판별 공지를 상단 고정",
    needsDb: true,
    requires: "Gate 4a 운영배포 완료 (role 필요)",
  },
  postVote: {
    enabled: true,
    label: "추천/반대",
    summary: "글 추천·반대 (중복 방지는 DB 유니크 제약)",
    needsDb: true,
    requires: "Gate 4a 운영배포 완료",
  },
  bookmark: {
    enabled: true,
    label: "스크랩",
    summary: "글 스크랩 + 마이페이지 모아보기",
    needsDb: true,
    requires: "Gate 4a 운영배포 완료",
  },
  report: {
    enabled: true,
    label: "신고",
    summary: "사유 선택 신고 → 모더레이션 사건 생성",
    needsDb: true,
    requires: "Gate 4a 운영배포 완료",
  },
  bugReport: {
    enabled: true,
    label: "버그제보",
    summary: "설정에서 버그 제보 + 내 제보 처리상태 확인",
    needsDb: true,
    requires: "Gate 4a 운영배포 완료",
  },
  mealTicketMarket: {
    enabled: false,
    label: "식권 마켓",
    summary: "오늘 급식 화면에서 원터치 '식권 팔아요/구해요'",
    needsDb: true,
    requires: "Gate 4a 운영배포 완료",
  },

  aiCreditCharge: {
    enabled: false,
    label: "지도안 생성 SR 차감",
    summary: "약안 −10 SR / 세안 −25 SR. 끄면 로그인만 하면 무제한이다",
    needsDb: true,
    // ⚠️ 이 flag 가 OFF 면 개인별 제한이 **없다**. 018 의 일일 예산 상한은
    //    "소유자 지갑이 하루에 얼마까지 나가는가" 만 정하므로, 한 계정이
    //    하루치를 통째로 소진하면 나머지 전원이 못 쓴다.
    requires: "022_currency_split.sql → 023_ai_credit_charge.sql 순서로 적용",
  },
  practicumPlacement: {
    enabled: false,
    label: "학기별 실습학교",
    summary: "2-1~4-1 다섯 학기 실습학교 설정. 학교별 게시판 진입 조건이 된다",
    needsDb: true,
    // ⚠️ 019 를 적용하지 않고 켜면 화면은 뜨지만 저장이 전부 실패한다.
    //    학교 목록은 앱 데이터(practicumSchools.json)라 DB 없이도 그려진다.
    requires: "supabase/migrations/pending/019_practicum_placement.sql 적용",
  },

  // ── AI 지도안 공개 범위 ──
  lessonPlanPublic: {
    enabled: false,
    label: "지도안 생성 일반 공개",
    summary: "OFF면 owner 만 생성 가능(소유자 지갑 보호). ON이면 인증회원도 가능",
    needsDb: false,
    // ⚠️ 로그인 개방(015) 후 이 flag 가 OFF 면 owner 외 생성 차단(서버 게이트).
    //    켜기 전 aiCreditCharge(개인별 SR 차감)로 남용·비용을 막아야 한다.
    requires: "aiCreditCharge 활성(개인별 한도) — 안 켜고 공개하면 예산 소진 위험",
  },

  // ── 분석·수익화 (2026-07-22 goal, 전부 준비 후 flag 로 켠다) ──
  hakbeonAutofill: {
    enabled: false,
    label: "학번 자동채움",
    summary: "학생 인증 때 받은 학번으로 학년·학과·권장 시간표 초안 자동 로드",
    needsDb: true,
    // 파생 저장소·서버 재계산 경로가 있어야 한다. 클라 파생값은 신뢰하지 않는다.
    requires: "024_analytics_consent.sql 적용 + finalize 라우트 학번 파생 저장",
  },
  productAnalytics: {
    enabled: true, // 2026-07-23 활성화: Analytics 마운트+track 배선+처리방침 반영. 미동의=익명 카운터만, 동의 시 학과·학년 세그먼트.
    label: "상세 이용통계 + 운영자 대시보드",
    summary: "동의 회원의 가명 이용 이벤트 집계 + /admin/analytics 세그먼트 통계",
    needsDb: true,
    // ⚠️ 동의(product_analytics) 없는 회원은 카운터만. 사업자등록 불요.
    requires: "024(동의·파생) + 025(usage_events) 적용 + /api/track + 대시보드",
  },
  ga4: {
    enabled: false,
    label: "GA4 방문 통계",
    summary: "익명 방문·페이지뷰만. Consent Mode(기본 거부) + 학과·학년·학번 미전송",
    needsDb: false,
    // ⚠️ NEXT_PUBLIC_GA_MEASUREMENT_ID(소유자 등록) 없으면 켜도 no-op. CSP 에
    //    googletagmanager.com 허용 필요(인프라). 처리방침·Play/App 라벨 일치 후 켠다.
    requires: "NEXT_PUBLIC_GA_MEASUREMENT_ID + CSP 허용 + 처리방침 반영",
  },
  targetedAds: {
    enabled: false,
    label: "학과·학년 맞춤 스폰서 광고",
    summary: "동의(18+) 회원에게 학과·학년 first-party 스폰서 슬롯. 미동의=일반광고",
    needsDb: true,
    // ⚠️ 전부 구현하되 사업자등록 전까지 OFF 휴면(소유자 지시). 켜기 전 GPT MUST·
    //    사업자등록 확인 필요. 광고주엔 개인정보 미전송·집계만.
    requires: "사업자등록 완료 + 광고 코드(S6) 배포 + GPT 활성 검수",
  },

  // ── 계정 ──
  socialLogin: {
    enabled: false,
    label: "소셜 로그인(카카오·구글)",
    summary: "OAuth 로그인 + identity linking",
    needsDb: false,
    // 감사보고서 R2: 회원모델 없이 붙이면 1인 다계정이 데이터에 고착되고
    // 소급 병합이 불가능해진다. 이 조건은 반드시 지킬 것.
    requires: "Gate 4a 운영배포 완료 + 카카오/구글 키 발급·Supabase 등록",
  },
};

/** 기능이 켜져 있는지. 모르는 키는 꺼진 것으로 본다(오타로 기능이 열리는 사고 방지). */
export function isEnabled(key) {
  return FEATURES[key]?.enabled === true;
}

/** 켜져 있는 기능 목록 — 설정 화면·디버그용 */
export function enabledFeatures() {
  return Object.entries(FEATURES)
    .filter(([, f]) => f.enabled)
    .map(([key, f]) => ({ key, ...f }));
}
