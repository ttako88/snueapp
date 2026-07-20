// 시간표 공용 도구 (상수·색·자동채움·그룹핑 로직). 데이터는 파싱해둔 JSON에서.
import COURSES from "../data/courses.json";

export const ALL_COURSES = COURSES;
export const DAYS = ["월", "화", "수", "목", "금"];

// 보유한 학기 데이터 (파싱된 강의시간표 4개 학기분)
export const SEMESTERS = ["2025-1", "2025-2", "2026-1", "2026-2"];
export const SEMESTER_LABELS = {
  "2025-1": "2025년 1학기",
  "2025-2": "2025년 2학기",
  "2026-1": "2026년 1학기",
  "2026-2": "2026년 2학기",
};
export const DEFAULT_SEMESTER = "2026-2"; // 이번 학기(가장 최신 데이터)

// 교시별 시각 (서울교대: 50분 수업+10분 쉬는시간, 4교시 후 점심 40분)
export const PERIOD_TIMES = [
  { p: 1, start: "09:00", end: "09:50" },
  { p: 2, start: "10:00", end: "10:50" },
  { p: 3, start: "11:00", end: "11:50" },
  { p: 4, start: "12:00", end: "12:50" },
  { p: 5, start: "13:30", end: "14:20" },
  { p: 6, start: "14:30", end: "15:20" },
  { p: 7, start: "15:30", end: "16:20" },
  { p: 8, start: "16:30", end: "17:20" },
];

// 심화과정 13개 → 군(A/B) 자동 결정
export const DEPARTMENTS = [
  { name: "윤리", group: "A" },
  { name: "국어", group: "A" },
  { name: "사회", group: "A" },
  { name: "수학", group: "A" },
  { name: "과학", group: "A" },
  { name: "체육", group: "A" },
  { name: "음악", group: "B" },
  { name: "미술", group: "B" },
  { name: "생활과학", group: "B" },
  { name: "교육", group: "B" },
  { name: "영어", group: "B" },
  { name: "컴퓨터", group: "B" },
  { name: "유아특수", group: "B" },
];
export function groupOf(dept) {
  const d = DEPARTMENTS.find((x) => x.name === dept);
  return d ? d.group : "A";
}

// 강의 하나를 식별하는 안정적 키 (학기 포함 — 같은 강의가 매 학기 반복 개설되므로 필수)
export const courseId = (c) =>
  `${c.semester}|${c.grade}${c.group}|${c.name}|${c.section}|${c.day}${c.periods.join("")}`;

// 자동 채움: 내 학년+심화과정+학기의 전공·심화·교직 + 학년 공통필수(교양 제외).
// reqGroup은 2026 공식 교육과정 정답표 기준(파싱 단계에서 과목명→요건 매핑).
// 채움 규칙:
//  ① 유닛 = 같은 reqGroup(택1 요건) 또는 같은 과목명(분반 묶음) — 유닛당 1강좌만.
//     (분반이 여러 개인 필수과목이 통째로 들어가던 문제도 이걸로 함께 해결)
//  ② 심화자유선택(SF:*)은 자동채움에서 제외 — 전 학과 공용 풀이라 본인이 고르는 과목.
//  ③ 배치 순서: 필수(이름 1종) 유닛 먼저 자리 확보 → 택1 유닛은 빈 시간에 맞는
//     멤버를 고름(충돌 회피). 남는 극소수 겹침은 원본 시간표 자체의 실제 중복임.
//  ④ 마지막으로 "공통"과 "특정학과"가 우연히 겹치면 특정학과 쪽을 남기고 공통 제외.
export function autofillCourses(grade, dept, semester = DEFAULT_SEMESTER) {
  const g = groupOf(dept);
  const raw = ALL_COURSES.filter(
    (c) =>
      c.semester === semester &&
      c.grade === grade &&
      c.type !== "교양" &&
      !(c.reqGroup && c.reqGroup.startsWith("SF:")) &&
      (c.dept === dept || (c.dept === "공통" && c.group === g))
  );
  // ① 유닛으로 묶기
  const units = new Map();
  for (const c of raw) {
    const k = c.reqGroup || "n:" + c.name;
    if (!units.has(k)) units.set(k, []);
    units.get(k).push(c);
  }
  // ③ 필수(단일 과목명) 유닛 먼저, 택1 유닛은 빈자리에 맞는 멤버 선택
  const occ = new Set();
  const fits = (c) => c.periods.every((p) => !occ.has(c.day + p));
  const isSingle = (ms) => new Set(ms.map((m) => m.name)).size === 1;
  const ordered = [...units.values()].sort((a, b) => (isSingle(a) ? 0 : 1) - (isSingle(b) ? 0 : 1));
  let result = [];
  for (const ms of ordered) {
    const pick = ms.find(fits) || ms[0];
    for (const p of pick.periods) occ.add(pick.day + p);
    result.push(pick);
  }
  // ④ "공통"과 "특정학과"가 우연히 시간이 겹치면 특정학과 쪽을 남기고 공통 쪽 제외
  const slotMap = new Map();
  for (const c of result) {
    for (const p of c.periods) {
      const slot = c.day + p;
      if (!slotMap.has(slot)) slotMap.set(slot, []);
      slotMap.get(slot).push(c);
    }
  }
  const excluded = new Set();
  for (const list of slotMap.values()) {
    if (list.length < 2) continue;
    if (new Set(list.map((c) => c.name)).size < 2) continue; // 같은 과목 다른 분반은 충돌 아님
    const hasCommon = list.some((c) => c.dept === "공통");
    const hasSpecific = list.some((c) => c.dept !== "공통");
    if (hasCommon && hasSpecific) {
      for (const c of list) if (c.dept === "공통") excluded.add(c);
    }
  }
  if (excluded.size) result = result.filter((c) => !excluded.has(c));
  return result;
}

