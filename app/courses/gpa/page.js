"use client"; // 입력·계산을 브라우저에서 실시간 처리

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { loadAllSemesterCourses, loadTimetableSetup } from "../../lib/timetable";
import { requiredAverage, maxReachableGpa, MAX_GPA } from "../../lib/gpaTarget";

/* ---------- 상수 ---------- */
const SEMESTERS = [];
for (let g = 1; g <= 4; g++) for (let s = 1; s <= 2; s++) SEMESTERS.push({ key: `${g}-${s}`, label: `${g}학년 ${s}학기` });

// 서울교대 4.5 만점 환산 (P·NP는 평점 제외)
const GRADE_POINTS = { "A+": 4.5, A0: 4.0, "B+": 3.5, B0: 3.0, "C+": 2.5, C0: 2.0, "D+": 1.5, D0: 1.0, F: 0.0 };
const GRADE_OPTIONS = ["A+", "A0", "B+", "B0", "C+", "C0", "D+", "D0", "F", "P", "NP"];
const GRAD_CREDIT = 140; // 졸업 기준 학점

const emptyRow = () => ({ id: crypto.randomUUID(), name: "", credit: 0, grade: "A+", major: false });

// 한 학기(또는 여러 학기) rows 배열의 평점/전공평점/취득학점 계산
function calc(rows) {
  let gc = 0, w = 0, mgc = 0, mw = 0, earned = 0;
  for (const r of rows) {
    const cr = Number(r.credit) || 0;
    if (cr <= 0) continue;
    if (r.grade !== "F" && r.grade !== "NP") earned += cr; // P·통과학점 취득
    if (r.grade in GRADE_POINTS) {
      gc += cr;
      w += cr * GRADE_POINTS[r.grade];
      if (r.major) {
        mgc += cr;
        mw += cr * GRADE_POINTS[r.grade];
      }
    }
  }
  // gradedCredits(gc)·points(w)도 함께 돌려준다 — 목표 평점 역산에 필요
  return { gpa: gc ? w / gc : 0, majorGpa: mgc ? mw / mgc : 0, earned, gradedCredits: gc, points: w };
}

// 성적별 글자색
function gradeColor(g) {
  if (g === "F") return "#d05b6a";
  if (g === "P" || g === "NP") return "#64748b";
  return "#0095da";
}

