"use client"; // 단계별 조작을 브라우저에서 처리

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { TimetableGrid } from "../../components/Timetable";
import { ALL_COURSES, DAYS, DEPARTMENTS, colorFor, courseId } from "../../lib/timetable";
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
  const [loaded, setLoaded] = useState(false);

  const [maxCredits, setMaxCredits] = useState(20);
  const [freeDays, setFreeDays] = useState([]);
  const [avoidEarly, setAvoidEarly] = useState(false);

  const [addOpen, setAddOpen] = useState(null); // "required" | "candidate" | null
  const [genResult, setGenResult] = useState(null); // generateTimetables() 결과
  const [resultIdx, setResultIdx] = useState(0);
  const [axis, setAxis] = useState("period");

  // 현재 내 시간표에서 전공·심화·교직만 '고정'으로 가져오기
  useEffect(() => {
    try {
      const tt = JSON.parse(localStorage.getItem("ttCourses") || "[]");
      setBase(tt.filter((c) => c.type === "전공" || c.type === "심화" || c.type === "교직"));
    } catch {}
    setLoaded(true);
  }, []);

  const fixedCredits = useMemo(
    () => [...base, ...required].reduce((n, c) => n + (c.periods?.length || 0), 0),
    [base, required]
  );
  useEffect(() => {
    setMaxCredits((m) => Math.max(m, fixedCredits));
  }, [fixedCredits]);

  const excludeIds = useMemo(
    () => new Set([...base, ...required, ...candidates].map(courseId)),
    [base, required, candidates]
  );

  function removeRequired(c) {
    setRequired((rs) => rs.filter((x) => courseId(x) !== courseId(c)));
  }
  function removeCandidate(c) {
    setCandidates((cs) => cs.filter((x) => courseId(x) !== courseId(c)));
  }
  function moveCandidate(i, dir) {
    setCandidates((cs) => {
      const next = [...cs];
      const j = i + dir;
      if (j < 0 || j >= next.length) return cs;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
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
    const merged = [...base, ...required, ...combo.courses];
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
          <p className="mb-3 text-xs text-[#0c4470]/50">재이수하거나 이전에 놓친 과목을 골라주세요. 조합마다 무조건 포함돼요.</p>
          <button
            onClick={() => setAddOpen("required")}
            className="mb-3 w-full rounded-xl border border-[#0095da]/30 bg-white py-2.5 text-sm font-bold text-[#0095da] active:bg-[#eaf6fd]"
          >
            + 필수 과목 검색
          </button>
          {required.length === 0 ? (
            <p className="py-6 text-center text-sm text-[#0c4470]/40">재이수·놓친 과목이 없으면 그냥 다음으로 넘어가도 돼요.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {required.map((c) => (
                <CourseRow key={courseId(c)} c={c} onRemove={() => removeRequired(c)} />
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ===== STEP 3: 후보 + 우선순위 ===== */}
      {step === 3 && (
        <section>
          <h3 className="mb-1 text-sm font-bold text-[#0c4470]">듣고 싶은 후보 (우선순위 순)</h3>
          <p className="mb-3 text-xs text-[#0c4470]/50">
            위에 있을수록 우선 고려돼요. 같은 시간대나 같은 과목명은 자동으로 택1 처리돼요.
          </p>
          <button
            onClick={() => setAddOpen("candidate")}
            className="mb-3 w-full rounded-xl border border-[#0095da]/30 bg-white py-2.5 text-sm font-bold text-[#0095da] active:bg-[#eaf6fd]"
          >
            + 후보 과목 검색
          </button>
          {candidates.length === 0 ? (
            <p className="py-6 text-center text-sm text-[#0c4470]/40">후보를 담아주세요. (교양 등)</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {candidates.map((c, i) => (
                <CourseRow
                  key={courseId(c)}
                  c={c}
                  rank={i + 1}
                  onRemove={() => removeCandidate(c)}
                  onUp={i > 0 ? () => moveCandidate(i, -1) : undefined}
                  onDown={i < candidates.length - 1 ? () => moveCandidate(i, 1) : undefined}
                />
              ))}
            </ul>
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
          onAdd={(c) => {
            if (addOpen === "required") setRequired((rs) => [...rs, c]);
            else setCandidates((cs) => [...cs, c]);
          }}
          onClose={() => setAddOpen(null)}
        />
      )}
    </div>
  );
}

/* ---------- 과목 한 줄 ---------- */
function CourseRow({ c, rank, onRemove, onUp, onDown }) {
  const col = colorFor(c.name);
  return (
    <li className="flex items-center gap-2 rounded-xl bg-white p-2.5 shadow-sm">
      {rank && (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#eaf6fd] text-[10px] font-bold text-[#0095da]">
          {rank}
        </span>
      )}
      <span className="h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: col.bar }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-[#0c4470]">
          {c.name}{c.section ? ` (${c.section})` : ""} <span className="text-[10px] font-bold text-[#0095da]/70">{c.type}</span>
        </span>
        <span className="block truncate text-xs text-[#0c4470]/50">{c.day}{c.periods.join("")}교시 · {c.professor}</span>
      </span>
      {onUp && (
        <button onClick={onUp} className="px-1 text-[#0c4470]/30 active:text-[#0095da]" aria-label="위로">▲</button>
      )}
      {onDown && (
        <button onClick={onDown} className="px-1 text-[#0c4470]/30 active:text-[#0095da]" aria-label="아래로">▼</button>
      )}
      {onRemove && (
        <button onClick={onRemove} className="px-1 text-lg text-[#0c4470]/30 active:text-[#d05b6a]" aria-label="삭제">×</button>
      )}
    </li>
  );
}

/* ---------- 검색 시트 (필수/후보 공용) ---------- */
function AddSheet({ mode, excludeIds, onAdd, onClose }) {
  const [grade, setGrade] = useState(1);
  const [dept, setDept] = useState("전체");
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim();
    const seen = new Set();
    return ALL_COURSES.filter((c) => {
      if (c.grade !== grade) return false;
      if (dept !== "전체" && c.dept !== dept) return false;
      if (q && !c.name.includes(q) && !c.professor.includes(q)) return false;
      const k = courseId(c);
      if (excludeIds.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [grade, dept, query, excludeIds]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30" onClick={onClose}>
      <div className="flex max-h-[80%] w-full max-w-[480px] flex-col rounded-t-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-base font-bold text-[#0c4470]">{mode === "required" ? "필수 과목 검색" : "후보 과목 검색"}</h3>
          <button onClick={onClose} className="text-xl text-[#0c4470]/40">×</button>
        </div>

        <div className="mb-2 flex gap-1.5">
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
        <div className="-mx-4 mb-2 flex gap-1.5 overflow-x-auto px-4 pb-1">
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
          className="mb-3 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
        />
        <div className="flex-1 overflow-y-auto">
          {results.length === 0 && <p className="py-8 text-center text-sm text-[#0c4470]/40">해당하는 강의가 없어요.</p>}
          <ul className="flex flex-col gap-1.5">
            {results.map((c) => (
              <li key={courseId(c)}>
                <button
                  onClick={() => onAdd(c)}
                  className="flex w-full items-center gap-2 rounded-xl bg-[#f7fafc] p-2.5 text-left active:bg-[#eaf6fd]"
                >
                  <span className="h-8 w-1 rounded-full" style={{ backgroundColor: colorFor(c.name).bar }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-[#0c4470]">
                      {c.name}{c.section ? ` (${c.section})` : ""} <span className="text-[10px] font-bold text-[#0095da]/70">{c.type}</span>
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
  const previewCourses = [...base, ...required, ...combo.courses];
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