// ── 시간표 셋업 저장/불러오기 (localStorage 공용 헬퍼) ──
// 강의 탭의 시간표 위젯과 설정 페이지가 같은 로직을 쓰도록 여기 한 곳에 모아둠.
export function loadTimetableSetup() {
  try {
    return JSON.parse(localStorage.getItem("ttSetup") || "null");
  } catch {
    return null;
  }
}

// ── 학기별 시간표 저장 (v2 스키마) ──
// ttSemesters = { "2025-1": Course[], ... } 로 학기마다 따로 보관.
// 구버전(단일 "ttCourses")은 최초 접근 시 당시 설정된 학기 칸으로 자동 이전 —
// 기존 사용자 데이터 손실 금지. (구키는 롤백 대비 당분간 지우지 않고,
// 화면들이 전부 새 헬퍼로 넘어간 뒤 정리한다. 그동안 saveSemesterCourses가
// "현재 학기" 저장 시 구키에도 같이 써서 두 소스가 어긋나지 않게 유지.)
const SEM_STORE_KEY = "ttSemesters";
function readSemStore() {
  try {
    const raw = localStorage.getItem(SEM_STORE_KEY);
    if (raw) return JSON.parse(raw);
    // 마이그레이션: 구버전 단일 시간표 → 그 시점 설정 학기 칸으로
    const old = localStorage.getItem("ttCourses");
    const setup = loadTimetableSetup();
    const store = old ? { [(setup && setup.semester) || DEFAULT_SEMESTER]: JSON.parse(old) } : {};
    localStorage.setItem(SEM_STORE_KEY, JSON.stringify(store));
    return store;
  } catch {
    return {};
  }
}
export function loadSemesterCourses(semester) {
  const store = readSemStore();
  return store[semester] || null; // null = 그 학기는 아직 만든 적 없음
}
export function saveSemesterCourses(semester, courses) {
  const store = readSemStore();
  store[semester] = courses;
  localStorage.setItem(SEM_STORE_KEY, JSON.stringify(store));
  // 과도기 호환: 현재 설정 학기라면 구키에도 동기화 (아직 구키를 읽는 화면 대비)
  const setup = loadTimetableSetup();
  if (setup && setup.semester === semester) {
    localStorage.setItem("ttCourses", JSON.stringify(courses));
  }
}
export function loadAllSemesterCourses() {
  return readSemStore();
}

