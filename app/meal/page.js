"use client"; // 데이터를 불러와 채우므로 브라우저에서 동작

import { useEffect, useState } from "react";
import SkeletonList from "../components/SkeletonList";

export default function MealPage() {
  const [lunch, setLunch] = useState([]); // 이번 주 중식
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/api/meal")
      .then((res) => res.json())
      .then((data) => {
        if (data.error) setError(true);
        else setLunch(data.lunch);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  // 오늘 날짜를 "07.18" 형태로 (학교 데이터와 같은 형식)
  const now = new Date();
  const todayLabel =
    String(now.getMonth() + 1).padStart(2, "0") +
    "." +
    String(now.getDate()).padStart(2, "0");

  return (
    <div className="px-4 py-4">
      <h2 className="mb-1 text-lg font-bold text-[#0c4470]">이번 주 급식</h2>
      <p className="mb-3 text-xs text-[#0c4470]/50">학생 식당 · 중식</p>

      {loading && <SkeletonList count={5} />}

      {error && (
        <p className="py-10 text-center text-[#0c4470]/50">
          급식을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {lunch.map((d, i) => {
          const isToday = d.date === todayLabel;
          const isClosed = d.menu.length === 0 || d.menu[0] === "휴무";
          return (
            <li
              key={i}
              className={`rounded-xl bg-white p-3 shadow-sm ${
                isToday ? "ring-2 ring-[#0095da]" : ""
              }`}
            >
              {/* 요일 + 날짜 */}
              <div className="mb-1.5 flex items-center gap-2">
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-sm font-bold ${
                    isToday
                      ? "bg-[#0095da] text-white"
                      : "bg-[#eaf6fd] text-[#0095da]"
                  }`}
                >
                  {d.day}
                </span>
                <span className="text-sm font-medium text-[#0c4470]">{d.date}</span>
                {isToday && (
                  <span className="rounded-full bg-[#ff97c5] px-2 py-0.5 text-[10px] font-bold text-white">
                    오늘
                  </span>
                )}
              </div>

              {/* 메뉴 */}
              {isClosed ? (
                <p className="text-sm text-[#0c4470]/40">휴무</p>
              ) : (
                <p className="text-sm leading-relaxed text-[#0c4470]/80">
                  {d.menu.join(" · ")}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
