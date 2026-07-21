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
    enabled: true,
    label: "강의평가",
    summary: "1인1회·수정불가 강의평 + 시험정보(족보) + 티켓 이코노미",
    needsDb: true,
    requires: "Gate 4a 운영배포 완료 (회원모델·역할 필요)",
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
