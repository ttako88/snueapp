"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase/client";
import { useAuth } from "../../lib/identity/useAuth";
import {
  BUG_CATEGORIES, BUG_LIMITS, BUG_STATUS_LABEL,
  submitBugReport, listMyBugReports, withdrawBugReport, validateBugReport,
} from "../../lib/community/bugReports";

function fmt(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

export default function BugReportPage() {
  const { session, loading: authLoading } = useAuth();
  const [category, setCategory] = useState(null);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [mine, setMine] = useState([]);
  const [listLoading, setListLoading] = useState(true);

  function load() {
    setListLoading(true);
    listMyBugReports().then(({ data, error }) => {
      if (!error) setMine(data ?? []);
      setListLoading(false);
    });
  }

  useEffect(() => {
    if (!supabase || authLoading || !session) { setListLoading(false); return; }
    load();
  }, [session, authLoading]);

  async function send() {
    // 화면에서 먼저 거른다. 서버가 거부한 뒤 알 수 없는 오류를 띄우는 것보다
    // 무엇이 잘못됐는지 바로 알려주는 편이 낫다.
    const invalid = validateBugReport({ category, title, detail });
    if (invalid) { setNotice({ type: "error", text: invalid }); return; }
    setBusy(true);
    setNotice(null);
    const { error } = await submitBugReport({
      category, title, detail,
      // 어느 화면에서 제보했는지 자동 수집. 사용자가 적지 않는다.
      appPath: typeof window !== "undefined" ? window.location.pathname : null,
    });
    setBusy(false);
    if (error) {
      const m = error.message ?? "";
      setNotice({
        type: "error",
        text: /too many|rate/i.test(m)
          ? "잠시 뒤에 다시 보내주세요. 짧은 시간에 여러 번 보낼 수 없어요."
          : `보내지 못했어요 (${m})`,
      });
      return;
    }
    setTitle(""); setDetail(""); setCategory(null);
    setNotice({ type: "ok", text: "보냈어요. 확인하고 반영할게요." });
    load();
  }

  async function withdraw(id) {
    if (!confirm("이 제보를 철회할까요? 내용은 지워져요.")) return;
    const { error } = await withdrawBugReport(id);
    if (error) { setNotice({ type: "error", text: `철회하지 못했어요 (${error.message})` }); return; }
    setNotice({ type: "ok", text: "철회했어요." });
    load();
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center gap-2">
        <Link href="/settings" className="text-sm text-[#0c4470]/50">‹</Link>
        <h1 className="text-base font-bold text-[#0c4470]">버그 제보</h1>
      </div>

      {!authLoading && !session && (
        <div className="rounded-2xl border border-dashed border-[#0095da]/30 bg-white p-5 text-center">
          <p className="text-sm text-[#0c4470]/50">로그인하면 제보할 수 있어요.</p>
          <Link href="/login" className="mt-3 inline-block rounded-full bg-[#0095da] px-4 py-2 text-sm font-bold text-white">
            로그인하기
          </Link>
        </div>
      )}

      {session && (
        <>
          <section className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="text-xs font-bold text-[#0c4470]/40">어떤 문제인가요?</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {BUG_CATEGORIES.map((c) => (
                <button
                  key={c.code}
                  onClick={() => setCategory(c.code)}
                  className={`rounded-lg px-2.5 py-1.5 text-xs ${
                    category === c.code
                      ? "bg-[#0095da] font-bold text-white"
                      : "bg-[#f2f6fa] text-[#0c4470]/70"}`}
                >
                  {c.label}
                </button>
              ))}
            </div>

            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={BUG_LIMITS.titleMax}
              placeholder="한 줄로 요약해 주세요"
              className="mt-3 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
            />
            <textarea
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              rows={5}
              maxLength={BUG_LIMITS.detailMax}
              placeholder={`무슨 일이 있었는지 알려주세요. 어떤 화면에서 무엇을 눌렀는지 적어주시면 찾기 쉬워요. (${BUG_LIMITS.detailMin}자 이상)`}
              className="mt-2 w-full resize-none rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
            />
            <p className="mt-1 text-right text-[11px] text-[#0c4470]/35">
              {detail.trim().length}/{BUG_LIMITS.detailMax}
            </p>

            {notice && (
              <p className={`mt-2 text-xs ${
                notice.type === "ok" ? "text-[#1c7a4a]" : "text-[#c0392b]"}`}>
                {notice.text}
              </p>
            )}

            <button
              onClick={send}
              disabled={busy}
              className="mt-2 w-full rounded-xl bg-[#0095da] py-2.5 text-sm font-bold text-white disabled:opacity-40"
            >
              {busy ? "보내는 중…" : "보내기"}
            </button>
          </section>

          <section className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="mb-2 text-xs font-bold text-[#0c4470]/40">내 제보</p>
            {listLoading && <p className="py-3 text-center text-xs text-[#0c4470]/35">불러오는 중…</p>}
            {!listLoading && mine.length === 0 && (
              <p className="py-3 text-center text-xs text-[#0c4470]/35">아직 보낸 제보가 없어요.</p>
            )}
            <ul className="flex flex-col gap-2.5">
              {mine.map((r) => (
                <li key={r.id} className="border-b border-black/5 pb-2.5 last:border-0 last:pb-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-[#0c4470]">{r.title}</p>
                      <p className="mt-0.5 text-[11px] text-[#0c4470]/40">
                        {fmt(r.created_at)} · {BUG_STATUS_LABEL[r.status] ?? r.status}
                      </p>
                    </div>
                    {r.status === "open" && (
                      <button
                        onClick={() => withdraw(r.id)}
                        className="shrink-0 text-[11px] font-bold text-[#0c4470]/35"
                      >
                        철회
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
