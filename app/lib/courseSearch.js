// 강의조회 모듈 — 검색·필터 순수 로직 (화면 없음, 테스트 대상).
// 데이터는 app/data/courses.json (4개 학기 1961강좌). 서버·DB 불필요.
// courseMeta.js에서 가져온다(courses.json 미의존) — 그래야 node --test에서도 불러진다.
// 확장자(.js)는 raw Node ESM에 필요.
import { PERIOD_TIMES, categoryOf } from "./courseMeta.js";

export const COURSE_TYPES = ["전공", "심화", "교직", "교양"];

// 검색어 정규화: 공백 무시 + 소문자. "삶과 철학"으로 "삶과철학의이해"가 잡히게.
function norm(s) {
  return String(s ?? "").toLowerCase().replace(/\s+/g, "");
}

// 한글 초성. 사용자가 "ㄱㅇ" 로 "국어" 를 찾는 것은 한국 앱의 기본 기대다.
const CHO = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ",
             "ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];

/** 문자열을 초성만 뽑은 문자열로. 한글이 아닌 글자는 그대로 둔다. */
function toChoseong(s) {
  let out = "";
  for (const ch of String(s ?? "")) {
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      out += CHO[Math.floor((code - 0xac00) / 588)];
    } else {
      out += ch.toLowerCase();
    }
  }
  return out;
}

/** 검색어가 초성으로만 이뤄졌는가 (ㄱㅇ 처럼). 한 글자라도 완성형이면 아니다. */
function isChoseongQuery(q) {
  return q.length > 0 && [...q].every((ch) => CHO.includes(ch));
}

/** [1,2] → "1~2교시 · 09:00–10:50" / [3] → "3교시 · 11:00–11:50" */
export function periodLabel(periods) {
  if (!periods?.length) return "시간 미정";
  const sorted = [...periods].sort((a, b) => a - b);
  const first = PERIOD_TIMES.find((t) => t.p === sorted[0]);
  const last = PERIOD_TIMES.find((t) => t.p === sorted[sorted.length - 1]);
  const nums = sorted.length > 1 ? `${sorted[0]}~${sorted[sorted.length - 1]}` : `${sorted[0]}`;
  if (!first || !last) return `${nums}교시`;
  return `${nums}교시 · ${first.start}–${last.end}`;
}

/**
 * 강의 검색. 필터는 전부 선택사항이며, 빈 값("" 또는 null)은 "전체"로 본다.
 * @param {Array} rows courses.json 행들
 * @param {{q?:string, semester?:string, type?:string, grade?:number|string, dept?:string, day?:string}} f
 */
export function searchCourses(rows, f = {}) {
  const q = norm(f.q);
  const choseong = isChoseongQuery(q);
  const grade = f.grade === "" || f.grade == null ? null : Number(f.grade);

  return rows.filter((c) => {
    if (f.semester && c.semester !== f.semester) return false;
    if (f.type && c.type !== f.type) return false;
    if (grade != null && c.grade !== grade) return false;
    if (f.dept && c.dept !== f.dept) return false;
    if (f.day && c.day !== f.day) return false;
    if (!q) return true;
    // 검색어가 초성만이면(ㄱㅇ) 과목명 초성으로 맞춘다. 완성형이 섞이면
    // 일반 부분일치로 — "ㄱ어" 같은 어중간한 입력은 초성 검색으로 치지 않는다.
    if (choseong) {
      return toChoseong(c.name).includes(q) || toChoseong(c.professor).includes(q);
    }
    // 과목명 또는 교수명 어느 쪽이든 부분일치
    return norm(c.name).includes(q) || norm(c.professor).includes(q);
  });
}

/**
 * 교수명 정리 — 원본 professor 필드가 지저분해서 표시 전에 정돈이 필요하다.
 * 실제 예: "진현정,남영민 E-407,"  "남영민, 진현정 연강403,"
 * (엑셀 파싱 과정에서 강의실 문자열이 섞여 들어간 것으로 보임)
 *
 * 규칙: 쉼표로 쪼갠 뒤, 각 토큰을 다시 공백으로 쪼개서 **숫자가 든 낱말만** 버린다.
 *       ("권성옥 E-407" 처럼 이름과 강의실이 한 토큰에 붙어 있어도 이름은 살아남는다.
 *        토큰 통째로 버리면 교수명이 사라지는 버그가 실제로 있었음 — 테스트로 고정.)
 *       한국인 이름에는 숫자가 없으므로 "숫자 포함 = 강의실" 휴리스틱이 성립한다.
 * 원본 데이터는 고치지 않는다 — 표시 단계에서만 정리한다.
 */
export function cleanProfessors(raw) {
  return String(raw ?? "")
    .split(",")
    .map((token) =>
      token
        .split(/\s+/)
        .filter((w) => w && !/\d/.test(w))
        .join(" ")
        .replace(/[.,·]+$/, "")
        .trim(),
    )
    .filter(Boolean);
}

/**
 * 검색 결과를 과목명으로 묶어 목록화 (분반은 접어서 안에).
 * 반환: [{ key, name, cat, semester, professors[], depts[], grades[], sections[] }]
 *
 * ⚠️ depts·grades가 배열인 이유: 같은 과목이 여러 심화과정에 동시 개설되는 경우가
 *    실제로 많다(720그룹 중 167그룹). 첫 행의 학과만 보여주면 "이 과목은 윤리과 것"
 *    이라는 잘못된 인상을 준다.
 * 정렬: 과목명 가나다순.
 */
export function groupResults(list) {
  const map = new Map();
  for (const c of list) {
    const key = `${c.semester}|${c.name}`;
    if (!map.has(key)) {
      map.set(key, { key, name: c.name, cat: categoryOf(c), semester: c.semester, sections: [] });
    }
    map.get(key).sections.push(c);
  }
  for (const g of map.values()) {
    g.professors = [...new Set(g.sections.flatMap((s) => cleanProfessors(s.professor)))];
    g.depts = [...new Set(g.sections.map((s) => s.dept))];
    g.grades = [...new Set(g.sections.map((s) => s.grade))].sort((a, b) => a - b);
    g.sections.sort((a, b) => String(a.section).localeCompare(String(b.section)));
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
}
