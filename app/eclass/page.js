"use client"; // 달력 주소 입력·연결 상태를 브라우저에서 처리

import Link from "next/link";
import { useEffect, useState } from "react";
import { eventStyle } from "../lib/eventStyle";

const EXPORT_PAGE = "https://lms.snue.ac.kr/calendar/export.php";

function typeStyle(type) {
  const label = { 과제: "과제", 시험: "시험", 영상강의: "영상강의" }[type] || "일정";
  const key = ["과제", "시험", "영상강의"].includes(type) ? type : "학사일정";
  return { ...eventStyle(key), label };
}

export default function EclassPage() {
  const [urlInput, setUrlInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [events, setEvents] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const u = localStorage.getItem("eclassCalUrl");
    setConnected(Boolean(u));
    setLoaded(true);
    if (u) load(u);
  }, []);

  async function load(url, { isNew = false } = {}) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/eclass/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (data.events) {
        setEvents(data.events);
        if (isNew) {
          localStorage.setItem("eclassCalUrl", url); // 실제로 읽힌 주소만 저장
          setConnected(true);
          setUrlInput("");
        }
      } else {
        setError(data.error || "일정을 불러오지 못했어요.");
        if (!isNew && data.expired) {
          localStorage.removeItem("eclassCalUrl");
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
    const u = urlInput.trim();
    if (u) load(u, { isNew: true });
  }

  function disconnect() {
    localStorage.removeItem("eclassCalUrl");
    setConnected(false);
    setEvents(null);
    setError("");
  }

  if (!loaded) return null;

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="flex items-center gap-2">
        <Link href="/courses" className="text-[#0c4470]/50">‹ 강의</Link>
        <h2 className="text-lg font-bold text-[#0c4470]">e-Class 일정 연동</h2>
      </div>

      {/* ── 개인정보 안내 ── */}
      <section className="rounded-2xl border border-[#0095da]/20 bg-[#eaf6fd] p-4">
        <p className="mb-2 text-sm font-bold text-[#0c4470]">🔒 비밀번호는 받지 않아요</p>
        <ul className="flex flex-col gap-1.5 text-xs leading-relaxed text-[#0c4470]/75">
          <li>• 이 앱에는 <b>비밀번호를 입력하는 칸이 없어요.</b></li>
          <li>• 로그인은 <b>학교 e-Class 사이트에서만</b> 하시게 돼요.</li>
          <li>• 학교가 만들어준 <b>&lsquo;달력 주소&rsquo;</b>로 일정을 <b>읽기만</b> 해요.</li>
          <li>• 그 주소는 <b>여러분 기기에만</b> 저장돼요. 우리 서버엔 안 올라가요.</li>
          <li>• 언제든 <b>연결 해제</b> 가능해요.</li>
        </ul>
        <p className="mt-2.5 border-t border-[#0095da]/15 pt-2 text-[11px] leading-relaxed text-[#0c4470]/55">
          학교 e-Class(무들)가 학생에게 공식 제공하는 <b>달력 구독(iCal)</b> 기능을 그대로 써요.
          구글 캘린더에 연결하는 것과 똑같은 방식이에요. 코드 →{" "}
          <a
            href="https://github.com/ttako88/snueapp/blob/main/app/api/eclass/calendar/route.js"
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
              <p className="font-bold text-[#0c4470]">e-Class 일정이 연결됐어요!</p>
              <p className="text-xs text-[#0c4470]/50">달력 주소는 이 기기에만 저장돼 있어요</p>
            </div>
            <button
              onClick={disconnect}
              className="shrink-0 rounded-full bg-[#fdecec] px-3 py-1.5 text-xs font-bold text-[#d05b6a] active:opacity-80"
            >
              연결 해제
            </button>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-bold text-[#0c4470]">📌 내 e-Class 일정</h3>
              <button
                onClick={() => load(localStorage.getItem("eclassCalUrl"))}
                className="rounded-full bg-black/5 px-2.5 py-1 text-[11px] font-bold text-[#0c4470]/60"
              >
                새로고침
              </button>
            </div>

            {loading && <p className="py-6 text-center text-sm text-[#0c4470]/40">불러오는 중…</p>}
            {error && <p className="rounded-xl bg-[#fdecec] px-3 py-2.5 text-xs text-[#d05b6a]">{error}</p>}
            {!loading && !error && events?.length === 0 && (
              <p className="py-6 text-center text-sm text-[#0c4470]/40">
                일정이 없어요. (방학이면 비어 있는 게 정상이에요!)
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
          {/* ── 달력 주소 가져오는 방법 ── */}
          <section className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="mb-3 text-sm font-bold text-[#0c4470]">🔗 달력 주소 가져오는 방법</p>
            <ol className="flex flex-col gap-2.5 text-xs leading-relaxed text-[#0c4470]/75">
              <li>
                <b className="text-[#0095da]">1.</b> 아래 버튼으로 <b>e-Class 일정 내보내기</b> 페이지 열기
                <br />
                <span className="text-[#0c4470]/50">(로그인 안 돼 있으면 로그인 후 다시 눌러주세요)</span>
              </li>
              <li>
                <b className="text-[#0095da]">2.</b> <b>&ldquo;모든 이벤트&rdquo;</b> 선택 +{" "}
                <b>&ldquo;현재와 추후 2달&rdquo;</b> 선택
              </li>
              <li>
                <b className="text-[#0095da]">3.</b> 아래쪽 <b>&ldquo;일정 URL 불러오기&rdquo;</b> 버튼 클릭
                <br />
                <span className="text-[#0c4470]/50">(&ldquo;내보내기&rdquo; 말고 &ldquo;일정 URL 불러오기&rdquo;예요!)</span>
              </li>
              <li>
                <b className="text-[#0095da]">4.</b> 나온 <b>주소를 복사</b>해서 아래 칸에 붙여넣기
              </li>
            </ol>
            <a
              href={EXPORT_PAGE}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 block rounded-xl bg-[#0095da] py-2.5 text-center text-sm font-bold text-white active:opacity-80"
            >
              e-Class 일정 내보내기 열기 ↗
            </a>
          </section>

          <form onSubmit={connect} className="flex flex-col gap-2">
            <label className="text-xs font-bold text-[#0c4470]/50">복사한 달력 주소 붙여넣기</label>
            <textarea
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              rows={3}
              placeholder="https://lms.snue.ac.kr/calendar/export_execute.php?..."
              spellCheck={false}
              className="w-full resize-none rounded-xl bg-white px-3 py-3 font-mono text-xs text-[#0c4470] shadow-sm outline-none placeholder:font-sans placeholder:text-[#0c4470]/30 focus:ring-2 focus:ring-[#0095da]/40"
            />
            {error && <p className="rounded-xl bg-[#fdecec] px-3 py-2.5 text-xs font-medium text-[#d05b6a]">{error}</p>}
            <button
              type="submit"
              disabled={loading || !urlInput.trim()}
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
