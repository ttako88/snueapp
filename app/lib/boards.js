// 게시판 카테고리 정의 (2026-07-19 확정, 글쓰기·댓글은 2026-07-20부터 동작).
// ⚠️ DB의 posts.board CHECK 제약과 이중 정의 상태 — 게시판을 추가하면
// 양쪽을 함께 고쳐야 한다. Gate 4a에서 boards 테이블로 일원화 예정
// (감사보고서 R8). 그 전까지 여기 배열은 화면 표시용.

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
