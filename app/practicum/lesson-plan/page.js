"use client";

// 수업지도안(약안·세안) 생성.
//
// 실습생이 밤새 앉아서 쓰는 게 지도안이다. 조건을 고르면 초안이 나오고,
// 사용자는 그걸 고쳐서 쓴다. **AI 가 쓴 걸 그대로 내는 도구가 아니다** —
// 화면 곳곳에 그걸 명시한다.

import Link from "next/link";
import { useState } from "react";
import { supabase } from "../../lib/supabase/client";
import { useAuth } from "../../lib/identity/useAuth";
import {
  GRADES, subjectsForGrade, TEACHING_MODELS, PLAN_TYPES, DURATIONS,
  validatePlanInput,
} from "../../lib/lessonPlan";

const MESSAGES = {
  ai_not_configured: "지도안 생성 기능이 아직 준비 중이에요.",
  daily_total_exceeded: "오늘 생성 한도를 다 썼어요. 내일 다시 시도해 주세요.",
  daily_user_exceeded: "오늘 내가 쓸 수 있는 만큼 다 썼어요. 내일 다시 만나요.",
  single_call_too_expensive: "요청이 너무 커요. 단원·주제를 짧게 적어주세요.",
  generation_failed: "만들지 못했어요. 잠시 뒤 다시 시도해 주세요.",
  empty_result: "결과가 비어서 왔어요. 다시 시도해 주세요.",
  unauthorized: "로그인이 풀렸어요. 다시 로그인해 주세요.",
};

export default function LessonPlanPage() {
  const { session, loading: authLoading } = useAuth();
  const [planType, setPlanType] = useState("brief");
  const [grade, setGrade] = useState(3);
  const [subject, setSubject] = useState("국어");
  const [unit, setUnit] = useState("");
  const [goal, setGoal] = useState("");
  const [model, setModel] = useState("direct");
  const [duration, setDuration] = useState(40);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [result, setResult] = useState(null);

  const subjects = subjectsForGrade(grade);

  function changeGrade(g) {
    setGrade(g);
    // 1~2학년은 통합교과라 고를 수 있는 교과가 다르다. 남아 있으면 서버가 거부한다.
    if (!subjectsForGrade(g).includes(subject)) setSubject(subjectsForGrade(g)[0]);
  }

  async function submit() {
    const input = { planType, grade, subject, unit, goal, model, duration };
    const invalid = validatePlanInput(input);
    if (invalid) { setNotice({ type: "error", text: invalid }); return; }

    setBusy(true); setNotice(null); setResult(null);
    try {
      const { data: { session: s } } = await supabase.auth.getSession();
      if (!s?.access_token) { setNotice({ type: "error", text: MESSAGES.unauthorized }); return; }

      const res = await fetch("/api/lesson-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.access_token}` },
        body: JSON.stringify(input),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setNotice({ type: "error", text: MESSAGES[data?.error] ?? data?.message ?? "만들지 못했어요." });
        return;
      }
      setResult(data);
    } catch {
      setNotice({ type: "error", text: "네트워크 오류예요." });
    } finally {
      setBusy(false);
    }
  }

  function copyResult() {
    if (!result?.text) return;
    navigator.clipboard?.writeText(result.text)
      .then(() => setNotice({ type: "ok", text: "복사했어요." }))
      .catch(() => setNotice({ type: "error", text: "복사하지 못했어요." }));
  }

  const chip = (on) => `rounded-lg px-2.5 py-1.5 text-xs ${
    on ? "bg-[#0095da] font-bold text-white" : "bg-[#f2f6fa] text-[#0c4470]/70"}`;

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center gap-2">
        <Link href="/practicum" className="text-sm text-[#0c4470]/50">‹</Link>
        <h1 className="text-base font-bold text-[#0c4470]">지도안 만들기</h1>
      </div>

      {!authLoading && !session && (
        <div className="rounded-2xl border border-dashed border-[#0095da]/30 bg-white p-5 text-center">
          <p className="text-sm text-[#0c4470]/50">로그인하면 쓸 수 있어요.</p>
          <Link href="/login"
            className="mt-3 inline-block rounded-full bg-[#0095da] px-4 py-2 text-sm font-bold text-white">
            로그인하기
          </Link>
        </div>
      )}

      {session && (
        <>
          <section className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="text-xs font-bold text-[#0c4470]/40">무엇을 만들까요</p>
            <div className="mt-2 flex gap-1.5">
              {PLAN_TYPES.map((t) => (
                <button key={t.key} onClick={() => setPlanType(t.key)} className={chip(planType === t.key)}>
                  {t.label} <span className="opacity-60">{t.pages}</span>
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-[#0c4470]/45">
              {PLAN_TYPES.find((t) => t.key === planType)?.desc}
            </p>

            <p className="mt-3 text-xs font-bold text-[#0c4470]/40">학년</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {GRADES.map((g) => (
                <button key={g} onClick={() => changeGrade(g)} className={chip(grade === g)}>{g}학년</button>
              ))}
            </div>

            <p className="mt-3 text-xs font-bold text-[#0c4470]/40">교과</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {subjects.map((s) => (
                <button key={s} onClick={() => setSubject(s)} className={chip(subject === s)}>{s}</button>
              ))}
            </div>

            <input
              value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={60}
              placeholder="단원·주제 (예: 4단원 글쓴이의 주장)"
              className="mt-3 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
            />
            <input
              value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={200}
              placeholder="학습목표 (안 적으면 알아서 잡아줘요)"
              className="mt-2 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
            />

            <p className="mt-3 text-xs font-bold text-[#0c4470]/40">수업모형</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {TEACHING_MODELS.map((m) => (
                <button key={m.key} onClick={() => setModel(m.key)} className={chip(model === m.key)}>
                  {m.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-[#0c4470]/45">
              {TEACHING_MODELS.find((m) => m.key === model)?.steps}
            </p>

            <p className="mt-3 text-xs font-bold text-[#0c4470]/40">수업 시간</p>
            <div className="mt-2 flex gap-1.5">
              {DURATIONS.map((d) => (
                <button key={d} onClick={() => setDuration(d)} className={chip(duration === d)}>
                  {d}분{d === 80 ? " (블록)" : ""}
                </button>
              ))}
            </div>

            {notice && (
              <p className={`mt-3 text-xs ${notice.type === "ok" ? "text-[#1c7a4a]" : "text-[#c0392b]"}`}>
                {notice.text}
              </p>
            )}

            <button onClick={submit} disabled={busy}
              className="mt-3 w-full rounded-xl bg-[#0095da] py-2.5 text-sm font-bold text-white disabled:opacity-40">
              {busy ? "만드는 중… (20초쯤 걸려요)" : "지도안 만들기"}
            </button>
          </section>

          {result && (
            <section className="rounded-2xl bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold text-[#0c4470]/40">
                  {PLAN_TYPES.find((t) => t.key === result.planType)?.label} 초안
                </p>
                <button onClick={copyResult} className="text-xs font-bold text-[#0095da]">복사</button>
              </div>
              <div className="mt-2 rounded-xl bg-[#fff8e5] px-3 py-2">
                <p className="text-[11px] leading-relaxed text-[#8a6d00]">
                  ⚠️ {result.notice} 성취기준 코드와 차시 배당은 교과서·교육과정을 직접
                  확인해 주세요. 그대로 제출하면 실습 평가에 불리할 수 있어요.
                </p>
              </div>
              <pre className="mt-2 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[#0c4470]">
                {result.text}
              </pre>
            </section>
          )}
        </>
      )}
    </div>
  );
}
