"use client"; // 데이터를 불러와 채우므로 브라우저에서 동작

import Link from "next/link";
import { useEffect, useState } from "react";
import SkeletonList from "../components/SkeletonList";

export default function NoticesPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

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

  return (
    <div className="px-4 py-4">
      <h2 className="mb-3 text-lg font-bold text-[#0c4470]">학사공지</h2>

      {loading && <SkeletonList count={6} />}

      {error && (
        <p className="py-10 text-center text-[#0c4470]/50">
          공지를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {items.map((n) => (
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
                <span className="rounded bg-[#eaf6fd] px-1.5 py-0.5 text-[10px] font-medium text-[#0095da]">
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
        ))}
      </ul>
    </div>
  );
}
