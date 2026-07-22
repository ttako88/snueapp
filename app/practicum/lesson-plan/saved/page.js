"use client"; // 저장한 지도안을 Supabase에서 불러와 보여줌

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "../../../lib/identity/useAuth";
import { supabase } from "../../../lib/supabase/client";
import LessonPlanView from "../../../components/LessonPlanView";
import { downloadLessonPlan, printLessonPlan } from "../../../lib/lessonExport";
import { listMyLessonPlans, getMyLessonPlan, deleteMyLessonPlan } from "../../../lib/community/lessonPlanSaves";

const TYPE_LABEL = { brief: "약안", full: "세안" };

export default function SavedLessonPlansPage() {
  const { session, loading } = useAuth();
  const [rows, setRows] = useState([]);
  const [state, setState] = useState("idle"); // idle|loading|ok|empty|error
  const [open, setOpen] = useState(null); // 펼친 지도안 {id, title, plan_type, body}
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (loading) return;
      if (!session || !supabase) { if (alive) setState("idle"); return; }
      setState("loading");
      const { data, error } = await listMyLessonPlans();
      if (!alive) return;
      if (error) setState("error");
      else { setRows(data || []); setState((data || []).length ? "ok" : "empty"); }
    })();
    return () => { alive = false; };
  }, [session, loading, tick]);

  const load = async (id) => {
    const { data } = await getMyLessonPlan(id);
    if (data) setOpen(data);
  };
  const remove = async (id) => {
    await deleteMyLessonPlan(id);
    if (open?.id === id) setOpen(null);
    setTick((t) => t + 1);
  };

  return (
    <Shell>
      {loading && <Muted>확인 중이에요…</Muted>}
      {!loading && !session && (
        <div className="rounded-2xl border border-dashed border-[#0095da]/30 bg-white p-5 text-center">
          <p className="text-sm text-[#0c4470]/50">로그인하면 저장한 지도안을 볼 수 있어요.</p>
          <Link href="/login" className="mt-3 inline-block rounded-full bg-[#0095da] px-4 py-2 text-sm font-bold text-white">로그인하기</Link>
        </div>
      )}
      {session && state === "loading" && <Muted>불러오는 중…</Muted>}
      {session && state === "error" && <p className="py-8 text-center text-sm text-[#0c4470]/50">불러오지 못했어요.</p>}
      {session && state === "empty" && (
        <p className="py-10 text-center text-sm text-[#0c4470]/40">저장한 지도안이 없어요.<br />지도안을 만든 뒤 <b>저장</b>하면 여기 모여요.</p>
      )}
      {session && state === "ok" && (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.id} className="rounded-xl bg-white p-3 shadow-sm">
              <div className="flex items-center gap-2">
                <button onClick={() => (open?.id === r.id ? setOpen(null) : load(r.id))} className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm font-bold text-[#0c4470]">
                    <span className="mr-1.5 rounded bg-[#eaf6ff] px-1.5 py-0.5 text-[10px] text-[#0095da]">{TYPE_LABEL[r.plan_type]}</span>
                    {r.title}
                  </span>
                  <span className="block text-[11px] text-[#0c4470]/45">{new Date(r.created_at).toLocaleString("ko-KR")}</span>
                </button>
                <button onClick={() => remove(r.id)} className="shrink-0 rounded-lg bg-[#f2f6fa] px-2.5 py-1 text-[11px] font-bold text-[#c0392b]">삭제</button>
              </div>

              {open?.id === r.id && (
                <div className="mt-2 border-t border-black/5 pt-2">
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    <button onClick={() => printLessonPlan(open.body, `${TYPE_LABEL[open.plan_type]} · ${open.title}`)}
                      className="rounded-lg bg-[#f2f6fa] px-3 py-1.5 text-xs font-bold text-[#0c4470]/70">🖨️ PDF·인쇄</button>
                    <button onClick={() => downloadLessonPlan(open.body, `수업지도안_${TYPE_LABEL[open.plan_type]}.doc`)}
                      className="rounded-lg bg-[#f2f6fa] px-3 py-1.5 text-xs font-bold text-[#0c4470]/70">📄 한글·워드(.doc)</button>
                  </div>
                  <div className="max-h-[60vh] overflow-auto rounded-xl border border-black/5 bg-white p-3">
                    <LessonPlanView text={open.body} />
                  </div>
                </div>
              )}
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
        <Link href="/practicum/lesson-plan" className="text-[#0c4470]/50">‹</Link>
        <h2 className="text-lg font-bold text-[#0c4470]">내 지도안</h2>
      </div>
      {children}
    </div>
  );
}
function Muted({ children }) {
  return <p className="text-sm text-[#0c4470]/50">{children}</p>;
}
