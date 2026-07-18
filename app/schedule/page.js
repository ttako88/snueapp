"use client"; // 데이터를 불러와 화면에 채우므로 브라우저에서 동작

import { useEffect, useState } from "react";
import SkeletonList from "../components/SkeletonList";

export default function SchedulePage() {
  const [events, setEvents] = useState([]); // 일정 목록
  const [loading, setLoading] = useState(true); // 불러오는 중?
  const [error, setError] = useState(false);

  // 화면이 처음 뜰 때 우리 중계소(/api/schedule)에 요청
  useEffect(() => {
    fetch("/api/schedule")
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setError(true);
        } else {
          setEvents(data);
        }
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  // 오늘 날짜를 "2026/07/18" 형태 문자열로 (학교 데이터와 같은 형식)
  const today = new Date().toLocaleDateString("sv-SE").replaceAll("-", "/");

  // 아직 안 끝난(다가오는) 일정만 골라 시작일 순으로 정렬
  const upcoming = events
    .filter((e) => e.end >= today)
    .sort((a, b) => a.start.localeCompare(b.start));

  return (
    <div className="px-4 py-4">
      <h2 className="mb-3 text-lg font-bold text-[#0c4470]">다가오는 학사일정</h2>

      {loading && <SkeletonList />}

      {error && (
        <p className="py-10 text-center text-[#0c4470]/50">
          학사일정을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.
        </p>
      )}

      {!loading && !error && upcoming.length === 0 && (
        <p className="py-10 text-center text-[#0c4470]/50">다가오는 일정이 없어요.</p>
      )}

      <ul className="flex flex-col gap-2">
        {upcoming.map((e, i) => {
          const isRange = e.start !== e.end; // 하루 일정인지, 기간 일정인지
          return (
            <li
              key={i}
              className="flex items-center gap-3 rounded-xl bg-white p-3 shadow-sm"
            >
              {/* 왼쪽: 날짜 박스 */}
              <div className="flex w-14 shrink-0 flex-col items-center rounded-lg bg-[#eaf6fd] py-1.5">
                <span className="text-base font-bold text-[#0095da]">
                  {e.startLabel}
                </span>
                <span className="text-[10px] text-[#0095da]/70">{e.startWeek}</span>
              </div>

              {/* 오른쪽: 제목 + 기간 */}
              <div className="min-w-0">
                <p className="truncate font-medium text-[#0c4470]">
                  {e.detail || e.title}
                </p>
                {isRange && (
                  <p className="text-xs text-[#0c4470]/50">
                    {e.startLabel} ~ {e.endLabel}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
