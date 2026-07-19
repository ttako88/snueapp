"use client"; // 단계별 조작을 브라우저에서 처리

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { TimetableGrid } from "../../components/Timetable";
import {
  ALL_COURSES,
  DAYS,
  DEPARTMENTS,
  DEFAULT_SEMESTER,
  colorFor,
  courseId,
  groupCourses,
  loadTimetableSetup,
  loadSemesterCourses,
  collectTakenBefore,
} from "../../lib/timetable";
import { generateTimetables } from "../../lib/wizard";

const GRADES = [1, 2, 3, 4];
const DEPT_FILTERS = ["전체", "공통", ...DEPARTMENTS.map((d) => d.name)];
const STEP_LABELS = ["고정 과목", "필수(재이수)", "후보·우선순위", "조건"];

export default function WizardPage() {
  const router = useRouter();
  const [step, setStep] = useState(1); // 1~4, 5=결과
  const [base, setBase] = useState([]); // 고정(전공·심화·교직), 읽기전용
  const [required, setRequired] = useState([]); // 필수(재이수·놓친 과목)
  const [candidates, setCandidates] = useState([]); // 후보(순서=우선순위)
  const [taken, setTaken] = useState(null); // 이전 학기들 이수 이력 {names, groups}
  const [semester, setSemester] = useState(DEFAULT_SEMESTER);
  const [loaded, setLoaded] = useState(false);

  const [maxCredits, setMaxCredits] = useState(20);
  const [freeDays, setFreeDays] = useState([]);
  const [avoidEarly, setAvoidEarly] = useState(false);

  const [addOpen, setAddOpen] = useState(null); // "required" | "candidate" | null
  const [genResult, setGenResult] = useState(null); // generateTimetables() 결과
  const [resultIdx, setResultIdx] = useState(0);
  const [axis, setAxis] = useState("period");

  // 현재 학기 시간표에서 전공·심화·교직만 '고정'으로 + 이전 학기들의 이수 이력 수집
  useEffect(() => {
    try {
      const setup = loadTimetableSetup();
      const sem = setup?.semester || DEFAULT_SEMESTER;
      setSemester(sem);
      const tt = loadSemesterCourses(sem) || [];
      setBase(tt.filter((c) => c.type === "전공" || c.type === "심화" || c.type === "교직"));
      setTaken(collectTakenBefore(sem)); // 이미 들은 과목·요건은 후보검색에서 자동 제외
    } catch {}
    setLoaded(true);
  }, []);

  // 필수도 그룹(이수요건) 단위로 관리 — 그룹당 결국 1개만 들으므로 학점도 대표 1개로 계산
  const requiredGroups = useMemo(() => groupCourses(required), [required]);
  const fixedCredits = useMemo(
    () =>
      [...base, ...requiredGroups.map((g) => g.members[0])].reduce(
        (n, c) => n + (c.periods?.length || 0),
        0
      ),
    [base, requiredGroups]
  );
  useEffect(() => {
    setMaxCredits((m) => Math.max(m, fixedCredits));
  }, [fixedCredits]);

  const excludeIds = useMemo(
    () => new Set([...base, ...required, ...candidates].map(courseId)),
    [base, required, candidates]
  );

  function removeRequiredGroup(g) {
    const ids = new Set(g.members.map(courseId));
    setRequired((rs) => rs.filter((c) => !ids.has(courseId(c))));
  }
  // 후보는 그룹(이수요건) 단위로 묶여 보이므로, 지울 때도 그룹 전체를 지움
  const candidateGroups = useMemo(() => groupCourses(candidates), [candidates]);
  function removeCandidateGroup(g) {
    const ids = new Set(g.members.map(courseId));
    setCandidates((cs) => cs.filter((c) => !ids.has(courseId(c))));
  }
  function reorderCandidateGroups(from, to) {
    if (to < 0 || to >= candidateGroups.length || from === to) return;
    const next = [...candidateGroups];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setCandidates(next.flatMap((g) => g.members));
  }
  function toggleFreeDay(d) {
    setFreeDays((fs) => (fs.includes(d) ? fs.filter((x) => x !== d) : [...fs, d]));
  }

  function runWizard() {
    const withPriority = candidates.map((c, i) => ({ ...c, priority: i + 1 }));
    const r = generateTimetables({
      base,
      required,
      candidates: withPriority,
      maxCredits,
      freeDays,
      avoidEarly,
      maxResults: 30,
    });
    setGenResult(r);
    setResultIdx(0);
    setStep(5);
  }

  function applyResult() {
    const combo = genResult.results[resultIdx];
    // 필수 그룹에서 고른 과목은 combo.courses에 있고, 단일 필수는 requiredFixed에 있음
    const merged = [...base, ...(genResult.requiredFixed || []), ...combo.courses];
    const seen = new Set();
    const dedup = merged.filter((c) => {
      const k = courseId(c);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    localStorage.setItem("ttCourses", JSON.stringify(dedup));
    alert("내 시간표에 적용했어요!");
    router.push("/courses");
  }

  if (!loaded) return null;

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="flex items-center gap-2">
        <Link href="/courses" className="text-[#0c4470]/50">‹ 강의</Link>
        <h2 className="text-lg font-bold text-[#0c4470]">🧙 시간표 마법사</h2>
      </div>

      {/* 단계 표시 */}
      {step <= 4 && (
        <div className="flex items-center gap-1">
          {STEP_LABELS.map((label, i) => {
            const n = i + 1;
            const active = step === n;
            const done = step > n;
            return (
              <div key={label} className="flex flex-1 items-center gap-1">
                <div
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                    active ? "bg-[#0095da] text-white" : done ? "bg-[#0095da]/20 text-[#0095da]" : "bg-black/5 text-[#0c4470]/30"
                  }`}
                >
                  {n}
                </div>
                {i < STEP_LABELS.length - 1 && <div className={`h-0.5 flex-1 ${done ? "bg-[#0095da]/30" : "bg-black/5"}`} />}
              </div>
            );
          })}
        </div>
      )}

      {/* ===== STEP 1: 고정 과목 ===== */}
      {step === 1 && (
        <section>
          <h3 className="mb-1 text-sm font-bold text-[#0c4470]">현재 내 시간표의 전공·심화·교직</h3>
          <p className="mb-3 text-xs text-[#0c4470]/50">이 과목들은 그대로 고정돼요. 바꾸려면 강의 탭에서 먼저 수정해 주세요.</p>
          {base.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[#0095da]/30 bg-white p-5 text-center">
              <p className="text-sm text-[#0c4470]/50">
                아직 고정 과목이 없어요. 강의 탭에서 학년·과를 먼저 설정해도 되고,
                <br />
                지금처럼 빈 채로 필수·후보만으로 진행해도 괜찮아요.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {base.map((c) => (
                <CourseRow key={courseId(c)} c={c} />
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-[#0c4470]/40">고정 학점 {fixedCredits}학점</p>
        </section>
      )}

      {/* ===== STEP 2: 필수(재이수) ===== */}
      {step === 2 && (
        <section>
          <h3 className="mb-1 text-sm font-bold text-[#0c4470]">필수로 넣을 과목</h3>
          <p className="mb-3 text-xs text-[#0c4470]/50">
            재이수하거나 이전에 놓친 과목을 골라주세요. 조합마다 무조건 포함돼요.
            분반·대체과목이 여러 개면 통째로 담기고, 마법사가 시간 맞는 하나를 골라요.
          </p>
          <button
            onClick={() => setAddOpen("required")}
            className="mb-3 w-full rounded-xl border border-[#0095da]/30 bg-white py-2.5 text-sm font-bold text-[#0095da] active:bg-[#eaf6fd]"
          >
            + 필수 과목 검색
          </button>
          {requiredGroups.length === 0 ? (
            <p className="py-6 text-center text-sm text-[#0c4470]/40">재이수·놓친 과목이 없으면 그냥 다음으로 넘어가도 돼요.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {requiredGroups.map((g) => {
                const c0 = g.members[0];
                const col = colorFor(c0.name);
                return (
                  <li key={g.key} className="flex items-center gap-2 rounded-xl bg-white p-2.5 shadow-sm">
                    <span className="h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: col.bar }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-[#0c4470]">
                        {g.label} <span className="text-[10px] font-bold text-[#0095da]/70">{c0.type}</span>
                      </span>
                      <span className="block truncate text-xs text-[#0c4470]/50">
                        {g.isMulti
                          ? `${g.members.length}개 중 시간 맞는 1개 자동 선택`
                          : `${c0.day}${c0.periods.join("")}교시 · ${c0.professor}`}
                      </span>
                    </span>
                    <button
                      onClick={() => removeRequiredGroup(g)}
                      className="px-1 text-lg text-[#0c4470]/30 active:text-[#d05b6a]"
                      aria-label="삭제"
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {/* ===== STEP 3: 후보 + 우선순위 ===== */}
      {step === 3 && (
        <section>
          <h3 className="mb-1 text-sm font-bold text-[#0c4470]">듣고 싶은 후보 (우선순위 순)</h3>
          <p className="mb-3 text-xs text-[#0c4470]/50">
            위에 있을수록 우선 고려돼요. ⠿ 손잡이를 눌러 드래그하면 순서를 바꿀 수 있어요.
            같은 이수요건(예: 운동과웰니스↔운동과건강디자인)이나 같은 과목명은 자동으로 택1 처리돼요.
          </p>
          <button
            onClick={() => setAddOpen("candidate")}
            className="mb-3 w-full rounded-xl border border-[#0095da]/30 bg-white py-2.5 text-sm font-bold text-[#0095da] active:bg-[#eaf6fd]"
          >
            + 후보 과목 검색
          </button>
          {candidateGroups.length === 0 ? (
            <p className="py-6 text-center text-sm text-[#0c4470]/40">후보를 담아주세요. (교양 등)</p>
          ) : (
            <DragList groups={candidateGroups} onReorder={reorderCandidateGroups} onRemove={removeCandidateGroup} />
          )}
        </section>
      )}

      {/* ===== STEP 4: 조건 ===== */}
      {step === 4 && (
        <section className="flex flex-col gap-4">
          <div>
            <h3 className="mb-1 text-sm font-bold text-[#0c4470]">희망 수강학점 상한</h3>
            <p className="mb-2 text-xs text-[#0c4470]/50">고정+필수 {fixedCredits}학점 포함, 이 학점 이하로만 조합해요.</p>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={fixedCredits}
                max={24}
                value={maxCredits}
                onChange={(e) => setMaxCredits(Number(e.target.value))}
                className="flex-1 accent-[#0095da]"
              />
              <span className="w-16 shrink-0 rounded-lg bg-[#eaf6fd] py-1 text-center text-sm font-bold text-[#0095da]">
                {maxCredits}학점
              </span>
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-bold text-[#0c4470]">공강 원하는 요일</h3>
            <div className="flex gap-2">
              {DAYS.map((d) => (
                <button
                  key={d}
                  onClick={() => toggleFreeDay(d)}
                  className={`flex-1 rounded-xl py-2 text-sm font-bold ${freeDays.includes(d) ? "bg-[#0095da] text-white" : "bg-[#f2f6fa] text-[#0c4470]/55"}`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm font-medium text-[#0c4470]">
            <input
              type="checkbox"
              checked={avoidEarly}
              onChange={(e) => setAvoidEarly(e.target.checked)}
              className="h-4 w-4 accent-[#0095da]"
            />
            1·2교시 피하기
          </label>
        </section>
      )}

      {/* ===== STEP 5: 결과 ===== */}
      {step === 5 && genResult && <ResultsView {...{ genResult, resultIdx, setResultIdx, base, required, axis, setAxis, applyResult, setStep }} />}

      {/* 하단 이동 버튼 */}
      {step <= 4 && (
        <div className="mt-2 flex gap-2">
          {step > 1 && (
            <button
              onClick={() => setStep((s) => s - 1)}
              className="rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-[#0c4470]/60 shadow-sm active:bg-black/5"
            >
              이전
            </button>
          )}
          {step < 4 ? (
            <button
              onClick={() => setStep((s) => s + 1)}
              className="flex-1 rounded-xl bg-[#0095da] py-2.5 text-sm font-bold text-white active:opacity-80"
            >
              다음
            </button>
          ) : (
            <button
              onClick={runWizard}
              className="flex-1 rounded-xl bg-[#0095da] py-2.5 text-sm font-bold text-white active:opacity-80"
            >
              🧙 조합 만들기
            </button>
          )}
        </div>
      )}

      {/* 검색 시트 */}
      {addOpen && (
        <AddSheet
          mode={addOpen}
          excludeIds={excludeIds}
          taken={taken}
          semester={semester}
          onAdd={(courses) => {
            if (addOpen === "required") setRequired((rs) => [...rs, ...courses]);
            else setCandidates((cs) => [...cs, ...courses]);
          }}
          onClose={() => setAddOpen(null)}
        />
      )}
    </div>
  );
}

/* ---------- 과목 한 줄 (고정·필수 목록용) ---------- */
function CourseRow({ c, onRemove }) {
  const col = colorFor(c.name);
  return (
    <li className="flex items-center gap-2 rounded-xl bg-white p-2.5 shadow-sm">
      <span className="h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: col.bar }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-[#0c4470]">
          {c.name}{c.section ? ` (${c.section})` : ""} <span className="text-[10px] font-bold text-[#0095da]/70">{c.type}</span>
        </span>
        <span className="block truncate text-xs text-[#0c4470]/50">{c.day}{c.periods.join("")}교시 · {c.professor}</span>
      </span>
      {onRemove && (
        <button onClick={onRemove} className="px-1 text-lg text-[#0c4470]/30 active:text-[#d05b6a]" aria-label="삭제">×</button>
      )}
    </li>
  );
}

/* ---------- 후보 목록: 드래그로 우선순위 재정렬 ---------- */
// 같은 이수요건(그룹)은 한 줄로 묶여 표시·이동됨. 손잡이(⠿)를 눌러 위아래로
// 끌면 임계값(행 높이의 절반)을 넘을 때마다 이웃과 순서를 바꿈 — 절대좌표
// 계산 없이도 자연스러운 드래그 재정렬을 구현.
function DragList({ groups, onReorder, onRemove }) {
  const [dragIdx, setDragIdx] = useState(null);
  const [offsetY, setOffsetY] = useState(0);
  const startY = useRef(0);
  const ROW_H = 60;

  function down(i, e) {
    setDragIdx(i);
    startY.current = e.clientY;
    setOffsetY(0);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function move(e) {
    if (dragIdx === null) return;
    const delta = e.clientY - startY.current;
    setOffsetY(delta);
    if (delta > ROW_H / 2 && dragIdx < groups.length - 1) {
      onReorder(dragIdx, dragIdx + 1);
      setDragIdx(dragIdx + 1);
      startY.current = e.clientY;
      setOffsetY(0);
    } else if (delta < -ROW_H / 2 && dragIdx > 0) {
      onReorder(dragIdx, dragIdx - 1);
      setDragIdx(dragIdx - 1);
      startY.current = e.clientY;
      setOffsetY(0);
    }
  }
  function up() {
    setDragIdx(null);
    setOffsetY(0);
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {groups.map((g, i) => {
        const c0 = g.members[0];
        const col = colorFor(c0.name);
        const dragging = dragIdx === i;
        return (
          <li
            key={g.key}
            className="flex items-center gap-2 rounded-xl bg-white p-2.5 shadow-sm"
            style={{
              transform: dragging ? `translateY(${offsetY}px) scale(1.02)` : undefined,
              boxShadow: dragging ? "0 4px 14px rgba(0,0,0,.15)" : undefined,
              position: "relative",
              zIndex: dragging ? 10 : 1,
              transition: dragging ? "none" : "transform .15s",
            }}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#eaf6fd] text-[10px] font-bold text-[#0095da]">
              {i + 1}
            </span>
            <span className="h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: col.bar }} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-[#0c4470]">{g.label}</span>
              <span className="block truncate text-xs text-[#0c4470]/50">
                {g.isMulti ? `${g.members.length}개 중 자동 선택` : `${c0.day}${c0.periods.join("")}교시 · ${c0.professor}`}
              </span>
            </span>
            <button onClick={() => onRemove(g)} className="px-1 text-lg text-[#0c4470]/30 active:text-[#d05b6a]" aria-label="삭제">×</button>
            <button
              onPointerDown={(e) => down(i, e)}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
              className="px-1.5 text-lg text-[#0c4470]/30 active:text-[#0095da]"
              style={{ touchAction: "none", cursor: "grab" }}
              aria-label="드래그해서 순서 변경"
            >
              ⠿
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* ---------- 검색 시트 (필수/후보 공용) ---------- */
// 같은 이수요건(reqGroup)이거나 같은 과목명이면 분반을 낱개로 안 보여주고 한 줄로 묶음.
// 필수·후보 모두 그룹째 담음 — 어느 분반/대체과목을 들을지는 마법사가 조합할 때
// 시간표에 맞춰 고르므로, 여기서 하나를 강제로 고르게 하면 마법사의 의미가 없음.
function AddSheet({ mode, excludeIds, taken, semester, onAdd, onClose }) {
  const [grade, setGrade] = useState(1);
  const [dept, setDept] = useState("전체");
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim();
    const seen = new Set();
    const flat = ALL_COURSES.filter((c) => {
      if (c.semester !== semester) return false;
      if (c.grade !== grade) return false;
      if (dept !== "전체" && c.dept !== dept) return false;
      if (q && !c.name.includes(q) && !c.professor.includes(q)) return false;
      // 후보 검색에선 이전 학기에 이미 들은 과목(또는 같은 택1 요건을 채운 과목)을 숨김.
      // 필수(재이수) 검색은 "들었던 걸 다시 듣는" 용도라 숨기지 않음.
      if (mode === "candidate" && taken) {
        if (taken.names.has(c.name)) return false;
        if (c.reqGroup && taken.groups.has(c.reqGroup)) return false;
      }
      const k = courseId(c);
      if (excludeIds.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return groupCourses(flat);
  }, [grade, dept, query, excludeIds, semester, mode, taken]);

  function tapGroup(g) {
    onAdd(g.members.length === 1 ? [g.members[0]] : g.members); // 그룹째 — 분반 선택은 마법사 몫
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30" onClick={onClose}>
      <div className="flex max-h-[80%] w-full max-w-[480px] flex-col rounded-t-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex shrink-0 items-center justify-between">
          <h3 className="text-base font-bold text-[#0c4470]">{mode === "required" ? "필수 과목 검색" : "후보 과목 검색"}</h3>
          <button onClick={onClose} className="text-xl text-[#0c4470]/40">×</button>
        </div>

        {/* 학년·과 필터: shrink-0으로 목록이 길어도 눌려 찌그러지지 않게 */}
        <div className="mb-2 flex shrink-0 gap-1.5">
          {GRADES.map((g) => (
            <button
              key={g}
              onClick={() => setGrade(g)}
              className={`flex-1 rounded-lg py-1.5 text-xs font-bold ${grade === g ? "bg-[#0095da] text-white" : "bg-[#f2f6fa] text-[#0c4470]/55"}`}
            >
              {g}학년
            </button>
          ))}
        </div>
        <div className="-mx-4 mb-2 flex shrink-0 gap-1.5 overflow-x-auto px-4 pb-1">
          {DEPT_FILTERS.map((d) => (
            <button
              key={d}
              onClick={() => setDept(d)}
              className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${dept === d ? "bg-[#0c4470] text-white" : "bg-[#f2f6fa] text-[#0c4470]/55"}`}
            >
              {d === "공통" ? "공통·교양" : d}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="과목명 또는 교수명 검색"
          className="mb-3 w-full shrink-0 rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
        />
        <div className="flex-1 overflow-y-auto">
          {groups.length === 0 && <p className="py-8 text-center text-sm text-[#0c4470]/40">해당하는 강의가 없어요.</p>}
          <ul className="flex flex-col gap-1.5">
            {groups.map((g) => {
              const c0 = g.members[0];
              return (
                <li key={g.key}>
                  <button
                    onClick={() => tapGroup(g)}
                    className="flex w-full items-center gap-2 rounded-xl bg-[#f7fafc] p-2.5 text-left active:bg-[#eaf6fd]"
                  >
                    <span className="h-8 w-1 rounded-full" style={{ backgroundColor: colorFor(c0.name).bar }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-[#0c4470]">
                        {g.label} <span className="text-[10px] font-bold text-[#0095da]/70">{c0.type}</span>
                      </span>
                      <span className="block truncate text-xs text-[#0c4470]/50">
                        {g.isMulti
                          ? `${g.members.length}개 중 택1 · ${c0.day}${c0.periods.join("")}교시 등`
                          : `${c0.day}${c0.periods.join("")}교시 · ${c0.professor} · ${c0.room}`}
                      </span>
                    </span>
                    <span className="shrink-0 text-lg font-bold text-[#0095da]">+</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

    </div>
  );
}

/* ---------- 결과 넘겨보기 ---------- */
function ResultsView({ genResult, resultIdx, setResultIdx, base, required, axis, setAxis, applyResult, setStep }) {
  if (genResult.infeasible) {
    return (
      <section className="rounded-2xl bg-[#fdecec] p-4 text-center">
        <p className="text-sm font-bold text-[#d05b6a]">조합을 만들 수 없어요</p>
        <p className="mt-1 text-xs text-[#d05b6a]/80">{genResult.infeasible}</p>
        <button onClick={() => setStep(1)} className="mt-3 rounded-full bg-white px-4 py-1.5 text-xs font-bold text-[#d05b6a]">
          처음부터 다시
        </button>
      </section>
    );
  }

  const combo = genResult.results[resultIdx];
  const previewCourses = [...base, ...(genResult.requiredFixed || []), ...combo.courses];
  const hasNoCandidates = genResult.candidateGroups === 0;

  return (
    <section className="flex flex-col gap-3">
      {genResult.baseWarnings.length > 0 && (
        <div className="rounded-xl bg-[#fbf1d3] p-2.5 text-xs text-[#96760f]">
          {genResult.baseWarnings.map((w, i) => (
            <p key={i}>⚠️ {w}</p>
          ))}
        </div>
      )}

      {hasNoCandidates && (
        <p className="text-xs text-[#0c4470]/50">조건에 맞는 후보가 없어서 고정·필수 과목만으로 만들었어요.</p>
      )}

      {/* 넘겨보기 컨트롤 */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setResultIdx((i) => Math.max(0, i - 1))}
          disabled={resultIdx === 0}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-lg text-[#0c4470]/60 shadow-sm disabled:opacity-30"
        >
          ‹
        </button>
        <div className="text-center">
          <p className="text-sm font-bold text-[#0c4470]">
            조합 {resultIdx + 1} / {genResult.results.length}
          </p>
          <p className="text-xs text-[#0c4470]/50">총 {combo.totalCredits}학점</p>
        </div>
        <button
          onClick={() => setResultIdx((i) => Math.min(genResult.results.length - 1, i + 1))}
          disabled={resultIdx === genResult.results.length - 1}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-lg text-[#0c4470]/60 shadow-sm disabled:opacity-30"
        >
          ›
        </button>
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => setAxis((a) => (a === "period" ? "time" : "period"))}
          className="rounded-full bg-black/5 px-2.5 py-1 text-[11px] font-bold text-[#0c4470]/60"
        >
          {axis === "period" ? "교시" : "시각"}
        </button>
      </div>

      <TimetableGrid courses={previewCourses} axis={axis} />

      {combo.courses.length > 0 && (
        <ul className="flex flex-col gap-1">
          {combo.courses.map((c) => (
            <li key={courseId(c)} className="flex items-center gap-2 text-xs text-[#0c4470]/70">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: colorFor(c.name).bar }} />
              {c.name}{c.section ? `(${c.section})` : ""} · {c.day}{c.periods.join("")}교시
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => setStep(4)}
          className="rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-[#0c4470]/60 shadow-sm active:bg-black/5"
        >
          조건 다시
        </button>
        <button
          onClick={applyResult}
          className="flex-1 rounded-xl bg-[#0095da] py-2.5 text-sm font-bold text-white active:opacity-80"
        >
          이 조합으로 적용하기
        </button>
      </div>
    </section>
  );
}
