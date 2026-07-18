"use client"; // 데이터를 불러와 채우므로 브라우저에서 동작

import Link from "next/link";
import { useEffect, useState } from "react";
import SkeletonList from "../components/SkeletonList";
import { categoryStyle, FILTER_ORDER } from "../lib/noticeStyle";

export default function NoticesPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState("전체"); // 지금 고른 필터

  useEffect(() => {
    fetch("/api/notices")
      .then((res) => res.json())
      .then((data) => {
        if (data.error) setError(true);
        else setItems(data);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  // 실제 목록에 존재하는 카테고리만 버튼으로 (정해둔 순서대로). 맨 앞엔 '전체'.
  const present = new Set(items.map((n) => n.category));
  const chips = ["전체", ...FILTER_ORDER.filter((c) => present.has(c))];

  // 고른 필터에 맞는 공지만 추림
  const shown =
    filter === "전체" ? items : items.filter((n) => n.category === filter);

  return (
    <div className="px-4 py-4">
      <h2 className="mb-3 text-lg font-bold text-[#0c4470]">학사공지</h2>

      {/* 성격별 필터 버튼 (가로로 넘치면 스크롤) */}
      {!loading && !error && (
        <div className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1">
          {chips.map((c) => {
            const active = filter === c;
            return (
              <button
                key={c}
                onClick={() => setFilter(c)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold transition ${
                  active
                    ? "bg-[#0095da] text-white"
                    : "bg-white text-[#0c4470]/55 ring-1 ring-black/5"
                }`}
              >
                {c}
              </button>
            );
          })}
        </div>
      )}

      {loading && <SkeletonList count={6} />}

      {error && (
        <p className="py-10 text-center text-[#0c4470]/50">
          공지를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.
        </p>
      )}

      {!loading && !error && shown.length === 0 && (
        <p className="py-10 text-center text-[#0c4470]/50">
          해당하는 공지가 없어요.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {shown.map((n) => {
          const s = categoryStyle(n.category); // 이 공지 구분의 색
          return (
            <li key={n.nttSn}>
              <Link
                href={`/notices/${n.nttSn}`}
                className="block rounded-xl bg-white p-3 shadow-sm active:bg-[#eaf6fd]"
              >
                {/* 구분 배지 + 고정공지 표시 */}
                <div className="mb-1 flex items-center gap-1.5">
                  {n.isNotice && (
                    <span className="rounded bg-[#ff97c5] px-1.5 py-0.5 text-[10px] font-bold text-white">
                      공지
                    </span>
                  )}
                  <span
                    className="rounded px-1.5 py-0.5 text-[10px] font-bold"
                    style={{ backgroundColor: s.bg, color: s.text }}
                  >
                    {n.category}
                  </span>
                </div>

                {/* 제목 */}
                <p className="line-clamp-2 font-medium text-[#0c4470]">{n.title}</p>

                {/* 작성자 · 날짜 */}
                <p className="mt-1 text-xs text-[#0c4470]/50">
                  {n.writer} · {n.date}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
