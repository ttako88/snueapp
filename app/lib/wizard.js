// 시간표 마법사 엔진 (순수 함수 — 데이터/화면 의존 없음, 테스트 가능)
//
// 입력:
//   base       : 고정 과목 배열 (내 시간표의 전공/심화/교직) — 항상 포함
//   required   : 필수 과목 배열 (재이수/놓친 과목) — 항상 포함
//   candidates : 후보 과목 배열 (교양 등). 같은 reqGroup(학교 원본의 "택1" 이수요건,
//                예: 운동과웰니스↔운동과건강디자인처럼 이름이 달라도 하나임)이거나
//                reqGroup이 없으면 같은 name = 같은 과목의 여러 분반, 모두 택1로 묶임.
//                각 후보에 priority(1=최우선) 부여 가능
//   maxCredits : 희망 수강학점 상한 (예: 20, 21, 23)
//   freeDays   : 공강 원하는 요일 배열 (예: ["금"])
//   avoidEarly : true면 1·2교시 회피
//   maxResults : 결과 조합 최대 개수
//
// 출력: { infeasible, results:[{courses, addedCredits, totalCredits, score}], baseWarnings, candidateGroups }
//   - courses = 그 조합에서 고른 후보 분반들 (base+required는 화면에서 합쳐 표시)

const slotsOf = (c) => c.periods.map((p) => `${c.day}${p}`);
const creditOf = (c) => c.periods.length; // 1교시 = 1학점
const courseKey = (c) => `${c.name}|${c.section || ""}|${c.day}${c.periods.join("")}`;
// 이수요건 그룹 키: reqGroup(색상 기반 택1 표시)이 있으면 그걸로, 없으면 과목명으로
const groupKeyOf = (c) => c.reqGroup || c.name;

export function generateTimetables({
  base = [],
  required = [],
  candidates = [],
  maxCredits = 23,
  freeDays = [],
  avoidEarly = false,
  maxResults = 24,
}) {
  const freeSet = new Set(freeDays);
  const fixedCourses = [...base, ...required];

  // 1) 고정+필수 점유 슬롯 + 자체 충돌 검사
  const occupied0 = new Set();
  for (const c of fixedCourses) {
    for (const s of slotsOf(c)) {
      if (occupied0.has(s)) {
        return {
          infeasible: `고정/필수 과목의 시간이 서로 겹쳐요 (${c.name})`,
          results: [],
          baseWarnings: [],
          candidateGroups: 0,
        };
      }
      occupied0.add(s);
    }
  }
  const fixedCredits = fixedCourses.reduce((n, c) => n + creditOf(c), 0);

  // 고정/필수가 조건을 어기면 참고 경고 (막지는 않음)
  const baseWarnings = [];
  const fixedDays = new Set(fixedCourses.map((c) => c.day));
  for (const d of freeDays) if (fixedDays.has(d)) baseWarnings.push(`고정/필수에 ${d}요일 수업이 있어 완전한 공강은 어려워요`);
  if (avoidEarly && fixedCourses.some((c) => c.periods.some((p) => p <= 2)))
    baseWarnings.push("고정/필수에 1·2교시 수업이 있어요");
  if (fixedCredits > maxCredits) baseWarnings.push(`고정/필수만 ${fixedCredits}학점이라 상한(${maxCredits})을 이미 넘어요`);

  // 2) 후보 분반 필터 (조건 위반·고정충돌·학점초과 제거) → 이수요건별 그룹(택1)
  const groups = new Map();
  for (const c of candidates) {
    if (freeSet.has(c.day)) continue;
    if (avoidEarly && c.periods.some((p) => p <= 2)) continue;
    if (slotsOf(c).some((s) => occupied0.has(s))) continue;
    if (fixedCredits + creditOf(c) > maxCredits) continue;
    const key = groupKeyOf(c);
    if (!groups.has(key)) groups.set(key, { key, label: c.groupLabel || c.name, priority: c.priority ?? 999, sections: [] });
    groups.get(key).sections.push(c);
  }
  const groupList = [...groups.values()].sort((a, b) => a.priority - b.priority);
  const N = groupList.length;
  const groupIndex = new Map(groupList.map((g, i) => [g.key, i]));

  // 3) 백트래킹으로 조합 생성 (각 과목: 건너뛰기 또는 한 분반 선택)
  const combos = [];
  let guard = 0;
  function bt(i, picked, occupied, credits) {
    if (guard > 200000) return; // 폭주 방지
    guard++;
    if (i === N) {
      combos.push({ courses: [...picked], addedCredits: credits });
      return;
    }
    bt(i + 1, picked, occupied, credits); // 이 과목 건너뛰기
    for (const sec of groupList[i].sections) {
      if (slotsOf(sec).some((s) => occupied.has(s))) continue;
      const c = creditOf(sec);
      if (fixedCredits + credits + c > maxCredits) continue;
      const nextOcc = new Set(occupied);
      for (const s of slotsOf(sec)) nextOcc.add(s);
      picked.push(sec);
      bt(i + 1, picked, nextOcc, credits + c);
      picked.pop();
    }
  }
  bt(0, [], occupied0, 0);

  // 4) maximal(더 못 넣는 조합)만 + 중복 제거 + 점수
  function isMaximal(combo) {
    const occ = new Set(occupied0);
    for (const c of combo.courses) for (const s of slotsOf(c)) occ.add(s);
    const usedKeys = new Set(combo.courses.map(groupKeyOf));
    for (const g of groupList) {
      if (usedKeys.has(g.key)) continue;
      for (const sec of g.sections) {
        if (slotsOf(sec).some((s) => occ.has(s))) continue;
        if (fixedCredits + combo.addedCredits + creditOf(sec) > maxCredits) continue;
        return false; // 더 넣을 수 있음
      }
    }
    return true;
  }

  const seen = new Set();
  const maximal = [];
  for (const combo of combos) {
    if (!isMaximal(combo)) continue;
    const key = combo.courses.map(courseKey).sort().join("||");
    if (seen.has(key)) continue;
    seen.add(key);
    let score = 0;
    for (const c of combo.courses) score += N - groupIndex.get(groupKeyOf(c)); // 상위 우선순위일수록 큼
    maximal.push({ ...combo, score, totalCredits: fixedCredits + combo.addedCredits });
  }
  maximal.sort((a, b) => b.score - a.score || b.totalCredits - a.totalCredits);

  let results = maximal.slice(0, maxResults);
  if (results.length === 0) {
    // 후보가 없거나 하나도 못 넣는 경우 → 고정/필수만
    results = [{ courses: [], addedCredits: 0, score: 0, totalCredits: fixedCredits }];
  }
  return { infeasible: null, results, baseWarnings, candidateGroups: N };
}
