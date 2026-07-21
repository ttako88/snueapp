"use client";

// 실습모드 — 실습 기간에 필요한 것만 한 화면에.
//
// 실습은 서울교대 학생에게 2학년 1학기부터 5학기 연속으로 있고, 학기마다
// 이름·기간·중점이 다르다(design.md 10.1). 그래서 "지금 내가 무슨 실습인지"
// 부터 잡고 시작한다.
//
// 학교를 고르면 그 학교 급식·연락처·위치가 붙는다. 실습생이 매일 여는 화면이
// 되게 하는 것이 목표라 급식을 맨 위에 둔다.

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  SCHOOLS, findSchool, hasMeal,
  PRACTICUM_STAGES, PRACTICUM_TIMELINE, PRACTICUM_CHECKLIST,
  PRACTICUM_DOCUMENTS, PRACTICUM_MANNERS, PRACTICUM_SUMMARY,
} from "../lib/practicum/schools";

const LS_SCHOOL = "snue.practicum.school";
const LS_CHECKED = "snue.practicum.checked";

function todayKST() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
}

export default function PracticumPage() {
  const [school, setSchool] = useState(null);
  const [picking, setPicking] = useState(false);
  const [meal, setMeal] = useState({ state: "idle", data: null });
  const [checked, setChecked] = useState({});
  const [tab, setTab] = useState("today");

  // 고른 학교와 체크 상태는 이 기기에만 둔다 — 서버에 보낼 이유가 없다.
  useEffect(() => {
    try {
      const s = localStorage.getItem(LS_SCHOOL);
      if (s) setSchool(findSchool(s));
      const c = localStorage.getItem(LS_CHECKED);
      if (c) setChecked(JSON.parse(c));
    } catch { /* 저장소를 못 쓰면 그냥 기본값으로 */ }
  }, []);

  useEffect(() => {
    if (!school || !hasMeal(school)) { setMeal({ state: "idle", data: null }); return; }
    setMeal({ state: "loading", data: null });
    const ymd = todayKST().replaceAll("-", "");
    fetch(`/api/practicum/meal?school=${school.neisCode}&date=${ymd}`)
      .then((r) => r.json())
      .then((d) => setMeal({ state: "done", data: d }))
      .catch(() => setMeal({ state: "error", data: null }));
  }, [school]);

  function pick(s) {
    setSchool(s);
    setPicking(false);
    try { localStorage.setItem(LS_SCHOOL, s.short); } catch {}
  }

  function toggle(key) {
    const next = { ...checked, [key]: !checked[key] };
    setChecked(next);
    try { localStorage.setItem(LS_CHECKED, JSON.stringify(next)); } catch {}
  }

  const doneCount = PRACTICUM_CHECKLIST.filter((c) => checked[c.key]).length;

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center gap-2">
        <Link href="/" className="text-sm text-[#0c4470]/50">‹</Link>
        <h1 className="text-base font-bold text-[#0c4470]">실습</h1>
      </div>

      {/* ── 학교 선택 ── */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        {school ? (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-bold text-[#0c4470]">{school.full ?? school.short}</p>
              {school.address && (
                <p className="mt-0.5 truncate text-[11px] text-[#0c4470]/45">{school.address}</p>
              )}
              <div className="mt-2 flex gap-3 text-[11px]">
                {school.tel && (
                  <a href={`tel:${school.tel}`} className="font-bold text-[#0095da]">전화</a>
                )}
                {school.homepage && (
                  <a href={school.homepage.trim()} target="_blank" rel="noreferrer"
                     className="font-bold text-[#0095da]">홈페이지</a>
                )}
                <a href={`https://map.kakao.com/?q=${encodeURIComponent(school.full ?? school.short)}`}
                   target="_blank" rel="noreferrer" className="font-bold text-[#0095da]">지도</a>
              </div>
            </div>
            <button onClick={() => setPicking(true)}
              className="shrink-0 text-[11px] font-bold text-[#0c4470]/40">변경</button>
          </div>
        ) : (
          <button onClick={() => setPicking(true)} className="w-full text-left">
            <p className="text-sm font-bold text-[#0c4470]">실습학교를 골라주세요</p>
            <p className="mt-0.5 text-[11px] text-[#0c4470]/45">
              고르면 급식·연락처·위치가 여기 붙어요
            </p>
          </button>
        )}

        {picking && (
          <div className="mt-3 border-t border-black/5 pt-3">
            <p className="mb-2 text-[11px] font-bold text-[#0c4470]/40">
              2026-1 협력학교 {SCHOOLS.length}곳
            </p>
            <div className="grid grid-cols-3 gap-1.5">
              {SCHOOLS.map((s) => (
                <button key={s.short} onClick={() => pick(s)}
                  className={`rounded-lg px-2 py-2 text-xs ${
                    school?.short === s.short
                      ? "bg-[#0095da] font-bold text-white"
                      : "bg-[#f2f6fa] text-[#0c4470]/70"}`}>
                  {s.short}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── 탭 ── */}
      <div className="flex gap-1.5">
        {[["today", "오늘"], ["prep", "준비"], ["info", "안내"]].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`rounded-lg px-3 py-1.5 text-xs ${
              tab === k ? "bg-[#0095da] font-bold text-white" : "bg-white text-[#0c4470]/60"}`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── 오늘: 급식 ── */}
      {tab === "today" && (
        <section className="rounded-2xl bg-white p-4 shadow-sm">
          <p className="text-xs font-bold text-[#0c4470]/40">오늘 급식</p>
          {!school && <p className="py-4 text-center text-xs text-[#0c4470]/35">학교를 먼저 골라주세요</p>}
          {school && !hasMeal(school) && (
            <p className="py-4 text-center text-xs text-[#0c4470]/35">이 학교는 급식 정보가 없어요</p>
          )}
          {meal.state === "loading" && (
            <p className="py-4 text-center text-xs text-[#0c4470]/35">불러오는 중…</p>
          )}
          {meal.state === "error" && (
            <p className="py-4 text-center text-xs text-[#c0392b]">급식을 불러오지 못했어요</p>
          )}
          {meal.state === "done" && meal.data?.meals?.length === 0 && (
            <p className="py-4 text-center text-xs text-[#0c4470]/35">
              {meal.data.reason === "no_meal" ? "오늘은 급식이 없어요" : "급식 정보를 못 받았어요"}
            </p>
          )}
          {meal.state === "done" && meal.data?.meals?.map((m, i) => (
            <div key={i} className="mt-2">
              <div className="flex items-baseline justify-between">
                <p className="text-sm font-bold text-[#0c4470]">{m.type}</p>
                {m.calorie && <p className="text-[11px] text-[#0c4470]/40">{m.calorie}</p>}
              </div>
              <ul className="mt-1.5 flex flex-col gap-1">
                {m.dishes.map((d, j) => (
                  <li key={j} className="text-sm text-[#0c4470]/80">
                    {d.name}
                    {d.allergens.length > 0 && (
                      <span className="ml-1 text-[10px] text-[#0c4470]/30">
                        {d.allergens.join("·")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="mt-3 border-t border-black/5 pt-2 text-[10px] text-[#0c4470]/30">
            숫자는 알레르기 유발식품 번호예요 · 나이스 교육정보 개방포털
          </p>
        </section>
      )}

      {/* ── 준비: 체크리스트 ── */}
      {tab === "prep" && (
        <>
          <section className="rounded-2xl bg-white p-4 shadow-sm">
            <div className="flex items-baseline justify-between">
              <p className="text-xs font-bold text-[#0c4470]/40">실습 체크리스트</p>
              <p className="text-[11px] text-[#0c4470]/40">
                {doneCount}/{PRACTICUM_CHECKLIST.length}
              </p>
            </div>
            <ul className="mt-2 flex flex-col gap-2.5">
              {PRACTICUM_CHECKLIST.map((c) => (
                <li key={c.key}>
                  <label className="flex cursor-pointer items-start gap-2.5">
                    <input type="checkbox" checked={Boolean(checked[c.key])}
                      onChange={() => toggle(c.key)}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-[#0095da]" />
                    <span className="min-w-0">
                      <span className={`text-sm ${checked[c.key]
                        ? "text-[#0c4470]/35 line-through" : "text-[#0c4470]"}`}>
                        {c.label}
                      </span>
                      {c.critical && !checked[c.key] && (
                        <span className="ml-1 rounded bg-[#fff0f0] px-1 text-[10px] font-bold text-[#c0392b]">
                          필수
                        </span>
                      )}
                      <span className="block text-[11px] text-[#0c4470]/40">{c.when}</span>
                      {c.note && (
                        <span className="mt-0.5 block text-[11px] text-[#0c4470]/55">{c.note}</span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="text-xs font-bold text-[#0c4470]/40">예비소집일 제출서류</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {PRACTICUM_DOCUMENTS.map((d) => (
                <li key={d.name} className="text-sm text-[#0c4470]">
                  {d.name}
                  <span className="ml-1 text-[11px] text-[#0c4470]/45">{d.note}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {/* ── 안내: 단계·흐름·매너 ── */}
      {tab === "info" && (
        <>
          <section className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="text-xs font-bold text-[#0c4470]/40">실습 5단계</p>
            <ul className="mt-2 flex flex-col gap-2">
              {PRACTICUM_STAGES.map((s) => (
                <li key={s.name} className="border-b border-black/5 pb-2 last:border-0 last:pb-0">
                  <div className="flex items-baseline justify-between">
                    <p className="text-sm font-bold text-[#0c4470]">
                      {s.grade}학년 {s.term}학기 · {s.name}
                    </p>
                    <p className="text-[11px] text-[#0c4470]/40">{s.weeks}주 · {s.credit}</p>
                  </div>
                  <p className="mt-0.5 text-[11px] text-[#0c4470]/55">{s.focus}</p>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="text-xs font-bold text-[#0c4470]/40">실습 전후 흐름</p>
            <ol className="mt-2 flex flex-col gap-1.5">
              {PRACTICUM_TIMELINE.map((t, i) => (
                <li key={t.step} className="flex gap-2 text-sm">
                  <span className="w-4 shrink-0 text-[11px] text-[#0c4470]/30">{i + 1}</span>
                  <span>
                    <span className={t.critical ? "font-bold text-[#c0392b]" : "text-[#0c4470]"}>
                      {t.step}
                    </span>
                    <span className="ml-1 text-[11px] text-[#0c4470]/45">{t.note}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="text-xs font-bold text-[#0c4470]/40">알아둘 것</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {PRACTICUM_MANNERS.map((m) => (
                <li key={m} className="text-sm text-[#0c4470]/80">· {m}</li>
              ))}
            </ul>
          </section>

          {PRACTICUM_SUMMARY && (
            <p className="px-1 text-[11px] text-[#0c4470]/35">
              2026-1 기준 관찰실습 {PRACTICUM_SUMMARY.관찰실습?.인원}명 ·
              종합실습 {PRACTICUM_SUMMARY.종합실습?.인원}명.
              배정인원은 휴학·실습포기 등으로 바뀔 수 있어요.
            </p>
          )}
        </>
      )}
    </div>
  );
}
