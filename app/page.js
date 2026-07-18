"use client"; // 세 가지 데이터를 불러와 요약하므로 브라우저에서 동작

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { categoryStyle } from "./lib/noticeStyle";
import Timetable from "./components/Timetable";

export default function Home() {
  const [todayMeal, setTodayMeal] = useState(null); // 오늘 급식
  const [upcoming, setUpcoming] = useState([]); // 다가오는 일정 3개
  const [notices, setNotices] = useState([]); // 최신 공지 3개

  // 오늘 날짜 "07.18" 형태
  const now = new Date();
  const todayLabel =
    String(now.getMonth() + 1).padStart(2, "0") +
    "." +
    String(now.getDate()).padStart(2, "0");

  useEffect(() => {
    // 오늘 급식
    fetch("/api/meal")
      .then((r) => r.json())
      .then((d) => {
        if (!d.error) {
          const m = d.lunch.find((x) => x.date === todayLabel);
          setTodayMeal(m || null);
        }
      })
      .catch(() => {});

    // 다가오는 일정
    const todaySlash = now.toLocaleDateString("sv-SE").replaceAll("-", "/");
    fetch("/api/schedule")
      .then((r) => r.json())
      .then((d) => {
        if (!d.error) {
          const up = d
            .filter((e) => e.end >= todaySlash)
            .sort((a, b) => a.start.localeCompare(b.start))
            .slice(0, 3);
          setUpcoming(up);
        }
      })
      .catch(() => {});

    // 최신 공지
    fetch("/api/notices")
      .then((r) => r.json())
      .then((d) => {
        if (!d.error) setNotices(d.slice(0, 3));
      })
      .catch(() => {});
  }, [todayLabel]);

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      {/* 인사 */}
      <div className="flex items-center gap-3">
        <Image src="/saerok.png" alt="새록이" width={56} height={56} priority />
        <div>
          <p className="text-lg font-bold text-[#0c4470]">
            오늘도 화이팅이에요! 🦌
          </p>
          <p className="text-xs text-[#0c4470]/50">
            {now.getMonth() + 1}월 {now.getDate()}일
          </p>
        </div>
      </div>

      {/* 내 시간표 (읽기 전용, 편집은 강의 탭에서) */}
      <Timetable editable={false} />

      {/* 오늘의 급식 */}
      <section className="rounded-2xl bg-[#0095da] p-4 text-white shadow-sm">
        <div className="mb-1 flex items-center justify-between">
          <p className="text-sm font-bold">🍚 오늘의 급식</p>
          <Link href="/meal" className="text-xs text-white/80">
            이번 주 →
          </Link>
        </div>
        {todayMeal && todayMeal.menu[0] !== "휴무" ? (
          <p className="text-sm leading-relaxed opacity-95">
            {todayMeal.menu.join(" · ")}
          </p>
        ) : (
          <p className="text-sm opacity-80">오늘은 급식 정보가 없어요 (주말·휴무)</p>
        )}
      </section>

      {/* 다가오는 일정 */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-bold text-[#0c4470]">📅 다가오는 일정</h2>
          <Link href="/calendar" className="text-xs text-[#0095da]">
            더보기 →
          </Link>
        </div>
        <ul className="flex flex-col gap-1.5">
          {upcoming.map((e, i) => (
            <li
              key={i}
              className="flex items-center gap-2 rounded-xl bg-white p-2.5 shadow-sm"
            >
              <span className="w-12 shrink-0 text-center text-sm font-bold text-[#0095da]">
                {e.startLabel}
              </span>
              <span className="truncate text-sm text-[#0c4470]">
                {e.detail || e.title}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* 최신 공지 */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-bold text-[#0c4470]">📢 최신 공지</h2>
          <Link href="/notices" className="text-xs text-[#0095da]">
            더보기 →
          </Link>
        </div>
        <ul className="flex flex-col gap-1.5">
          {notices.map((n) => {
            const s = categoryStyle(n.category); // 이 공지 구분의 색
            return (
              <li key={n.nttSn}>
                <Link
                  href={`/notices/${n.nttSn}`}
                  className="flex items-center gap-2 rounded-xl bg-white p-2.5 shadow-sm active:bg-[#eaf6fd]"
                >
                  <span
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold"
                    style={{ backgroundColor: s.bg, color: s.text }}
                  >
                    {n.category}
                  </span>
                  <span className="truncate text-sm text-[#0c4470]">{n.title}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
