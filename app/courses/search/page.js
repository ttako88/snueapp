"use client"; // 입력에 따라 즉시 필터링하므로 브라우저에서 동작

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  ALL_COURSES,
  DAYS,
  DEPARTMENTS,
  SEMESTERS_NEWEST_FIRST,
  SEMESTER_LABELS,
  DEFAULT_SEMESTER,
  colorFor,
  courseId,
  conflicts,
  loadSemesterCourses,
  saveSemesterCourses,
} from "../../lib/timetable";
import {
  searchCourses,
  groupResults,
  periodLabel,
  cleanProfessors,
  COURSE_TYPES,
} from "../../lib/courseSearch";
import { isEnabled } from "../../lib/features";

const GRADES = [1, 2, 3, 4];
const DEPT_OPTIONS = ["공통", ...DEPARTMENTS.map((d) => d.name)];

// 성격 뱃지 색 (교양 3종은 결이 다르니 톤을 나눔)
const CAT_TONE = {
  전공: "bg-[#0095da] text-white",
  심화: "bg-[#0c4470] text-white",
  교직: "bg-[#57a06f] text-white",
  핵심교양: "bg-[#d98a3d] text-white",
  중점교양: "bg-[#8a72c4] text-white",
  자율교양: "bg-[#4aa0a8] text-white",
  교양: "bg-black/10 text-[#0c4470]",
};

