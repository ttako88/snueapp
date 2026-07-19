"use client"; // 시간표 조작을 브라우저에서

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  DAYS,
  DEPARTMENTS,
  PERIOD_TIMES,
  autofillCourses,
  colorFor,
  conflicts,
  courseId,
  ALL_COURSES,
} from "../lib/timetable";

const GRADES = [1, 2, 3, 4];
// 강의 추가 시 과 필터 (전체 + 공통 + 심화과정 13개)
const DEPT_FILTERS = ["전체", "공통", ...DEPARTMENTS.map((d) => d.name)];

/* ---------- 시간 기준 그리드 상수 ---------- */
const toMin = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
// 강의가 차지하는 실제 시각 [시작분, 끝분]
function courseSpanMin(c) {
  const minP = Math.min(...c.periods);
  const maxP = Math.max(...c.periods);
  return [toMin(PERIOD_TIMES[minP - 1].start), toMin(PERIOD_TIMES[maxP - 1].end)];
}
const PXMIN = 0.9; // 1분당 픽셀 (그리드 범위는 실제 수업에 맞춰 자동 계산)

export default function Timetable({ editable = true }) {
  const [setup, setSetup] = useState(null);
  const [courses, setCourses] = useState([]);
  const [axis, setAxis] = useState("period"); // period | time
  const [loaded, setLoaded] = useState(false);

  const [setupOpen, setSetupOpen] = useState(false);
  const [formGrade, setFormGrade] = useState(3);
  const [formDept, setFormDept] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchGrade, setSearchGrade] = useState(1); // 강의 추가: 학년 필터
  const [searchDept, setSearchDept] = useState("전체"); // 강의 추가: 과 필터
  const [detail, setDetail] = useState(null); // 편집 중인 강의
  const [editForm, setEditForm] = useState(null);

  // 불러오기
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem("ttSetup") || "null");
      const c = JSON.parse(localStorage.getItem("ttCourses") || "[]");
      const a = localStorage.getItem("ttAxis");
      if (s) setSetup(s);
      if (Array.isArray(c)) setCourses(c);
      if (a === "period" || a === "time") setAxis(a);
    } catch {}
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (loaded) localStorage.setItem("ttCourses", JSON.stringify(courses));
  }, [courses, loaded]);

  function saveSetup() {
    if (!formDept) return;
    const s = { grade: formGrade, dept: formDept };
    setSetup(s);
    localStorage.setItem("ttSetup", JSON.stringify(s));
    setCourses(autofillCourses(formGrade, formDept));
    setSetupOpen(false);
  }
  function toggleAxis() {
    const next = axis === "period" ? "time" : "period";
    setAxis(next);
    localStorage.setItem("ttAxis", next);
  }
  function addCourse(c) {
    const clash = courses.find((x) => conflicts(x, c));
    if (clash && !confirm(`'${clash.name}'와 시간이 겹쳐요. 그래도 추가할까요?`)) return;
    if (courses.some((x) => courseId(x) === courseId(c))) return;
    setCourses((cs) => [...cs, c]);
    setSearchOpen(false);
    setQuery("");
  }
  function removeCourse(c) {
    setCourses((cs) => cs.filter((x) => courseId(x) !== courseId(c)));
    setDetail(null);
  }
  function openCell(c) {
    setDetail(c);
    setEditForm({ room: c.room || "", professor: c.professor || "", memo: c.memo || "" });
  }
  function saveCell() {
    setCourses((cs) =>
      cs.map((x) =>
        courseId(x) === courseId(detail)
          ? { ...x, room: editForm.room, professor: editForm.professor, memo: editForm.memo }
          : x
      )
    );
    setDetail(null);
  }

  const openSetup = () => {
    setFormGrade(setup?.grade || 3);
    setFormDept(setup?.dept || "");
    setSetupOpen(true);
  };

  function openSearch() {
    setSearchGrade(setup?.grade || 1);
    setSearchDept("전체");
    setQuery("");
    setSearchOpen(true);
  }

  // 학년·과·검색어로 강의 필터 (이미 담은 건 제외)
  const searchResults = useMemo(() => {
    const q = query.trim();
    const have = new Set(courses.map((c) => courseId(c)));
    const seen = new Set();
    return ALL_COURSES.filter((c) => {
      if (c.grade !== searchGrade) return false;
      if (searchDept !== "전체" && c.dept !== searchDept) return false;
      if (q && !c.name.includes(q) && !c.professor.includes(q)) return false;
      const k = courseId(c);
      if (seen.has(k) || have.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [query, searchGrade, searchDept, courses]);

  if (!loaded) return null;

  /* 셋업 전 */
  if (!setup) {
    return editable ? (
      <div className="rounded-2xl border border-dashed border-[#0095da]/30 bg-white p-5 text-center">
        <p className="text-2xl">🗓️</p>
        <p className="mt-1 font-bold text-[#0c4470]">내 시간표 만들기</p>
        <p className="mt-1 text-xs text-[#0c4470]/50">학년·심화과정을 고르면 전공·필수가 자동으로 채워져요.</p>
        <button
          onClick={openSetup}
          className="mt-3 rounded-full bg-[#0095da] px-4 py-2 text-sm font-bold text-white active:opacity-80"
        >
          학년·과 선택하기
        </button>
        {setupOpen && (
          <SetupSheet {...{ formGrade, setFormGrade, formDept, setFormDept, saveSetup }} onClose={() => setSetupOpen(false)} />
        )}
      </div>
    ) : (
      <Link href="/courses" className="block rounded-2xl border border-dashed border-[#0095da]/30 bg-white p-4 text-center">
        <p className="text-sm font-bold text-[#0c4470]">🗓️ 내 시간표 만들기 →</p>
        <p className="mt-1 text-xs text-[#0c4470]/50">강의 탭에서 학년·과를 고르면 자동으로 채워져요</p>
      </Link>
    );
  }

  return (
    <div>
      {/* 상단 바 */}
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-bold text-[#0c4470]">
          내 시간표 <span className="font-medium text-[#0c4470]/50">{setup.grade}학년 · {setup.dept}과</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={toggleAxis} className="rounded-full bg-black/5 px-2.5 py-1 text-[11px] font-bold text-[#0c4470]/60">
            {axis === "period" ? "교시" : "시각"}
          </button>
          {editable && (
            <>
              <button onClick={openSearch} className="rounded-full bg-[#0095da] px-2.5 py-1 text-[11px] font-bold text-white">
                + 강의
              </button>
              <button onClick={openSetup} className="rounded-full bg-black/5 px-2.5 py-1 text-[11px] font-bold text-[#0c4470]/60">
                설정
              </button>
            </>
          )}
        </div>
      </div>

      <TimetableGrid courses={courses} axis={axis} onBlock={openCell} />

      {editable && (
        <p className="mt-1.5 text-center text-[11px] text-[#0c4470]/40">칸을 누르면 강의실·교수·메모를 고칠 수 있어요</p>
      )}

      {/* 셋업 시트 */}
      {setupOpen && (
        <SetupSheet {...{ formGrade, setFormGrade, formDept, setFormDept, saveSetup }} onClose={() => setSetupOpen(false)} />
      )}

      {/* 강의 추가 시트 (학년·과 토글) */}
      {searchOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30" onClick={() => setSearchOpen(false)}>
          <div className="flex max-h-[80%] w-full max-w-[480px] flex-col rounded-t-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-base font-bold text-[#0c4470]">강의 추가</h3>
              <button onClick={() => setSearchOpen(false)} className="text-xl text-[#0c4470]/40">×</button>
            </div>

            {/* 학년 토글 */}
            <div className="mb-2 flex gap-1.5">
              {GRADES.map((g) => (
                <button
                  key={g}
                  onClick={() => setSearchGrade(g)}
                  className={`flex-1 rounded-lg py-1.5 text-xs font-bold ${searchGrade === g ? "bg-[#0095da] text-white" : "bg-[#f2f6fa] text-[#0c4470]/55"}`}
                >
                  {g}학년
                </button>
              ))}
            </div>
            {/* 과 토글 (가로 스크롤) */}
            <div className="-mx-4 mb-2 flex gap-1.5 overflow-x-auto px-4 pb-1">
              {DEPT_FILTERS.map((d) => (
                <button
                  key={d}
                  onClick={() => setSearchDept(d)}
                  className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${searchDept === d ? "bg-[#0c4470] text-white" : "bg-[#f2f6fa] text-[#0c4470]/55"}`}
                >
                  {d === "공통" ? "공통·교양" : d}
                </button>
              ))}
            </div>

            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="과목명 또는 교수명 검색"
              className="mb-3 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
            />
            <div className="flex-1 overflow-y-auto">
              {searchResults.length === 0 && (
                <p className="py-8 text-center text-sm text-[#0c4470]/40">해당하는 강의가 없어요.</p>
              )}
              <ul className="flex flex-col gap-1.5">
                {searchResults.map((c) => (
                  <li key={courseId(c)}>
                    <button onClick={() => addCourse(c)} className="flex w-full items-center gap-2 rounded-xl bg-[#f7fafc] p-2.5 text-left active:bg-[#eaf6fd]">
                      <span className="h-8 w-1 rounded-full" style={{ backgroundColor: colorFor(c.name).bar }} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-[#0c4470]">
                          {c.name}{c.section ? ` (${c.section})` : ""}{" "}
                          <span className="text-[10px] font-bold text-[#0095da]/70">{c.type}</span>
                        </span>
                        <span className="block truncate text-xs text-[#0c4470]/50">{c.day}{c.periods.join("")}교시 · {c.professor} · {c.room}</span>
                      </span>
                      <span className="shrink-0 text-lg font-bold text-[#0095da]">+</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* 칸 편집 시트 */}
      {detail && editForm && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30" onClick={() => setDetail(null)}>
          <div className="w-full max-w-[480px] rounded-t-2xl bg-white p-4 pb-6" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1 flex items-center gap-2">
              <span className="h-5 w-1.5 rounded-full" style={{ backgroundColor: colorFor(detail.name).bar }} />
              <h3 className="text-base font-bold text-[#0c4470]">{detail.name}{detail.section ? ` (${detail.section})` : ""}</h3>
            </div>
            <p className="mb-3 text-xs text-[#0c4470]/50">
              {detail.day}요일 {detail.periods.join(",")}교시 · {detail.type}
              {detail.dept && detail.dept !== "공통" ? ` · ${detail.dept}과` : ""}
            </p>

            <label className="mb-1 block text-xs font-bold text-[#0c4470]/50">강의실</label>
            <input
              value={editForm.room}
              onChange={(e) => setEditForm((f) => ({ ...f, room: e.target.value }))}
              className="mb-3 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
            />
            <label className="mb-1 block text-xs font-bold text-[#0c4470]/50">교수 / 강사</label>
            <input
              value={editForm.professor}
              onChange={(e) => setEditForm((f) => ({ ...f, professor: e.target.value }))}
              className="mb-3 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
            />
            <label className="mb-1 block text-xs font-bold text-[#0c4470]/50">메모</label>
            <textarea
              value={editForm.memo}
              onChange={(e) => setEditForm((f) => ({ ...f, memo: e.target.value }))}
              rows={2}
              placeholder="예: 준비물, 과제, 강의실 변경 안내 등"
              className="mb-4 w-full resize-none rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40 placeholder:text-[#0c4470]/30"
            />

            <div className="flex gap-2">
              <button onClick={() => removeCourse(detail)} className="rounded-xl bg-[#fdecec] px-4 py-3 text-sm font-bold text-[#d05b6a] active:opacity-80">빼기</button>
              <button onClick={saveCell} className="flex-1 rounded-xl bg-[#0095da] py-3 text-sm font-bold text-white active:opacity-80">저장</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- 시간 기준 그리드 ---------- */
export function TimetableGrid({ courses, axis, onBlock }) {
  const AXIS_W = 26;
  const cols = `${AXIS_W}px repeat(5, 1fr)`;

  // 그리드 세로 범위를 실제 수업에 맞춰 자동 계산 (맨 위부터 시작)
  const spans = courses.filter((c) => c.periods?.length).map(courseSpanMin);
  const minStart = spans.length ? Math.min(...spans.map((s) => s[0])) : 540; // 없으면 09:00
  const maxEnd = spans.length ? Math.max(...spans.map((s) => s[1])) : 1020; // 17:00
  const startHour = Math.floor(minStart / 60);
  const endHour = Math.ceil(maxEnd / 60);
  const top = startHour * 60;
  const bodyH = (endHour * 60 - top) * PXMIN;
  const y = (min) => (min - top) * PXMIN;
  const hours = [];
  for (let h = startHour; h <= endHour; h++) hours.push(h);
  const periodMarks = PERIOD_TIMES.filter((pt) => toMin(pt.start) >= top && toMin(pt.start) < endHour * 60);

  return (
    <div className="overflow-hidden rounded-xl border border-black/5 bg-white">
      {/* 요일 헤더 */}
      <div className="grid text-center text-[11px] font-bold text-[#0c4470]/50" style={{ gridTemplateColumns: cols }}>
        <div className="py-1" />
        {DAYS.map((d) => (
          <div key={d} className="py-1">{d}</div>
        ))}
      </div>
      {/* 본체 (실제 시각으로 배치) */}
      <div className="relative" style={{ height: bodyH }}>
        {/* 정시 가로선 */}
        {hours.map((H) => (
          <div key={H} className="absolute left-0 right-0 border-t border-black/5" style={{ top: y(H * 60) }} />
        ))}
        <div className="absolute inset-0 grid" style={{ gridTemplateColumns: cols }}>
          {/* 축: 시각(정시) 또는 교시(교시 시작 위치) */}
          <div className="relative">
            {axis === "time"
              ? hours
                  .filter((H) => H < endHour)
                  .map((H) => (
                    <span key={H} className="absolute right-1 text-[9px] text-[#0c4470]/40" style={{ top: y(H * 60) + 2 }}>{H}</span>
                  ))
              : periodMarks.map((pt) => (
                  <span key={pt.p} className="absolute right-1 text-[9px] font-bold text-[#0c4470]/40" style={{ top: y(toMin(pt.start)) + 2 }}>{pt.p}</span>
                ))}
          </div>
          {/* 요일 칸 */}
          {DAYS.map((d) => (
            <div key={d} className="relative border-l border-black/5">
              {courses
                .filter((c) => c.day === d && c.periods?.length)
                .map((c) => {
                  const [s, e] = courseSpanMin(c);
                  const col = colorFor(c.name);
                  return (
                    <button
                      key={courseId(c)}
                      onClick={onBlock ? () => onBlock(c) : undefined}
                      className="absolute flex flex-col overflow-hidden rounded-md p-1 text-left leading-tight"
                      style={{
                        top: y(s) + 1,
                        height: (e - s) * PXMIN - 2,
                        left: 2,
                        right: 2,
                        backgroundColor: col.bg,
                        borderLeft: `3px solid ${col.bar}`,
                      }}
                    >
                      <span className="block truncate text-[10px] font-bold text-[#0c4470]">{c.name}</span>
                      <span className="block truncate text-[9px] text-[#0c4470]/55">{c.room}</span>
                      {c.memo && <span className="block truncate text-[9px] text-[#0c4470]/45">📝 {c.memo}</span>}
                    </button>
                  );
                })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- 셋업 시트 ---------- */
function SetupSheet({ formGrade, setFormGrade, formDept, setFormDept, saveSetup, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30" onClick={onClose}>
      <div className="w-full max-w-[480px] rounded-t-2xl bg-white p-4 pb-6 text-left" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-bold text-[#0c4470]">학년 · 심화과정</h3>
          <button onClick={onClose} className="text-xl text-[#0c4470]/40">×</button>
        </div>

        <p className="mb-1.5 text-xs font-bold text-[#0c4470]/50">학년</p>
        <div className="mb-3 flex gap-2">
          {GRADES.map((g) => (
            <button
              key={g}
              onClick={() => setFormGrade(g)}
              className={`flex-1 rounded-xl py-2 text-sm font-bold ${formGrade === g ? "bg-[#0095da] text-white" : "bg-[#f2f6fa] text-[#0c4470]/60"}`}
            >
              {g}학년
            </button>
          ))}
        </div>

        <p className="mb-1.5 text-xs font-bold text-[#0c4470]/50">심화과정</p>
        <div className="mb-4 grid grid-cols-3 gap-2">
          {DEPARTMENTS.map((d) => (
            <button
              key={d.name}
              onClick={() => setFormDept(d.name)}
              className={`rounded-xl py-2 text-sm font-bold ${formDept === d.name ? "bg-[#0095da] text-white" : "bg-[#f2f6fa] text-[#0c4470]/60"}`}
            >
              {d.name}
            </button>
          ))}
        </div>

        <button
          onClick={saveSetup}
          disabled={!formDept}
          className="w-full rounded-xl bg-[#0095da] py-3 text-sm font-bold text-white active:opacity-80 disabled:opacity-40"
        >
          전공 자동으로 채우기
        </button>
        <p className="mt-2 text-center text-[11px] text-[#0c4470]/40">다시 선택하면 전공·필수가 새로 채워져요 (추가한 교양은 리셋)</p>
      </div>
    </div>
  );
}
