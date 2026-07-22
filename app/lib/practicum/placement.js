// 학기별 실습학교 배정 — 학기 계산과 입력 규칙.
//
// 학교 목록·실습 단계는 `./schools` 가 원본이다. 여기서 다시 정의하지 않는다 —
// 처음에 PRACTICUM_TERMS 를 새로 만들었다가 PRACTICUM_STAGES 와 중복이라
// 걷어냈다. 규칙이 두 곳에 있으면 반드시 어긋난다.
//
// 019_practicum_placement.sql 의 CHECK 제약과 **같은 규칙**이어야 한다.
// 화면에서 통과한 값이 서버에서 거부되면 사용자는 이유를 알 수 없다.

import { PRACTICUM_STAGES } from "./schools";

/** DB 의 semester 형식은 '2026-1'. 019 의 CHECK 와 같은 모양. */
export function toSemester(year, term) {
  return `${year}-${term}`;
}

export function parseSemester(s) {
  const m = /^(\d{4})-([12])$/.exec(String(s ?? ""));
  return m ? { year: Number(m[1]), term: Number(m[2]) } : null;
}

/**
 * 입학연도로 다섯 실습 학기의 연도를 구한다.
 *
 * 재수강·휴학은 반영하지 않는다. 여기서 추측하면 틀린 값을 밀어 넣게 되고,
 * 사용자는 자기가 안 고른 값이 저장된 걸 나중에 발견한다. 계산은 **출발점만**
 * 잡아 주고 최종 선택은 사용자가 한다.
 */
export function semestersForEntryYear(entryYear) {
  const y = Number(entryYear);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) return [];
  return PRACTICUM_STAGES.map((st) => {
    const year = y + (st.grade - 1);
    return {
      ...st,
      year,
      semester: toSemester(year, st.term),
      label: `${st.grade}학년 ${st.term}학기 · ${st.name}`,
    };
  });
}

/** 019 의 school_short CHECK 와 같은 규칙. */
export function isValidSchoolShort(v) {
  return /^[가-힣A-Za-z0-9]{2,20}$/.test(String(v ?? ""));
}

/** 019 의 semester CHECK 와 같은 규칙. */
export function isValidSemester(v) {
  return /^[0-9]{4}-[12]$/.test(String(v ?? ""));
}

/**
 * 변경 사유. 019 의 last_change_reason CHECK 와 **같은 값 집합**이어야 한다.
 * 'mistake' 는 잠기기 전 자유 변경에만 쓰이므로 잠긴 뒤 선택지에서는 뺀다
 * (019 가 잠긴 상태에서 'mistake' 를 받지 않는다).
 */
export const CHANGE_REASONS = [
  { key: "mistake", label: "잘못 골랐어요", afterLock: false },
  { key: "reassigned", label: "학교가 바뀌었어요", afterLock: true },
  { key: "leave", label: "휴학·복학했어요", afterLock: true },
  { key: "other", label: "그 밖의 사유", afterLock: true },
];

export const REASONS_AFTER_LOCK = CHANGE_REASONS.filter((c) => c.afterLock);
