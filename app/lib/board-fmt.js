// 게시판 화면 공용 표시 헬퍼 (목록·상세·댓글에서 재사용)

export function authorLabel(row) {
  if (row.is_anonymous) return "익명";
  return row.author_nickname || "탈퇴한 사용자";
}

export function fmtDate(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
