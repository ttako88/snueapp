"use client"; // 달력 조작·내 일정 추가·숨김을 브라우저에서 처리

import { useEffect, useMemo, useRef, useState } from "react";
import { eventStyle } from "../lib/eventStyle";

/* ---------- 날짜 도구 ---------- */
const DAYMS = 86400000;
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}
function parseYmd(s) {
  const [y, m, d] = s.split("/").map(Number);
  return new Date(y, m - 1, d);
}
const toDash = (s) => s.replaceAll("/", "-");
const fromDash = (s) => s.replaceAll("-", "/");
function dayDiff(a, b) {
  const A = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const B = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((B - A) / DAYMS);
}

// 내 일정 분류 (색은 eventStyle 재사용)
const PERSONAL_CATS = [
  { key: "과제", label: "과제" },
  { key: "시험", label: "시험" },
  { key: "영상강의", label: "영상강의" },
  { key: "학사일정", label: "일정" },
];

const MAX_LANES = 3; // 한 주에 보여줄 줄 수 (넘으면 +N)

// 학교 일정을 숨김 저장할 때 쓰는 안정적인 키 (배열 순서와 무관)
const hideKey = (e) => `${e.title}|${e.start}|${e.end}`;

/* ---------- 왼쪽 스와이프로 '숨김' 버튼 여는 행 ---------- */
function SwipeRow({ children, onHide }) {
  const [dx, setDx] = useState(0);
  const openRef = useRef(false);
  const startRef = useRef(null);
  const OPEN_X = -72;

  function down(e) {
    startRef.current = e.clientX - (openRef.current ? OPEN_X : 0);
  }
  function move(e) {
    if (startRef.current == null) return;
    let d = e.clientX - startRef.current;
    if (d > 0) d = 0;
    if (d < OPEN_X) d = OPEN_X;
    setDx(d);
  }
  function up() {
    if (startRef.current == null) return;
    const open = dx < OPEN_X / 2;
    openRef.current = open;
    setDx(open ? OPEN_X : 0);
    startRef.current = null;
  }

  return (
    <div className="relative overflow-hidden rounded-xl">
      <button
        onClick={onHide}
        className="absolute right-0 top-0 flex h-full w-[72px] items-center justify-center bg-[#d05b6a] text-xs font-bold text-white"
      >
        숨김
      </button>
      <div
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        style={{
          transform: `translateX(${dx}px)`,
          transition: startRef.current == null ? "transform .2s" : "none",
          touchAction: "pan-y",
        }}
      >
        {children}
      </div>
    </div>
  );
}