export default function CourseSearchPage() {
  const [q, setQ] = useState("");
  const [semester, setSemester] = useState(DEFAULT_SEMESTER);
  const [type, setType] = useState("");
  const [grade, setGrade] = useState("");
  const [dept, setDept] = useState("");
  const [day, setDay] = useState("");
  const [openKey, setOpenKey] = useState(null); // 펼친 과목 카드
  const [notice, setNotice] = useState("");     // 담기 결과 안내

  // 검색 결과에서 바로 시간표에 담는다. 보고 있는 학기에 그대로 들어간다.
  // (검색만 되고 담을 수 없으면 결국 강의 탭으로 다시 가서 또 찾아야 한다)
  function addToTimetable(section) {
    const cur = loadSemesterCourses(semester) || [];
    const id = courseId(section);

    if (cur.some((c) => courseId(c) === id)) {
      setNotice("이미 시간표에 있는 강의예요.");
    } else {
      const clash = cur.find((c) => conflicts(c, section));
      if (clash) {
        // 막지 않고 알린다 — 원본 시간표 자체에 실제 중복이 있는 경우가 있어서
        // (구학번 보강개설 등) 사용자가 판단해야 한다.
        saveSemesterCourses(semester, [...cur, section]);
        setNotice(`담았어요. 다만 '${clash.name}'과 시간이 겹쳐요.`);
      } else {
        saveSemesterCourses(semester, [...cur, section]);
        setNotice(`${section.name} 담았어요 → 강의 탭에서 확인`);
      }
    }
    setTimeout(() => setNotice(""), 2600);
  }

  const groups = useMemo(
    () => groupResults(searchCourses(ALL_COURSES, { q, semester, type, grade, dept, day })),
    [q, semester, type, grade, dept, day],
  );

  const hasFilter = q || type || grade || dept || day;
  const resetAll = () => {
    setQ("");
    setType("");
    setGrade("");
    setDept("");
    setDay("");
  };

  // 스위치가 꺼져 있으면 화면을 열지 않는다 (features.js에서 제어)
  if (!isEnabled("courseSearch")) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm text-[#0c4470]/60">강의 검색은 준비 중이에요.</p>
        <Link href="/courses" className="mt-3 inline-block text-sm text-[#0095da]">
          ← 강의 탭으로
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center gap-2">
        <Link href="/courses" className="text-sm text-[#0c4470]/50">
          ←
        </Link>
        <h2 className="text-lg font-bold text-[#0c4470]">강의 검색</h2>
      </div>

      {/* 검색어 */}
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="과목명 또는 교수명 (예: 국어교육론, 김철수)"
        className="w-full rounded-xl border border-black/10 bg-white px-3.5 py-2.5 text-sm text-[#0c4470] outline-none placeholder:text-[#0c4470]/35 focus:border-[#0095da]"
      />

      {/* 학기 칩 */}
      <div className="flex gap-1.5 overflow-x-auto pb-0.5">
        {SEMESTERS_NEWEST_FIRST.map((s) => (
          <button
            key={s}
            onClick={() => setSemester(s)}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold ${
              semester === s ? "bg-[#0095da] text-white" : "bg-white text-[#0c4470]/60 shadow-sm"
            }`}
          >
            {SEMESTER_LABELS[s]}
          </button>
        ))}
      </div>

      {/* 세부 필터 */}
      <div className="grid grid-cols-2 gap-2">
        <Select value={type} onChange={setType} label="유형 전체" options={COURSE_TYPES} />
        <Select
          value={grade}
          onChange={setGrade}
          label="학년 전체"
          options={GRADES.map((g) => ({ v: String(g), t: `${g}학년` }))}
        />
        <Select value={dept} onChange={setDept} label="학과 전체" options={DEPT_OPTIONS} />
        <Select value={day} onChange={setDay} label="요일 전체" options={DAYS.map((d) => ({ v: d, t: `${d}요일` }))} />
      </div>

      {/* 결과 수 + 초기화 */}
      <div className="flex items-center justify-between px-0.5">
        <p className="text-xs text-[#0c4470]/50">
          <b className="text-[#0095da]">{groups.length}</b>개 과목
        </p>
        {hasFilter && (
          <button onClick={resetAll} className="text-xs text-[#0c4470]/40 underline">
            필터 초기화
          </button>
        )}
      </div>

      {notice && (
        <p className="sticky top-2 z-10 rounded-xl bg-[#0095da] px-3 py-2 text-center text-xs font-bold text-white shadow">
          {notice}
        </p>
      )}

      {/* 결과 목록 */}
      {groups.length === 0 ? (
        <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
          <p className="text-sm text-[#0c4470]/50">조건에 맞는 강의가 없어요.</p>
          <p className="mt-1 text-xs text-[#0c4470]/35">학기나 필터를 바꿔보세요.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {groups.map((g) => {
            const open = openKey === g.key;
            const color = colorFor(g.name);
            return (
              <li key={g.key} className="overflow-hidden rounded-2xl bg-white shadow-sm">
                <button
                  onClick={() => setOpenKey(open ? null : g.key)}
                  className="flex w-full items-center gap-2.5 p-3.5 text-left active:bg-[#eaf6fd]"
                >
                  <span className="h-9 w-1 shrink-0 rounded-full" style={{ backgroundColor: color.bar }} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-bold text-[#0c4470]">{g.name}</span>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          CAT_TONE[g.cat] || CAT_TONE["교양"]
                        }`}
                      >
                        {g.cat}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-[#0c4470]/50">
                      {summarize(g)}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-[#0c4470]/30">{open ? "▲" : "▼"}</span>
                </button>

                {open && (
                  <div className="border-t border-black/5 bg-[#f7fbfe] px-3.5 py-2.5">
                    <ul className="flex flex-col gap-2">
                      {g.sections.map((s, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs">
                          {/* 분반 표기가 없는 강의도 있다 — 그때 "분반"만 남지 않게 */}
                          <span className="mt-0.5 shrink-0 rounded bg-white px-1.5 py-0.5 font-bold text-[#0c4470]/60 shadow-sm">
                            {s.section ? `${s.section}분반` : "단일"}
                          </span>
                          <span className="min-w-0 flex-1 text-[#0c4470]/70">
                            <span className="block">
                              {s.day}요일 {periodLabel(s.periods)}
                            </span>
                            <span className="block text-[#0c4470]/45">
                              {cleanProfessors(s.professor).join(", ") || "교수 미정"} · {s.room} · {s.dept}
                            </span>
                            <button
                              onClick={() => addToTimetable(s)}
                              className="mt-1 rounded-lg bg-[#eaf6fd] px-2 py-1 text-[11px] font-bold text-[#0095da] active:bg-[#d5ecfa]"
                            >
                              + 시간표에 담기
                            </button>
                            {s.groupLabel && (
                              <span className="mt-0.5 block text-[#0095da]">{s.groupLabel}</span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>

                    {/* 강의평가 모듈이 켜지면 여기로 이어진다 (features.js) */}
                    {isEnabled("courseReview") && (
                      <Link
                        href={`/courses/review/${encodeURIComponent(g.name)}`}
                        className="mt-2.5 block rounded-xl bg-[#0095da] py-2 text-center text-xs font-bold text-white"
                      >
                        ⭐ 이 강의 평가 보기
                      </Link>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// 카드 한 줄 요약: "진현정 외 2명 · 3학년 · 6개 학과 · 분반 6개"
// 같은 과목이 여러 학과에 동시 개설되는 경우가 많아(720중 167) 학과를 하나만
// 보여주면 오해를 준다 — 2개까지는 나열, 그 이상은 개수로 접는다.
function summarize(g) {
  const parts = [];

  if (g.professors.length > 3) {
    parts.push(`${g.professors.slice(0, 2).join(", ")} 외 ${g.professors.length - 2}명`);
  } else if (g.professors.length) {
    parts.push(g.professors.join(", "));
  }

  parts.push(`${g.grades.join("·")}학년`);
  parts.push(g.depts.length > 2 ? `${g.depts.length}개 학과` : g.depts.join(", "));
  if (g.sections.length > 1) parts.push(`분반 ${g.sections.length}개`);

  return parts.join(" · ");
}

// 작은 select 부품 — options는 문자열 배열 또는 {v,t} 배열
function Select({ value, onChange, label, options }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-xs outline-none focus:border-[#0095da] ${
        value ? "font-bold text-[#0c4470]" : "text-[#0c4470]/45"
      }`}
    >
      <option value="">{label}</option>
      {options.map((o) => {
        const v = typeof o === "string" ? o : o.v;
        const t = typeof o === "string" ? o : o.t;
        return (
          <option key={v} value={v}>
            {t}
          </option>
        );
      })}
    </select>
  );
}