export default function GpaPage() {
  const [semesters, setSemesters] = useState({});
  const [sel, setSel] = useState("1-1");
  const [loaded, setLoaded] = useState(false);
  // 목표 평점 역산 (design.md §12.2)
  const [targetOpen, setTargetOpen] = useState(false);
  const [targetGpa, setTargetGpa] = useState("4.0");
  const [remainCredits, setRemainCredits] = useState("");

  useEffect(() => {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem("gpaSemesters") || "null");
    } catch {}
    const base = {};
    for (const s of SEMESTERS) {
      base[s.key] = saved?.[s.key]?.length ? saved[s.key] : [emptyRow(), emptyRow(), emptyRow()];
    }
    setSemesters(base);
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (loaded) localStorage.setItem("gpaSemesters", JSON.stringify(semesters));
  }, [semesters, loaded]);

  const rows = semesters[sel] || [];

  function update(id, field, value) {
    setSemesters((prev) => ({
      ...prev,
      [sel]: prev[sel].map((r) => (r.id === id ? { ...r, [field]: value } : r)),
    }));
  }
  function addRow() {
    setSemesters((prev) => ({ ...prev, [sel]: [...prev[sel], emptyRow()] }));
  }
  function removeRow(id) {
    setSemesters((prev) => ({ ...prev, [sel]: prev[sel].filter((r) => r.id !== id) }));
  }
  function resetSem() {
    setSemesters((prev) => ({ ...prev, [sel]: [emptyRow(), emptyRow(), emptyRow()] }));
  }
  function importTimetable() {
    // 선택한 탭(예: 1학년 2학기)에 대응하는 실제 학기를 시간표 설정 기준으로 역산해,
    // 그 학기에 저장해둔 시간표를 우선 불러옴. 없으면 현재 학기 시간표로 폴백.
    let ttSetup = null;
    let store = {};
    try {
      ttSetup = loadTimetableSetup();
      store = loadAllSemesterCourses();
    } catch {}
    let tt = null;
    let src = "";
    if (ttSetup) {
      const [g, s] = sel.split("-").map(Number);
      const year = parseInt(ttSetup.semester, 10) - (ttSetup.grade - g);
      const semKey = `${year}-${s}`;
      if (store[semKey]?.length) {
        tt = store[semKey];
        src = `${year}년 ${s}학기에 저장한 시간표`;
      }
    }
    if (!tt) {
      tt = ttSetup ? store[ttSetup.semester] || [] : [];
      src = "현재 내 시간표";
    }
    if (!tt.length) {
      alert("먼저 강의 탭에서 내 시간표를 만들어 주세요.");
      return;
    }
    const semLabel = SEMESTERS.find((s) => s.key === sel).label;
    if (!confirm(`${src}(${tt.length}과목)를 '${semLabel}'에 불러올까요?`)) return;
    setSemesters((prev) => {
      const cur = prev[sel] || [];
      const nonEmpty = cur.filter((r) => r.name.trim());
      const have = new Set(nonEmpty.map((r) => r.name.trim()));
      const added = [];
      for (const c of tt) {
        if (have.has(c.name)) continue;
        have.add(c.name);
        added.push({
          id: crypto.randomUUID(),
          name: c.name,
          credit: c.periods?.length || 0,
          grade: "A+",
          major: c.type === "전공" || c.type === "심화",
        });
      }
      return { ...prev, [sel]: [...nonEmpty, ...added, emptyRow()] };
    });
  }

  // 학기별·누적 계산
  const semStat = useMemo(() => calc(rows), [rows]);
  const totalStat = useMemo(() => calc(Object.values(semesters).flat()), [semesters]);

  // 남은 학점 기본값: 졸업기준 − 취득학점 (사용자가 직접 고칠 수 있음)
  const remainDefault = Math.max(GRAD_CREDIT - totalStat.earned, 0);
  const remainNum = remainCredits === "" ? remainDefault : Number(remainCredits);
  const targetArgs = {
    currentPoints: totalStat.points,
    gradedCredits: totalStat.gradedCredits,
    targetGpa: Number(targetGpa),
    remainingCredits: remainNum,
  };
  const targetResult = useMemo(
    () => requiredAverage(targetArgs),
    [totalStat.points, totalStat.gradedCredits, targetGpa, remainNum],
  );
  const maxGpa = maxReachableGpa({
    currentPoints: totalStat.points,
    gradedCredits: totalStat.gradedCredits,
    remainingCredits: remainNum,
  });

  if (!loaded) return null;

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      {/* 상단: 뒤로 + 제목 */}
      <div className="flex items-center gap-2">
        <Link href="/courses" className="text-[#0c4470]/50">‹ 강의</Link>
        <h2 className="text-lg font-bold text-[#0c4470]">학점 계산기</h2>
      </div>

      {/* 누적 요약 */}
      <section className="grid grid-cols-3 gap-2 rounded-2xl bg-[#0095da] p-4 text-white shadow-sm">
        <div>
          <p className="text-[11px] font-bold opacity-80">전체 평점</p>
          <p className="text-2xl font-extrabold tabular-nums">{totalStat.gpa.toFixed(2)}</p>
          <p className="text-[10px] opacity-70">/ 4.5</p>
        </div>
        <div>
          <p className="text-[11px] font-bold opacity-80">전공 평점</p>
          <p className="text-2xl font-extrabold tabular-nums">{totalStat.majorGpa.toFixed(2)}</p>
          <p className="text-[10px] opacity-70">/ 4.5</p>
        </div>
        <div>
          <p className="text-[11px] font-bold opacity-80">취득 학점</p>
          <p className="text-2xl font-extrabold tabular-nums">{totalStat.earned}</p>
          <p className="text-[10px] opacity-70">/ {GRAD_CREDIT}</p>
        </div>
      </section>

      {/* 목표 평점 역산 — "남은 학점으로 목표를 맞추려면 평균 몇 점?" */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <button
          onClick={() => setTargetOpen((v) => !v)}
          className="flex w-full items-center justify-between text-left"
        >
          <span className="text-sm font-bold text-[#0c4470]">🎯 목표 평점 계산</span>
          <span className="text-xs text-[#0c4470]/30">{targetOpen ? "▲" : "▼"}</span>
        </button>

        {targetOpen && (
          <div className="mt-3 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-bold text-[#0c4470]/50">목표 평점</span>
                <input
                  type="number" step="0.1" min="0" max={MAX_GPA} inputMode="decimal"
                  value={targetGpa}
                  onChange={(e) => setTargetGpa(e.target.value)}
                  className="rounded-xl border border-black/10 px-3 py-2 text-sm tabular-nums text-[#0c4470] outline-none focus:border-[#0095da]"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-bold text-[#0c4470]/50">남은 학점</span>
                <input
                  type="number" step="1" min="1" inputMode="numeric"
                  value={remainCredits === "" ? remainDefault : remainCredits}
                  onChange={(e) => setRemainCredits(e.target.value)}
                  className="rounded-xl border border-black/10 px-3 py-2 text-sm tabular-nums text-[#0c4470] outline-none focus:border-[#0095da]"
                />
              </label>
            </div>

            {targetResult === null ? (
              <p className="text-xs text-[#0c4470]/45">남은 학점을 1 이상으로 넣어주세요.</p>
            ) : targetResult.status === "already" ? (
              <p className="rounded-xl bg-[#e8f5ea] px-3 py-2.5 text-xs font-bold text-[#3f7a55]">
                이미 목표를 넘었어요. 남은 과목을 모두 F 받아도 {targetGpa} 이상이에요.
              </p>
            ) : targetResult.status === "impossible" ? (
              <p className="rounded-xl bg-[#fdecec] px-3 py-2.5 text-xs font-bold text-[#d05b6a]">
                남은 {remainNum}학점을 모두 A+ 받아도 최대 {maxGpa.toFixed(2)}까지예요.
                목표를 조금 낮추거나 남은 학점을 늘려보세요.
              </p>
            ) : (
              <p className="rounded-xl bg-[#eaf6fd] px-3 py-2.5 text-xs text-[#0c4470]">
                남은 {remainNum}학점에서 평균{" "}
                <b className="text-base text-[#0095da]">{targetResult.required.toFixed(2)}</b>
                {" "}이상 받으면 목표 {targetGpa}에 도달해요.
                <span className="mt-0.5 block text-[11px] text-[#0c4470]/45">
                  (현재 평점 계산에 들어간 학점 {totalStat.gradedCredits}학점 기준 · P·NP 제외)
                </span>
              </p>
            )}
          </div>
        )}
      </section>

      {/* 학기 탭 */}
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {SEMESTERS.map((s) => {
          const active = sel === s.key;
          return (
            <button
              key={s.key}
              onClick={() => setSel(s.key)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold transition ${active ? "bg-[#0095da] text-white" : "bg-white text-[#0c4470]/55 ring-1 ring-black/5"}`}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {/* 선택 학기 헤더 */}
      <div className="flex items-end justify-between">
        <div>
          <h3 className="text-base font-bold text-[#0c4470]">{SEMESTERS.find((s) => s.key === sel).label}</h3>
          <p className="mt-0.5 text-xs text-[#0c4470]/50">
            평점 <b className="text-[#0095da]">{semStat.gpa.toFixed(2)}</b> · 전공{" "}
            <b className="text-[#0095da]">{semStat.majorGpa.toFixed(2)}</b> · 취득{" "}
            <b className="text-[#0095da]">{semStat.earned}</b>
          </p>
        </div>
        <button
          onClick={importTimetable}
          className="rounded-full bg-[#0095da] px-3 py-1.5 text-xs font-bold text-white active:opacity-80"
        >
          시간표 불러오기
        </button>
      </div>

      {/* 표 */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 px-1 text-[11px] font-bold text-[#0c4470]/40">
          <span className="flex-1">과목명</span>
          <span className="w-12 text-center">학점</span>
          <span className="w-16 text-center">성적</span>
          <span className="w-9 text-center">전공</span>
          <span className="w-5" />
        </div>

        {rows.map((r) => (
          <div key={r.id} className="flex items-center gap-2">
            <input
              value={r.name}
              onChange={(e) => update(r.id, "name", e.target.value)}
              placeholder="강의명"
              className="min-w-0 flex-1 rounded-xl bg-white px-3 py-2.5 text-sm text-[#0c4470] shadow-sm outline-none placeholder:text-[#0c4470]/30 focus:ring-2 focus:ring-[#0095da]/40"
            />
            <select
              value={r.credit}
              onChange={(e) => update(r.id, "credit", Number(e.target.value))}
              className="w-12 rounded-xl bg-white px-1 py-2.5 text-center text-sm font-medium text-[#0c4470] shadow-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
            >
              {[0, 1, 2, 3, 4, 5, 6].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <select
              value={r.grade}
              onChange={(e) => update(r.id, "grade", e.target.value)}
              className="w-16 rounded-xl bg-white px-1 py-2.5 text-center text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
              style={{ color: gradeColor(r.grade) }}
            >
              {GRADE_OPTIONS.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
            <span className="flex w-9 justify-center">
              <input
                type="checkbox"
                checked={r.major}
                onChange={(e) => update(r.id, "major", e.target.checked)}
                className="h-4 w-4 accent-[#0095da]"
                aria-label="전공"
              />
            </span>
            <button
              onClick={() => removeRow(r.id)}
              className="w-5 shrink-0 text-lg text-[#0c4470]/30 active:text-[#d05b6a]"
              aria-label="삭제"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {/* 더 입력 / 초기화 */}
      <div className="flex gap-2">
        <button
          onClick={addRow}
          className="flex-1 rounded-xl border border-[#0095da]/30 bg-white py-2.5 text-sm font-bold text-[#0095da] active:bg-[#eaf6fd]"
        >
          + 더 입력하기
        </button>
        <button
          onClick={resetSem}
          className="rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-[#0c4470]/50 shadow-sm active:bg-black/5"
        >
          초기화
        </button>
      </div>

      <p className="text-center text-[11px] text-[#0c4470]/40">
        전공 체크 → 전공 평점 반영 · P·NP는 평점 제외 · 입력은 기기에 자동 저장돼요
      </p>
    </div>
  );
}
