"use client"; // 입력/계산을 브라우저에서 실시간 처리

import Link from "next/link";
import { useEffect, useState } from "react";

// 서울교대 4.5 만점 환산표
const GRADES = {
  "A+": 4.5,
  A0: 4.0,
  "B+": 3.5,
  B0: 3.0,
  "C+": 2.5,
  C0: 2.0,
  "D+": 1.5,
  D0: 1.0,
  F: 0.0,
};
const GRADE_KEYS = Object.keys(GRADES); // 스크롤 선택지 순서

const EMPTY_ROW = () => ({ id: crypto.randomUUID(), name: "", credit: 3, grade: "A+" });

export default function GpaPage() {
  const [rows, setRows] = useState([EMPTY_ROW(), EMPTY_ROW(), EMPTY_ROW()]);
  const [loaded, setLoaded] = useState(false);

  // 저장해둔 입력 불러오기 (처음 한 번)
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("gpaRows") || "null");
      if (Array.isArray(saved) && saved.length > 0) setRows(saved);
    } catch {}
    setLoaded(true);
  }, []);

  // 바뀔 때마다 저장 (첫 로딩 후부터)
  useEffect(() => {
    if (loaded) localStorage.setItem("gpaRows", JSON.stringify(rows));
  }, [rows, loaded]);

  function update(id, field, value) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }
  function addRow() {
    setRows((rs) => [...rs, EMPTY_ROW()]);
  }
  function removeRow(id) {
    setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.id !== id) : rs));
  }
  function reset() {
    setRows([EMPTY_ROW(), EMPTY_ROW(), EMPTY_ROW()]);
  }

  // 평점 계산: Σ(학점×평점) / Σ학점  (모든 과목 = F 포함)
  const totalCredit = rows.reduce((s, r) => s + Number(r.credit || 0), 0);
  const weighted = rows.reduce(
    (s, r) => s + Number(r.credit || 0) * GRADES[r.grade],
    0
  );
  const gpa = totalCredit > 0 ? weighted / totalCredit : 0;

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      {/* 상단: 뒤로 + 제목 */}
      <div className="flex items-center gap-2">
        <Link href="/courses" className="text-[#0c4470]/50">
          ‹ 강의
        </Link>
        <h2 className="text-lg font-bold text-[#0c4470]">학점 계산기</h2>
      </div>

      {/* 결과 요약 */}
      <section className="rounded-2xl bg-[#0095da] p-4 text-white shadow-sm">
        <p className="text-sm font-bold opacity-90">평점 평균 (4.5 만점)</p>
        <p className="mt-1 text-4xl font-extrabold tabular-nums">{gpa.toFixed(2)}</p>
        <p className="mt-1 text-xs opacity-80">
          신청 학점 {totalCredit}학점 · {rows.filter((r) => r.name.trim()).length}과목
        </p>
      </section>

      {/* 강의 목록 */}
      <div className="flex flex-col gap-2">
        {/* 열 제목 */}
        <div className="flex items-center gap-2 px-1 text-[11px] font-bold text-[#0c4470]/40">
          <span className="flex-1">강의명</span>
          <span className="w-14 text-center">학점</span>
          <span className="w-16 text-center">성적</span>
          <span className="w-5" />
        </div>

        {rows.map((r) => (
          <div key={r.id} className="flex items-center gap-2">
            {/* 강의명 */}
            <input
              value={r.name}
              onChange={(e) => update(r.id, "name", e.target.value)}
              placeholder="강의명"
              className="min-w-0 flex-1 rounded-xl bg-white px-3 py-2.5 text-sm text-[#0c4470] shadow-sm outline-none placeholder:text-[#0c4470]/30 focus:ring-2 focus:ring-[#0095da]/40"
            />
            {/* 학점 */}
            <select
              value={r.credit}
              onChange={(e) => update(r.id, "credit", Number(e.target.value))}
              className="w-14 rounded-xl bg-white px-2 py-2.5 text-center text-sm font-medium text-[#0c4470] shadow-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
            >
              {[1, 2, 3, 4, 5, 6].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {/* 성적 (스크롤 선택) */}
            <select
              value={r.grade}
              onChange={(e) => update(r.id, "grade", e.target.value)}
              className={`w-16 rounded-xl px-2 py-2.5 text-center text-sm font-bold shadow-sm outline-none focus:ring-2 focus:ring-[#0095da]/40 ${
                r.grade === "F" ? "bg-[#fbe6e9] text-[#b03c4c]" : "bg-white text-[#0095da]"
              }`}
            >
              {GRADE_KEYS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            {/* 삭제 */}
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

      {/* 추가 / 초기화 */}
      <div className="flex gap-2">
        <button
          onClick={addRow}
          className="flex-1 rounded-xl border border-[#0095da]/30 bg-white py-2.5 text-sm font-bold text-[#0095da] active:bg-[#eaf6fd]"
        >
          + 강의 추가
        </button>
        <button
          onClick={reset}
          className="rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-[#0c4470]/50 shadow-sm active:bg-black/5"
        >
          초기화
        </button>
      </div>

      <p className="text-center text-[11px] text-[#0c4470]/40">
        입력은 이 기기에 자동 저장돼요 · 나중에 '내 시간표'에서 강의명을 자동으로 불러올 수 있게 할게요
      </p>
    </div>
  );
}
