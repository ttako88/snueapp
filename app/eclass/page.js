"use client"; // 로그인 입력·연결 상태를 브라우저에서 처리

import Link from "next/link";
import { useEffect, useState } from "react";
import { eventStyle } from "../lib/eventStyle";

// e-Class 활동 종류 → 우리 앱 색(캘린더와 동일 규칙)
function typeStyle(modulename) {
  if (modulename === "assign") return { ...eventStyle("과제"), label: "과제" };
  if (modulename === "quiz") return { ...eventStyle("시험"), label: "퀴즈" };
  if (["vod", "resource", "url", "page", "lesson"].includes(modulename))
    return { ...eventStyle("영상강의"), label: "영상강의" };
  return { ...eventStyle("학사일정"), label: modulename || "기타" };
}

export default function EclassPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [events, setEvents] = useState(null); // 마감 목록
  const [evLoading, setEvLoading] = useState(false);
  const [evError, setEvError] = useState("");

  // 이미 연결돼 있는지 확인 (토큰은 이 브라우저에만 저장됨)
  useEffect(() => {
    const t = localStorage.getItem("eclassToken");
    setConnected(Boolean(t));
    setLoaded(true);
    if (t) loadDeadlines(t);
  }, []);

  // 마감 일정 불러오기 (토큰은 본문으로 전달 — 주소에 안 남게)
  async function loadDeadlines(token) {
    setEvLoading(true);
    setEvError("");
    try {
      const res = await fetch("/api/eclass/deadlines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (data.events) setEvents(data.events);
      else {
        setEvError(data.error || "일정을 불러오지 못했어요.");
        if (data.expired) {
          localStorage.removeItem("eclassToken");
          setConnected(false);
        }
      }
    } catch {
      setEvError("일정을 불러오는 중 문제가 생겼어요.");
    } finally {
      setEvLoading(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/eclass/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (data.token) {
        localStorage.setItem("eclassToken", data.token);
        setConnected(true);
        setUsername("");
        setPassword(""); // 입력값 즉시 비움 (화면에도 안 남게)
        loadDeadlines(data.token);
      } else {
        setError(data.error || "로그인에 실패했어요.");
      }
    } catch {
      setError("연결 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setLoading(false);
    }
  }

  function disconnect() {
    localStorage.removeItem("eclassToken");
    setConnected(false);
  }

  if (!loaded) return null;

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="flex items-center gap-2">
        <Link href="/courses" className="text-[#0c4470]/50">‹ 강의</Link>
        <h2 className="text-lg font-bold text-[#0c4470]">e-Class 연동</h2>
      </div>

      {/* ── 개인정보 안내 (가장 중요) ── */}
      <section className="rounded-2xl border border-[#0095da]/20 bg-[#eaf6fd] p-4">
        <p className="mb-2 text-sm font-bold text-[#0c4470]">🔒 이 화면은 &lsquo;거쳐가는 통로&rsquo;일 뿐이에요</p>
        <ul className="flex flex-col gap-1.5 text-xs leading-relaxed text-[#0c4470]/75">
          <li>• 이 앱은 여러분의 <b>아이디·비밀번호를 저장하지 않아요.</b></li>
          <li>• 기록(로그)으로도 <b>남기지 않아요.</b></li>
          <li>• 입력한 정보는 학교 e-Class 서버로 <b>그대로 전달만</b> 되고, 전달이 끝나는 순간 사라져요.</li>
          <li>• 학교가 발급해준 <b>&lsquo;이용권(토큰)&rsquo;만</b> 여러분 <b>기기(이 브라우저)에</b> 저장돼요. 우리 서버엔 안 올라가요.</li>
          <li>• 연결은 <b>언제든 해제</b>할 수 있고, 해제하면 이용권도 기기에서 지워져요.</li>
        </ul>
        <p className="mt-2.5 border-t border-[#0095da]/15 pt-2 text-[11px] leading-relaxed text-[#0c4470]/55">
          기술적으로는 학교 e-Class(무들)의 공식 <b>모바일 앱용 토큰 API</b>(<code className="rounded bg-white/60 px-1">login/token.php</code>)를
          그대로 사용해요. 학교 앱이 로그인하는 방식과 똑같아요.
          <br />
          코드가 궁금하면 직접 확인할 수 있어요 →{" "}
          <a
            href="https://github.com/ttako88/snueapp/blob/main/app/api/eclass/token/route.js"
            target="_blank"
            rel="noopener noreferrer"
            className="font-bold text-[#0095da] underline"
          >
            소스코드 보기
          </a>
        </p>
      </section>

      {connected ? (
        /* ── 연결 완료 상태 ── */
        <>
          <section className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm">
            <span className="text-2xl">✅</span>
            <div className="min-w-0 flex-1">
              <p className="font-bold text-[#0c4470]">e-Class에 연결됐어요!</p>
              <p className="text-xs text-[#0c4470]/50">이용권은 이 기기에만 저장돼 있어요</p>
            </div>
            <button
              onClick={disconnect}
              className="shrink-0 rounded-full bg-[#fdecec] px-3 py-1.5 text-xs font-bold text-[#d05b6a] active:opacity-80"
            >
              연결 해제
            </button>
          </section>

          {/* 내 마감 일정 */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-bold text-[#0c4470]">📌 다가오는 마감</h3>
              <button
                onClick={() => loadDeadlines(localStorage.getItem("eclassToken"))}
                className="rounded-full bg-black/5 px-2.5 py-1 text-[11px] font-bold text-[#0c4470]/60"
              >
                새로고침
              </button>
            </div>

            {evLoading && <p className="py-6 text-center text-sm text-[#0c4470]/40">불러오는 중…</p>}
            {evError && <p className="rounded-xl bg-[#fdecec] px-3 py-2.5 text-xs text-[#d05b6a]">{evError}</p>}
            {!evLoading && !evError && events?.length === 0 && (
              <p className="py-6 text-center text-sm text-[#0c4470]/40">
                다가오는 마감이 없어요. (방학이면 비어 있는 게 정상이에요!)
              </p>
            )}

            <ul className="flex flex-col gap-2">
              {(events || []).map((ev) => {
                const st = typeStyle(ev.type);
                const d = new Date(ev.timestamp * 1000);
                const dLabel = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
                const dday = Math.ceil((d - new Date()) / 86400000);
                return (
                  <li
                    key={ev.id}
                    className="flex items-stretch gap-2.5 overflow-hidden rounded-xl"
                    style={{ backgroundColor: st.bg }}
                  >
                    <span className="w-1 shrink-0" style={{ backgroundColor: st.main }} />
                    <div className="min-w-0 flex-1 py-2 pr-2">
                      <p className="truncate font-medium text-[#0c4470]">{ev.title}</p>
                      <p className="mt-0.5 truncate text-xs" style={{ color: st.text }}>
                        {ev.course && `${ev.course} · `}{dLabel}
                        {dday >= 0 && dday <= 7 && <b> · D-{dday}</b>}
                      </p>
                    </div>
                    <span
                      className="shrink-0 self-center rounded-full px-2 py-0.5 text-[10px] font-bold"
                      style={{ backgroundColor: st.main, color: "#fff" }}
                    >
                      {st.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      ) : (
        /* ── 로그인 폼 ── */
        <form onSubmit={submit} className="flex flex-col gap-2.5">
          <div>
            <label className="mb-1 block text-xs font-bold text-[#0c4470]/50">e-Class 아이디 (학번)</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              placeholder="예: 20251423"
              className="w-full rounded-xl bg-white px-3 py-3 text-sm text-[#0c4470] shadow-sm outline-none placeholder:text-[#0c4470]/30 focus:ring-2 focus:ring-[#0095da]/40"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold text-[#0c4470]/50">비밀번호</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="e-Class 비밀번호"
              className="w-full rounded-xl bg-white px-3 py-3 text-sm text-[#0c4470] shadow-sm outline-none placeholder:text-[#0c4470]/30 focus:ring-2 focus:ring-[#0095da]/40"
            />
          </div>

          {error && (
            <p className="rounded-xl bg-[#fdecec] px-3 py-2.5 text-xs font-medium text-[#d05b6a]">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !username.trim() || !password.trim()}
            className="mt-1 w-full rounded-xl bg-[#0095da] py-3 text-sm font-bold text-white active:opacity-80 disabled:opacity-40"
          >
            {loading ? "연결하는 중…" : "e-Class 연결하기"}
          </button>
          <p className="text-center text-[11px] text-[#0c4470]/40">
            학교 e-Class 계정으로 로그인해요 (SNUE 포털과 같은 계정)
          </p>
        </form>
      )}
    </div>
  );
}