export default function CalendarPage() {
  const [schoolEvents, setSchoolEvents] = useState([]);
  const [personal, setPersonal] = useState([]);
  const [hidden, setHidden] = useState([]); // 숨긴 학사일정 키 목록
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [pLoaded, setPLoaded] = useState(false);

  const today = new Date();
  const todayStr = ymd(today);

  const [cursor, setCursor] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [selected, setSelected] = useState(todayStr);
  const [mode, setMode] = useState("dots"); // dots(얇은 선) | bars(글자 막대), 기본 점

  // 일정 추가/수정 시트
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(null);

  /* ---------- 저장된 설정·내 일정·숨김 불러오기 ---------- */
  useEffect(() => {
    const savedMode = localStorage.getItem("calendarMode");
    if (savedMode === "dots" || savedMode === "bars") setMode(savedMode);
    try {
      const my = JSON.parse(localStorage.getItem("myEvents") || "[]");
      if (Array.isArray(my)) setPersonal(my);
      const hid = JSON.parse(localStorage.getItem("hiddenSchedule") || "[]");
      if (Array.isArray(hid)) setHidden(hid);
    } catch {}
    setPLoaded(true);
  }, []);
  useEffect(() => {
    if (pLoaded) localStorage.setItem("myEvents", JSON.stringify(personal));
  }, [personal, pLoaded]);
  useEffect(() => {
    if (pLoaded) localStorage.setItem("hiddenSchedule", JSON.stringify(hidden));
  }, [hidden, pLoaded]);

  function changeMode(next) {
    setMode(next);
    localStorage.setItem("calendarMode", next);
  }

  /* ---------- 학사일정 불러오기 ---------- */
  useEffect(() => {
    fetch("/api/schedule")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(true);
        else
          setSchoolEvents(
            d.map((e, i) => ({ ...e, id: "s" + i, category: "학사일정", source: "school" }))
          );
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);

  // 학교(숨김 제외) + 내 일정
  const allEvents = useMemo(() => {
    const school = schoolEvents.filter((e) => !hiddenSet.has(hideKey(e)));
    const mine = personal.map((e) => ({ ...e, source: "me" }));
    return [...school, ...mine];
  }, [schoolEvents, personal, hiddenSet]);

  // 숨긴 학사일정(되돌리기 목록용)
  const hiddenEvents = useMemo(
    () => schoolEvents.filter((e) => hiddenSet.has(hideKey(e))),
    [schoolEvents, hiddenSet]
  );

  function eventsOn(dateStr) {
    return allEvents
      .filter((e) => e.start <= dateStr && dateStr <= e.end)
      .sort((a, b) => a.start.localeCompare(b.start));
  }

  function hideSchool(e) {
    setHidden((h) => (h.includes(hideKey(e)) ? h : [...h, hideKey(e)]));
  }
  function restoreSchool(key) {
    setHidden((h) => h.filter((k) => k !== key));
  }

  /* ---------- 달력 격자(6주×7일) ---------- */
  const cells = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const start = new Date(year, month, 1 - firstDay);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [cursor]);

  const weeks = useMemo(() => {
    const out = [];
    for (let i = 0; i < 42; i += 7) out.push(cells.slice(i, i + 7));
    return out;
  }, [cells]);

  // 한 주에 걸치는 일정들을 줄(레인)에 배치
  function layoutWeek(week) {
    const wStart = week[0];
    const ws = ymd(week[0]);
    const we = ymd(week[6]);
    const segs = allEvents
      .filter((e) => e.start <= we && e.end >= ws)
      .map((e) => {
        const s = Math.max(0, dayDiff(wStart, parseYmd(e.start)));
        const en = Math.min(6, dayDiff(wStart, parseYmd(e.end)));
        return { ev: e, startCol: s, span: en - s + 1, contPrev: e.start < ws, contNext: e.end > we };
      })
      .sort((a, b) => a.startCol - b.startCol || b.span - a.span);

    const lanes = [];
    for (const seg of segs) {
      let placed = false;
      for (let i = 0; i < lanes.length; i++) {
        if (lanes[i].every((r) => seg.startCol + seg.span - 1 < r[0] || seg.startCol > r[1])) {
          lanes[i].push([seg.startCol, seg.startCol + seg.span - 1]);
          seg.lane = i;
          placed = true;
          break;
        }
      }
      if (!placed) {
        seg.lane = lanes.length;
        lanes.push([[seg.startCol, seg.startCol + seg.span - 1]]);
      }
    }
    const shown = segs.filter((s) => s.lane < MAX_LANES);
    return { shown, overflow: segs.length - shown.length };
  }

  const monthTitle = `${cursor.getFullYear()}년 ${cursor.getMonth() + 1}월`;
  function moveMonth(delta) {
    setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1));
  }

  const selectedEvents = eventsOn(selected);
  const selLabel = (() => {
    const d = parseYmd(selected);
    return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
  })();

  function numColor(d, inMonth) {
    if (!inMonth) return "text-[#0c4470]/25";
    if (d.getDay() === 0) return "text-[#d05b6a]";
    if (d.getDay() === 6) return "text-[#4b86c7]";
    return "text-[#0c4470]";
  }

  /* ---------- 내 일정 추가/수정 시트 ---------- */
  function openAdd() {
    setEditingId(null);
    setForm({
      title: "",
      category: "과제",
      start: toDash(selected),
      end: toDash(selected),
      allDay: true,
      startTime: "09:00",
      endTime: "10:00",
    });
    setSheetOpen(true);
  }
  function openEdit(e) {
    setEditingId(e.id);
    setForm({
      title: e.title,
      category: e.category,
      start: toDash(e.start),
      end: toDash(e.end),
      allDay: e.allDay !== false,
      startTime: e.startTime || "09:00",
      endTime: e.endTime || "10:00",
    });
    setSheetOpen(true);
  }
  function saveForm() {
    if (!form.title.trim()) return;
    let start = fromDash(form.start);
    let end = fromDash(form.end);
    if (end < start) end = start;
    const base = {
      title: form.title.trim(),
      category: form.category,
      start,
      end,
      allDay: form.allDay,
      startTime: form.startTime,
      endTime: form.endTime,
    };
    if (editingId) setPersonal((ps) => ps.map((p) => (p.id === editingId ? { ...p, ...base } : p)));
    else setPersonal((ps) => [...ps, { id: crypto.randomUUID(), ...base }]);
    setSelected(start);
    setSheetOpen(false);
  }
  function deleteEvent(id) {
    setPersonal((ps) => ps.filter((p) => p.id !== id));
  }
  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="flex h-full flex-col">
      {/* 헤더 */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => moveMonth(-1)}
            className="flex h-8 w-8 items-center justify-center rounded-full text-lg text-[#0c4470]/60 active:bg-black/5"
            aria-label="이전 달"
          >
            ‹
          </button>
          <h2 className="text-lg font-bold text-[#0c4470]">{monthTitle}</h2>
          <button
            onClick={() => moveMonth(1)}
            className="flex h-8 w-8 items-center justify-center rounded-full text-lg text-[#0c4470]/60 active:bg-black/5"
            aria-label="다음 달"
          >
            ›
          </button>
        </div>
        <div className="flex rounded-full bg-black/5 p-0.5 text-[11px] font-bold">
          <button
            onClick={() => changeMode("dots")}
            className={`rounded-full px-2.5 py-1 transition ${mode === "dots" ? "bg-white text-[#0095da] shadow-sm" : "text-[#0c4470]/45"}`}
          >
            점
          </button>
          <button
            onClick={() => changeMode("bars")}
            className={`rounded-full px-2.5 py-1 transition ${mode === "bars" ? "bg-white text-[#0095da] shadow-sm" : "text-[#0c4470]/45"}`}
          >
            막대
          </button>
        </div>
      </div>

      {/* 요일 헤더 */}
      <div className="grid grid-cols-7 px-2 text-center text-[11px] font-bold">
        {WEEKDAYS.map((w, i) => (
          <div key={w} className={`py-1 ${i === 0 ? "text-[#d05b6a]" : i === 6 ? "text-[#4b86c7]" : "text-[#0c4470]/40"}`}>
            {w}
          </div>
        ))}
      </div>

      {/* 달력 본문 (점=얇은 선 / 막대=글자 바, 둘 다 이어지는 레인) */}
      <div className="px-1">
        {weeks.map((week, wi) => {
          const { shown, overflow } = layoutWeek(week);
          const usedLanes = shown.length ? Math.max(...shown.map((s) => s.lane)) + 1 : 0;
          const lanes = Array.from({ length: usedLanes }, (_, li) => shown.filter((s) => s.lane === li));
          return (
            <div key={wi} className="border-t border-black/5 pb-1">
              {/* 날짜 숫자 */}
              <div className="grid grid-cols-7">
                {week.map((d, di) => {
                  const ds = ymd(d);
                  const inMonth = d.getMonth() === cursor.getMonth();
                  const isToday = ds === todayStr;
                  const isSelected = ds === selected;
                  return (
                    <button
                      key={di}
                      onClick={() => setSelected(ds)}
                      className={`flex flex-col items-center pt-1 ${isSelected ? "rounded-lg bg-[#eaf6fd]" : ""}`}
                    >
                      <span
                        className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${isToday ? "bg-[#0095da] text-white" : numColor(d, inMonth)}`}
                      >
                        {d.getDate()}
                      </span>
                    </button>
                  );
                })}
              </div>
              {/* 줄(레인) */}
              {lanes.map((laneSegs, li) => (
                <div key={li} className="mt-px grid grid-cols-7 gap-px px-0.5">
                  {laneSegs.map((s, si) => {
                    const st = eventStyle(s.ev.category);
                    const isSchool = s.ev.source === "school";
                    if (mode === "dots") {
                      // 점 모드 = 얇고 진한 연속 선 (글자 없음)
                      return (
                        <div
                          key={si}
                          className="h-1 self-center rounded-full"
                          style={{ gridColumn: `${s.startCol + 1} / span ${s.span}`, backgroundColor: st.main }}
                        />
                      );
                    }
                    // 막대 모드 = 글자 있는 넓은 막대 (학교=연하게, 내것=진하게)
                    return (
                      <div
                        key={si}
                        className="truncate rounded-sm px-1 text-[9px] font-bold leading-[15px]"
                        style={{
                          gridColumn: `${s.startCol + 1} / span ${s.span}`,
                          backgroundColor: isSchool ? st.bg : st.main,
                          color: isSchool ? st.text : "#fff",
                        }}
                      >
                        {s.contPrev ? "← " : ""}
                        {s.ev.title}
                        {s.contNext ? " →" : ""}
                      </div>
                    );
                  })}
                </div>
              ))}
              {overflow > 0 && (
                <div className="px-1 pt-px text-right text-[9px] font-bold text-[#0c4470]/40">+{overflow}</div>
              )}
            </div>
          );
        })}
      </div>

      {/* 선택 날짜 일정 목록 */}
      <div className="mt-2 flex-1 overflow-y-auto border-t border-black/5 bg-white px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-bold text-[#0c4470]">{selLabel}</p>
          <button
            onClick={openAdd}
            className="rounded-full bg-[#0095da] px-3 py-1 text-xs font-bold text-white active:opacity-80"
          >
            + 추가
          </button>
        </div>

        {loading && <p className="py-6 text-center text-sm text-[#0c4470]/40">불러오는 중…</p>}
        {error && <p className="py-6 text-center text-sm text-[#0c4470]/40">일정을 불러오지 못했어요.</p>}
        {!loading && !error && selectedEvents.length === 0 && (
          <p className="py-6 text-center text-sm text-[#0c4470]/40">이 날은 일정이 없어요. + 추가로 넣어보세요!</p>
        )}

        <ul className="flex flex-col gap-2">
          {selectedEvents.map((e) => {
            const st = eventStyle(e.category);
            const mine = e.source === "me";
            const isRange = e.start !== e.end;
            // 공통 카드 내용
            const body = (
              <div className="flex items-stretch gap-2.5" style={{ backgroundColor: st.bg }}>
                <span className="w-1 shrink-0" style={{ backgroundColor: st.main }} />
                <div className="min-w-0 flex-1 py-2 pr-2">
                  <p className="font-medium text-[#0c4470]">{e.detail || e.title}</p>
                  <p className="mt-0.5 text-xs" style={{ color: st.text }}>
                    {mine && !e.allDay && `${e.startTime}~${e.endTime} · `}
                    {isRange ? `${e.start.slice(5)} ~ ${e.end.slice(5)}` : mine && e.allDay ? "하루 종일" : ""}
                    {mine ? " · 내 일정" : ""}
                  </p>
                </div>
              </div>
            );

            // 내 일정: 탭 수정 + × 삭제
            if (mine) {
              return (
                <li key={e.id} className="flex items-stretch gap-2.5 overflow-hidden rounded-xl" style={{ backgroundColor: st.bg }}>
                  <span className="w-1 shrink-0" style={{ backgroundColor: st.main }} />
                  <button onClick={() => openEdit(e)} className="min-w-0 flex-1 py-2 pr-2 text-left">
                    <p className="font-medium text-[#0c4470]">{e.title}</p>
                    <p className="mt-0.5 text-xs" style={{ color: st.text }}>
                      {!e.allDay && `${e.startTime}~${e.endTime} · `}
                      {isRange ? `${e.start.slice(5)} ~ ${e.end.slice(5)}` : e.allDay ? "하루 종일" : ""}
                      {" · 내 일정"}
                    </p>
                  </button>
                  <button
                    onClick={() => deleteEvent(e.id)}
                    className="px-2 text-lg text-[#0c4470]/30 active:text-[#d05b6a]"
                    aria-label="삭제"
                  >
                    ×
                  </button>
                </li>
              );
            }

            // 학사일정: 왼쪽 스와이프 → 숨김
            return (
              <li key={e.id}>
                <SwipeRow onHide={() => hideSchool(e)}>{body}</SwipeRow>
              </li>
            );
          })}
        </ul>

        {/* 숨긴 학사일정 되돌리기 */}
        {hiddenEvents.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-xs font-bold text-[#0c4470]/40">
              숨긴 학사일정 {hiddenEvents.length}개
            </summary>
            <ul className="mt-2 flex flex-col gap-1.5">
              {hiddenEvents.map((e) => (
                <li key={hideKey(e)} className="flex items-center gap-2 rounded-lg bg-[#f2f6fa] px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-[#0c4470]/60">
                    {e.detail || e.title}
                  </span>
                  <button
                    onClick={() => restoreSchool(hideKey(e))}
                    className="shrink-0 text-xs font-bold text-[#0095da]"
                  >
                    ↩ 되돌리기
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {/* 일정 추가/수정 시트 */}
      {sheetOpen && form && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30" onClick={() => setSheetOpen(false)}>
          <div className="w-full max-w-[480px] rounded-t-2xl bg-white p-4 pb-6" onClick={(ev) => ev.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-bold text-[#0c4470]">{editingId ? "일정 수정" : "일정 추가"}</h3>
              <button onClick={() => setSheetOpen(false)} className="text-xl text-[#0c4470]/40">
                ×
              </button>
            </div>

            <input
              autoFocus
              value={form.title}
              onChange={(e) => setF("title", e.target.value)}
              placeholder="예: 국어교육 중간시험, 조별과제 발표"
              className="mb-3 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm text-[#0c4470] outline-none placeholder:text-[#0c4470]/30 focus:ring-2 focus:ring-[#0095da]/40"
            />

            <div className="mb-3 flex gap-2">
              {PERSONAL_CATS.map((c) => {
                const active = form.category === c.key;
                const st = eventStyle(c.key);
                return (
                  <button
                    key={c.key}
                    onClick={() => setF("category", c.key)}
                    className="flex-1 rounded-full py-1.5 text-xs font-bold transition"
                    style={active ? { backgroundColor: st.main, color: "#fff" } : { backgroundColor: st.bg, color: st.text }}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>

            <div className="mb-3 flex items-center gap-2">
              <input
                type="date"
                value={form.start}
                onChange={(e) => setF("start", e.target.value)}
                className="flex-1 rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm text-[#0c4470] outline-none"
              />
              <span className="text-[#0c4470]/40">~</span>
              <input
                type="date"
                value={form.end}
                onChange={(e) => setF("end", e.target.value)}
                className="flex-1 rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm text-[#0c4470] outline-none"
              />
            </div>

            <div className="mb-4 flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm text-[#0c4470]">
                <input
                  type="checkbox"
                  checked={form.allDay}
                  onChange={(e) => setF("allDay", e.target.checked)}
                  className="h-4 w-4 accent-[#0095da]"
                />
                하루 종일
              </label>
              {!form.allDay && (
                <div className="flex items-center gap-1">
                  <input
                    type="time"
                    value={form.startTime}
                    onChange={(e) => setF("startTime", e.target.value)}
                    className="rounded-lg bg-[#f2f6fa] px-2 py-1.5 text-sm text-[#0c4470] outline-none"
                  />
                  <span className="text-[#0c4470]/40">~</span>
                  <input
                    type="time"
                    value={form.endTime}
                    onChange={(e) => setF("endTime", e.target.value)}
                    className="rounded-lg bg-[#f2f6fa] px-2 py-1.5 text-sm text-[#0c4470] outline-none"
                  />
                </div>
              )}
            </div>

            <button
              onClick={saveForm}
              disabled={!form.title.trim()}
              className="w-full rounded-xl bg-[#0095da] py-3 text-sm font-bold text-white active:opacity-80 disabled:opacity-40"
            >
              {editingId ? "수정 완료" : "저장"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
