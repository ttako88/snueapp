// 캘린더에 표시되는 일정 "종류" 정의 — 설정의 표시 토글과 캘린더 필터가 이 한 곳을
// 공유한다. 새 종류가 생기면 CALENDAR_KINDS 배열에 한 줄만 추가하면 설정 토글과
// 캘린더 필터가 함께 확장된다(분류 로직이 여러 파일로 흩어지는 것을 막기 위함).
//
// 규칙:
//  - 이 기능은 일정을 "삭제"하지 않는다. 화면 표시 여부만 끄고 켠다.
//  - 기본값은 "모두 표시"(hidden 없음) = 현재 동작. 사용자가 끈 종류만 저장한다.
//  - 저장은 localStorage("hiddenCalKinds")라 재접속 후에도 유지된다.

const isGrad = (e) => (e.detail || e.title || "").includes("대학원");

export const CALENDAR_KINDS = [
  { key: "school", label: "학사일정", match: (e) => e.source === "school" && !isGrad(e) },
  { key: "graduate", label: "대학원 일정", match: (e) => e.source === "school" && isGrad(e) },
  { key: "eclass", label: "e-Class 마감", match: (e) => e.source === "eclass" },
  { key: "personal", label: "내 일정", match: (e) => e.source === "me" },
];

const STORE_KEY = "hiddenCalKinds";
const LEGACY_GRAD_KEY = "hideGrad"; // 이전 버전의 "대학원 일정 숨기기" 단일 토글

// 저장된 숨김 종류 목록을 읽는다. 이전 버전 사용자의 대학원 숨김 설정을 1회 이관한다.
export function loadHiddenKinds() {
  if (typeof window === "undefined") return [];
  let arr = [];
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) arr = JSON.parse(raw);
  } catch {}
  if (!Array.isArray(arr)) arr = [];
  // 신규 키가 아직 없고 예전 대학원 토글이 켜져 있었다면 그 설정을 보존한다.
  if (localStorage.getItem(STORE_KEY) === null && localStorage.getItem(LEGACY_GRAD_KEY) === "1") {
    arr = ["graduate"];
    saveHiddenKinds(arr);
  }
  // 정의에 없는 오래된 key는 걸러낸다.
  const valid = new Set(CALENDAR_KINDS.map((k) => k.key));
  return arr.filter((k) => valid.has(k));
}

export function saveHiddenKinds(arr) {
  if (typeof window === "undefined") return;
  const valid = new Set(CALENDAR_KINDS.map((k) => k.key));
  const clean = [...new Set(arr)].filter((k) => valid.has(k));
  localStorage.setItem(STORE_KEY, JSON.stringify(clean));
  // 하위호환: 예전 키도 함께 갱신해 두면 구버전 화면과도 어긋나지 않는다.
  localStorage.setItem(LEGACY_GRAD_KEY, clean.includes("graduate") ? "1" : "0");
}

// 이 일정이 현재 숨김 설정에 의해 가려져야 하는가?
export function isKindHidden(hiddenKinds, event) {
  if (!hiddenKinds || hiddenKinds.length === 0) return false;
  const hidden = new Set(hiddenKinds);
  return CALENDAR_KINDS.some((k) => hidden.has(k.key) && k.match(event));
}
