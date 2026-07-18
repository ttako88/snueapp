"use client"; // 데이터를 불러와 채우므로 브라우저에서 동작

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

export default function NoticeDetailPage() {
  const { nttSn } = useParams(); // 주소에서 글 번호 꺼내기
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch(`/api/notices/${nttSn}`)
      .then((res) => res.json())
      .then((d) => {
        if (d.error) setError(true);
        else setData(d);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [nttSn]);

  return (
    <div className="px-4 py-4">
      {/* 뒤로가기 */}
      <Link href="/notices" className="mb-3 inline-block text-sm text-[#0095da]">
        ← 목록으로
      </Link>

      {loading && <p className="py-10 text-center text-[#0c4470]/50">불러오는 중… 🦌</p>}

      {error && (
        <p className="py-10 text-center text-[#0c4470]/50">
          공지 내용을 불러오지 못했어요.
        </p>
      )}

      {data && (
        <article className="rounded-xl bg-white p-4 shadow-sm">
          {/* 구분 + 작성자 · 날짜 */}
          <div className="mb-3 border-b border-black/5 pb-3">
            <span className="rounded bg-[#eaf6fd] px-1.5 py-0.5 text-[10px] font-medium text-[#0095da]">
              {data.category}
            </span>
            <p className="mt-1.5 text-xs text-[#0c4470]/50">
              {data.writer} · {data.date}
            </p>
          </div>

          {/* 본문 (줄바꿈 그대로 유지) */}
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-[#0c4470]/90">
            {data.body}
          </p>

          {/* 첨부파일 */}
          {data.files.length > 0 && (
            <div className="mt-4 border-t border-black/5 pt-3">
              <p className="mb-2 text-xs font-bold text-[#0c4470]/60">첨부파일</p>
              <ul className="flex flex-col gap-1.5">
                {data.files.map((f, i) => (
                  <li key={i}>
                    <a
                      href={f.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 text-sm text-[#0095da] underline"
                    >
                      📎 {f.name}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </article>
      )}
    </div>
  );
}
