"use client"; // 알림함 — 받은 운영 메시지

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "../../lib/identity/useAuth";
import { supabase } from "../../lib/supabase/client";
import { listMyMessages, markMessageRead } from "../../lib/community/messages";

const KIND_LABEL = {
  verification_approved: "인증 승인", verification_rejected: "인증 반려",
  deletion_notice: "삭제 안내", warning: "경고", sanction_notice: "이용 제한",
  report_result: "신고 처리", system: "안내",
};

export default function MessagesPage() {
  const { session, loading } = useAuth();
  const [rows, setRows] = useState([]);
  const [state, setState] = useState("idle");
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (loading) return;
      if (!session || !supabase) { if (alive) setState("idle"); return; }
      setState("loading");
      const { data, error } = await listMyMessages(50);
      if (!alive) return;
      if (error) setState("error");
      else { setRows(data || []); setState((data || []).length ? "ok" : "empty"); }
    })();
    return () => { alive = false; };
  }, [session, loading]);

  const openMsg = async (m) => {
    setOpenId(openId === m.id ? null : m.id);
    if (!m.read_at && openId !== m.id) {
      await markMessageRead(m.id);
      setRows((prev) => prev.map((x) => (x.id === m.id ? { ...x, read_at: new Date().toISOString() } : x)));
    }
  };

  return (
    <Shell>
      {loading && <Muted>확인 중이에요…</Muted>}
      {!loading && !session && (
        <div className="rounded-2xl border border-dashed border-[#0095da]/30 bg-white p-5 text-center">
          <p className="text-sm text-[#0c4470]/50">로그인하면 받은 알림을 볼 수 있어요.</p>
          <Link href="/login" className="mt-3 inline-block rounded-full bg-[#0095da] px-4 py-2 text-sm font-bold text-white">로그인하기</Link>
        </div>
      )}
      {session && state === "loading" && <Muted>불러오는 중…</Muted>}
      {session && state === "error" && <p className="py-8 text-center text-sm text-[#0c4470]/50">불러오지 못했어요.</p>}
      {session && state === "empty" && <p className="py-10 text-center text-sm text-[#0c4470]/40">받은 알림이 없어요.</p>}
      {session && state === "ok" && (
        <ul className="flex flex-col gap-2">
          {rows.map((m) => (
            <li key={m.id}>
              <button onClick={() => openMsg(m)} className="block w-full rounded-xl bg-white p-3 text-left shadow-sm active:bg-[#eaf6fd]">
                <div className="flex items-center gap-2">
                  {!m.read_at && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#0095da]" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-[#0c4470]">
                      <span className="mr-1.5 rounded bg-[#f2f6fa] px-1.5 py-0.5 text-[10px] text-[#0c4470]/50">{KIND_LABEL[m.kind] ?? m.kind}</span>
                      {m.title}
                    </span>
                    <span className="block text-[11px] text-[#0c4470]/45">{new Date(m.created_at).toLocaleString("ko-KR")}</span>
                  </span>
                </div>
                {openId === m.id && (
                  <p className="mt-2 whitespace-pre-wrap border-t border-black/5 pt-2 text-sm leading-relaxed text-[#0c4470]/80">{m.body}</p>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center gap-2">
        <Link href="/settings" className="text-[#0c4470]/50">‹</Link>
        <h2 className="text-lg font-bold text-[#0c4470]">알림함</h2>
      </div>
      {children}
    </div>
  );
}
function Muted({ children }) {
  return <p className="text-sm text-[#0c4470]/50">{children}</p>;
}
