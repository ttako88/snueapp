// 시간표 장바구니(위시리스트) — 마법사가 만든 조합을 여러 벌 담아두고 나중에 비교·적용.
//
// 에타의 "같은 학기에 여러 시간표를 동시에 계획"(design.md §12.1)에 해당한다.
// 수강신청 실패를 대비해 예비 시간표를 미리 여러 벌 짜두는 용도.
// 전부 기기 로컬(localStorage)에만 저장 — 서버·계정 불필요.

const KEY = "ttWishlist";
export const WISHLIST_MAX = 10; // 무한정 쌓이면 고르기가 더 어려워짐

// ── 순수 로직 (저장소와 분리 — 테스트 대상) ──────────────────

/** 강의 하나의 서명. courses.json의 courseId와 달리 JSON import에 의존하지 않는다. */
function sigOf(c) {
  return `${c.name}|${c.section ?? ""}|${c.day}|${[...(c.periods || [])].sort((a, b) => a - b).join("")}`;
}

/** 조합(강의 배열)의 서명 — 순서가 달라도 같은 조합이면 같은 값 */
export function comboSignature(courses) {
  return (courses || []).map(sigOf).sort().join("//");
}

/** 담을 항목 하나를 만든다 (id는 시각 기반 — 저장소 없이도 만들 수 있게 now를 주입) */
export function buildEntry(semester, courses, { label = "", totalCredits = null, now = Date.now() } = {}) {
  return {
    id: `w${now}`,
    semester,
    label: label || "",
    totalCredits,
    savedAt: new Date(now).toISOString(),
    signature: comboSignature(courses),
    courses: courses || [],
  };
}

/**
 * 목록에 항목 추가.
 * - 같은 학기에 이미 똑같은 조합이 있으면 담지 않는다(중복 방지).
 * - 최대 개수를 넘으면 담지 않는다(가장 오래된 것을 말없이 버리지 않음 — 사용자가 지우게).
 * 반환: { ok, list, reason }
 */
export function addEntry(list, entry, max = WISHLIST_MAX) {
  const cur = list || [];
  if (cur.some((e) => e.semester === entry.semester && e.signature === entry.signature)) {
    return { ok: false, list: cur, reason: "duplicate" };
  }
  if (cur.length >= max) {
    return { ok: false, list: cur, reason: "full" };
  }
  return { ok: true, list: [entry, ...cur], reason: null }; // 최신이 위로
}

export function removeEntry(list, id) {
  return (list || []).filter((e) => e.id !== id);
}

/** 특정 학기의 항목만 */
export function entriesForSemester(list, semester) {
  return (list || []).filter((e) => e.semester === semester);
}

// ── 저장소 (브라우저 전용) ──────────────────────────────────

export function loadWishlist() {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // 손상된 값이 앱을 멈추게 하지 않는다
  }
}

export function saveWishlist(list) {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify(list || []));
}
