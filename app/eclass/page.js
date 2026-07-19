"use client"; // 토큰 입력·연결 상태를 브라우저에서 처리

import Link from "next/link";
import { useEffect, useState } from "react";
import { eventStyle } from "../lib/eventStyle";

const TOKEN_PAGE = "https://lms.snue.ac.kr/user/managetoken.php";

// e-Class 활동 종류 → 우리 앱 색(캘린더와 동일 규칙)
function typeStyle(modulename) {
  if (modulename === "assign") return { ...eventStyle("과제"), label: "과제" };
  if (modulename === "quiz") return { ...eventStyle("시험"), label: "퀴즈" };
  if (["vod", "resource", "url", "page", "lesson"].includes(modulename))
    return { ...eventStyle("영상강의"), label: "영상강의" };
  return { ...eventStyle("학사일정"), label: modulename || "기타" };
}

export default function EclassPage() {
  const [tokenInput, setTokenInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [events, setEvents] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const t = localStorage.getItem("eclassToken");
    setConnected(Boolean(t));
    setLoaded(true);
    if (t) loadDeadlines(t);
  }, []);

  // 마감 일정 불러오기 (토큰은 본문으로 전달 — 주소에 안 남게)
  async function loadDeadlines(token, { isNew = false } = {}) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/eclass/deadlines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (data.events) {
        setEvents(data.events);
        if (isNew) {
          localStorage.setItem("eclassToken", token); // 확인된 토큰만 저장
          setConnected(true);
          setTokenInput("");
        }
      } else {
        setError(
          isNew
            ? "이 키로는 연결되지 않았어요. e-Class에서 복사한 값이 맞는지 확인해 주세요."
            : data.error || "일정을 불러오지 못했어요."
        );
        if (!isNew && data.expired) {
          localStorage.removeItem("eclassToken");
          setConnected(false);
        }
      }
    } catch {
      setError("연결 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setLoading(false);
    }
  }

  function connect(e) {
    e.preventDefault();
    const t = tokenInput.trim();
    if (t) loadDeadlines(t, { isNew: true });
  }

  function disconnect() {
    localStorage.removeItem("eclassToken");
    setConnected(false);
    setEvents(null);
    setError("");
  }

  if (!loaded) return null;

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="flex items-center gap-2">
        <Link href="/courses" className="text-[#0c4470]/50">‹ 강의</Link>
        <h2 className="text-lg font-bold text-[#0c4470]">e-Class 연동</h2>
      </div>

      {/* ── 개인정보 안내 ── */}
      <section className="rounded-2xl border border-[#0095da]/20 bg-[#eaf6fd] p-4">
        <p className="mb-2 text-sm font-bold text-[#0c4470]">🔒 비밀번호는 아예 받지 않아요</p>
        <ul className="flex flex-col gap-1.5 text-xs leading-relaxed text-[#0c4470]/75">
          <li>• 이 앱에는 <b>비밀번호를 입력하는 칸 자체가 없어요.</b></li>
          <li>• 로그인은 <b>학교 e-Class 사이트에서만</b> 하시게 돼요.</li>
          <li>• 이 앱은 학교가 발급한 <b>&lsquo;보안 키(이용권)&rsquo;만</b> 받아서, 여러분의 <b>마감 일정을 읽기만</b> 해요.</li>
          <li>• 그 키는 <b>여러분 기기(이 브라우저)에만</b> 저장돼요. 우리 서버엔 안 올라가요.</li>
          <li>• 언제든 <b>연결 해제</b> 가능하고, 해제하면 기기에서도 지워져요.</li>
        </ul>
        <p className="mt-2.5 border-t border-[#0095da]/15 pt-2 text-[11px] leading-relaxed text-[#0c4470]/55">
          학교 e-Class(무들)의 공식 <b>보안 키</b> 기능을 그대로 사용해요. 코드는 공개돼 있어요 →{" "}
          <a
            href="https://github.com/ttako88/snueapp/blob/main/app/api/eclass/deadlines/route.js"
            target="_blank"
            rel="noopener noreferrer"
            className="font-bold text-[#0095da] underline"
          >
            소스코드 보기
          </a>
        </p>
      </section>

      {connected ? (
        <>
          <section className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm">
            <span className="text-2xl">✅</span>
            <div className="min-w-0 flex-1">
              <p className="font-bold text-[#0c4470]">e-Class에 연결됐어요!</p>
              <p className="text-xs text-[#0c4470]/50">보안 키는 이 기기에만 저장돼 있어요</p>
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

            {loading && <p className="py-6 text-center text-sm text-[#0c4470]/40">불러오는 중…</p>}
            {error && <p className="rounded-xl bg-[#fdecec] px-3 py-2.5 text-xs text-[#d05b6a]">{error}</p>}
            {!loading && !error && events?.length === 0 && (
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
                  <li key={ev.id} className="flex items-stretch gap-2.5 overflow-hidden rounded-xl" style={{ backgroundColor: st.bg }}>
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
        <>
          {/* ── 보안 키 가져오는 방법 ── */}
          <section className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="mb-3 text-sm font-bold text-[#0c4470]">🔑 보안 키 가져오는 방법</p>
            <ol className="flex flex-col gap-2.5 text-xs leading-relaxed text-[#0c4470]/75">
              <li>
                <b className="text-[#0095da]">1.</b> 아래 버튼을 눌러 <b>학교 e-Class에 로그인</b>하세요.
                <br />
                <span className="text-[#0c4470]/50">(로그인은 학교 사이트에서만 이뤄져요)</span>
              </li>
              <li>
                <b className="text-[#0095da]">2.</b> 열린 <b>&lsquo;보안 키(Security keys)&rsquo;</b> 페이지에서
                <br />
                <b>Moodle 모바일 웹 서비스</b> 항목의 <b>키 값을 복사</b>하세요.
              </li>
              <li>
                <b className="text-[#0095da]">3.</b> 아래 칸에 <b>붙여넣고 연결</b>하면 끝이에요!
              </li>
            </ol>
            <a
              href={TOKEN_PAGE}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 block rounded-xl bg-[#0095da] py-2.5 text-center text-sm font-bold text-white active:opacity-80"
            >
              e-Class에서 보안 키 열기 ↗
            </a>
          </section>

          {/* ── 토큰 붙여넣기 ── */}
          <form onSubmit={connect} className="flex flex-col gap-2">
            <label className="text-xs font-bold text-[#0c4470]/50">복사한 보안 키 붙여넣기</label>
            <input
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="예: a1b2c3d4e5f6..."
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-xl bg-white px-3 py-3 font-mono text-sm text-[#0c4470] shadow-sm outline-none placeholder:font-sans placeholder:text-[#0c4470]/30 focus:ring-2 focus:ring-[#0095da]/40"
            />
            {error && <p className="rounded-xl bg-[#fdecec] px-3 py-2.5 text-xs font-medium text-[#d05b6a]">{error}</p>}
            <button
              type="submit"
              disabled={loading || !tokenInput.trim()}
              className="mt-1 w-full rounded-xl bg-[#0095da] py-3 text-sm font-bold text-white active:opacity-80 disabled:opacity-40"
            >
              {loading ? "확인하는 중…" : "연결하기"}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