// ── 사용자 정의 일정 (근로·알바·약속·마이크로디그리 등) ──
// 공식 강의(ttSemesters)와 "완전히 분리된" 저장소. 자동채움·마법사·이수이력은 이 값을
// 절대 읽지 않으므로, 커스텀 일정을 넣어도 공식 강의 데이터/마법사 결과가 바뀌지 않는다.
// 시각은 교시가 아니라 임의의 시작/종료 시간(HH:MM)이라 근로·알바 같은 일정도 담긴다.
// 스키마: ttCustom = { "2026-2": [{ id, title, day, start, end }], ... }
const CUSTOM_STORE_KEY = "ttCustom";
function readCustomStore() {
  try {
    const raw = localStorage.getItem(CUSTOM_STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
export function loadCustomEvents(semester) {
  const store = readCustomStore();
  return Array.isArray(store[semester]) ? store[semester] : [];
}
export function saveCustomEvents(semester, events) {
  const store = readCustomStore();
  store[semester] = events;
  localStorage.setItem(CUSTOM_STORE_KEY, JSON.stringify(store));
}

// 기준 학기·학년으로 다른 학기의 내 학년을 역산. (예: 2026-2에 2학년이면 2025-2는 1학년)
// 1~4 범위 밖(입학 전/졸업 후)이면 null.
export function gradeForSemester(baseSemester, baseGrade, targetSemester) {
  const year = (s) => parseInt(s, 10);
  const g = baseGrade - (year(baseSemester) - year(targetSemester));
  return g >= 1 && g <= 4 ? g : null;
}

// 마법사용: 기준 학기 "이전" 학기들의 저장된 시간표에서 이수 이력 수집.
// 과목명(정규화 없이 원문)과 reqGroup 요건 id 두 집합을 돌려줌 —
// 같은 요건(택1)을 이미 채웠으면 이름이 달라도 제외할 수 있게.
export function collectTakenBefore(semester) {
  const store = readSemStore();
  const names = new Set();
  const groups = new Set();
  const idx = SEMESTERS.indexOf(semester);
  for (const [sem, courses] of Object.entries(store)) {
    const i = SEMESTERS.indexOf(sem);
    if (idx !== -1 && (i === -1 || i >= idx)) continue; // 기준 학기와 그 이후는 제외
    for (const c of courses || []) {
      names.add(c.name);
      if (c.reqGroup) groups.add(c.reqGroup);
    }
  }
  return { names, groups };
}

export function saveTimetableSetup(grade, dept, semester) {
  const setup = { grade, dept, semester };
  localStorage.setItem("ttSetup", JSON.stringify(setup));
  const filled = autofillCourses(grade, dept, semester);
  localStorage.setItem("ttCourses", JSON.stringify(filled));
  saveSemesterCourses(semester, filled);
  return setup;
}

// 두 강의가 시간이 겹치는지
export function conflicts(a, b) {
  if (a.day !== b.day) return false;
  return a.periods.some((p) => b.periods.includes(p));
}

// ── 이수요건(택1) 그룹핑 ──
// 학교 원본 엑셀의 셀 배경색으로 "이 강의들 중 하나만 들으면 됨"을 표시해둔 걸
// 파싱 단계에서 reqGroup(같은 색+"택1" 표시)으로 뽑아뒀음. 같은 reqGroup이면
// 이름이 달라도(예: 운동과웰니스 ↔ 운동과건강디자인) 사실상 같은 이수단위.
// reqGroup이 없는 강의는 "같은 과목명"으로만 묶어 분반을 하나로 접음.
export function groupKeyOf(c) {
  return c.reqGroup || `name:${c.semester}:${c.grade}${c.group}:${c.name}`;
}

// 강의 배열을 groupKeyOf 기준으로 묶어 "대표 한 줄" 목록으로 변환.
// 검색결과·후보목록에서 분반을 낱개로 노출하지 않고 하나로 접어 보여줄 때 사용.
export function groupCourses(list) {
  const map = new Map();
  for (const c of list) {
    const k = groupKeyOf(c);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(c);
  }
  return [...map.entries()].map(([key, members]) => ({
    key,
    members,
    label: members[0].groupLabel || members[0].name,
    isMulti: members.length > 1,
  }));
}

// ── 강의 추가 시트용: 성격별 분류 + 과목명 기준 묶기 ──
// 사용자 리포트(2026-07-20): 택1 그룹을 한 줄로 접으면 안에 뭐가 있는지 안 보이고("7개중택1만 뜸"),
// 교양이 성격별로 안 나뉘어 찾기 어려움 → 과목명별 낱개 노출(분반만 접기) + 성격 헤더로 해결.
export const COURSE_CATEGORY_ORDER = ["전공", "심화", "교직", "핵심교양", "중점교양", "자율교양", "교양"];
// 단독필수 교양 3종의 공식 성격 (2026 요람: 수업영어실습=핵심 교육영어,
// 한국의역사와문화=중점 역사와사회, 현대수학의기초=중점 수학의세계)
const GY_STANDALONE_CAT = {
  수업영어실습: "핵심교양",
  한국의역사와문화: "중점교양",
  현대수학의기초: "중점교양",
};
export function categoryOf(c) {
  if (c.type !== "교양") return c.type; // 전공/심화/교직
  if (c.groupLabel) return c.groupLabel.split(" · ")[0]; // "핵심교양/중점교양/자율교양"
  return GY_STANDALONE_CAT[c.name] || "교양";
}

// 과목명 기준으로만 묶어 성격별 섹션으로 반환. 택1 요건은 없애는 게 아니라
// 각 과목 줄의 reqLabel(요건 안내 문구)로 계속 보여준다.
// 반환: [{ cat, groups: [{ key, label(=과목명), members(분반들), isMulti, reqLabel }] }]
export function groupCoursesByName(list) {
  const map = new Map();
  for (const c of list) {
    const k = `${categoryOf(c)}|${c.name}`;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(c);
  }
  const byCat = new Map();
  for (const [k, members] of map) {
    const cat = k.split("|")[0];
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push({
      key: k,
      label: members[0].name,
      members,
      isMulti: members.length > 1,
      reqLabel: members[0].groupLabel || null,
    });
  }
  const order = (cat) => {
    const i = COURSE_CATEGORY_ORDER.indexOf(cat);
    return i === -1 ? COURSE_CATEGORY_ORDER.length : i;
  };
  return [...byCat.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]))
    .map(([cat, groups]) => ({ cat, groups }));
}

// 과목명 → 파스텔 색 (이름 해시로 안정적 배정)
const PALETTE = [
  { bg: "#e3eefb", bar: "#4b86c7" },
  { bg: "#e8f5ea", bar: "#57a06f" },
  { bg: "#fbeede", bar: "#d98a3d" },
  { bg: "#f6e6f0", bar: "#c86aa0" },
  { bg: "#fdecec", bar: "#d9636f" },
  { bg: "#eee9f7", bar: "#8a72c4" },
  { bg: "#e3f1f3", bar: "#4aa0a8" },
  { bg: "#fef4da", bar: "#c79a2e" },
];
export function colorFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
