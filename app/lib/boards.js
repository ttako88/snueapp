// 게시판 카테고리 정의 (2026-07-19 조상호님과 확정).
// 실제 글쓰기·댓글은 계정 시스템(Phase 2) 완성 후 열림 — 지금은 카테고리 구조만.
// 여기 배열만 고치면 게시판 목록·상세 안내가 함께 바뀜.

export const BOARDS = [
  { slug: "free", icon: "🗣️", name: "자유게시판", teaser: "자유롭게 이야기해요" },
  { slug: "secret", icon: "🤫", name: "비밀게시판", teaser: "교수님·강의 후기, 익명으로 편하게" },
  { slug: "practicum", icon: "👩‍🏫", name: "실습게시판", teaser: "실습 정보 공유와 동기들과의 소통" },
  { slug: "promo", icon: "📣", name: "홍보게시판", teaser: "동아리·행사·프로그램 홍보" },
  { slug: "club", icon: "🎨", name: "동아리게시판", teaser: "동아리·학회 소식과 모집" },
  { slug: "teacher-exam", icon: "📖", name: "임용고시 게시판", teaser: "임고 정보와 스터디 모집" },
  { slug: "market", icon: "🛒", name: "장터게시판", teaser: "교재·물품 거래" },
  { slug: "alumni", icon: "🎓", name: "졸업생게시판", teaser: "졸업생과 재학생의 소통" },
  { slug: "dorm", icon: "🌲", name: "서록관 게시판", teaser: "기숙사(서록관) 생활 정보" },
];

export function boardBySlug(slug) {
  return BOARDS.find((b) => b.slug === slug) || null;
}
