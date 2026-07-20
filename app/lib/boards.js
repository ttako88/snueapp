// 게시판 카테고리 정의 (2026-07-19 확정, 글쓰기·댓글은 2026-07-20부터 동작).
// ⚠️ DB의 posts.board CHECK 제약과 이중 정의 상태 — 게시판을 추가하면
// 양쪽을 함께 고쳐야 한다. Gate 4a에서 boards 테이블로 일원화 예정
// (감사보고서 R8). 그 전까지 여기 배열은 화면 표시용.

// teaser는 게시판의 대표 성격을 알리는 안내 문구일 뿐, 다룰 수 있는 주제를 한정하지 않는다.
// (예시를 강제 규칙처럼 보이게 하지 말 것 — 특히 비밀게시판은 특정 주제 전용이 아님.)
export const BOARDS = [
  { slug: "free", icon: "🗣️", name: "자유게시판", teaser: "자유롭게 이야기해요" },
  { slug: "secret", icon: "🤫", name: "비밀게시판", teaser: "익명으로 편하게 이야기해요" },
  { slug: "practicum", icon: "👩‍🏫", name: "실습게시판", teaser: "실습에 관한 정보와 이야기" },
  { slug: "promo", icon: "📣", name: "홍보게시판", teaser: "각종 홍보와 안내" },
  { slug: "club", icon: "🎨", name: "동아리게시판", teaser: "동아리·학회 소식과 이야기" },
  { slug: "teacher-exam", icon: "📖", name: "임용고시 게시판", teaser: "임용고시 관련 정보와 이야기" },
  { slug: "market", icon: "🛒", name: "장터게시판", teaser: "물품 거래와 나눔" },
  { slug: "alumni", icon: "🎓", name: "졸업생게시판", teaser: "졸업생·재학생의 이야기" },
  { slug: "dorm", icon: "🌲", name: "서록관 게시판", teaser: "서록관(기숙사) 생활 이야기" },
];

export function boardBySlug(slug) {
  return BOARDS.find((b) => b.slug === slug) || null;
}
