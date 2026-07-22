"use client";

// 수업지도안(약안·세안) 생성.
//
// 실습생이 밤새 앉아서 쓰는 게 지도안이다. 조건을 고르면 초안이 나오고,
// 사용자는 그걸 고쳐서 쓴다. **AI 가 쓴 걸 그대로 내는 도구가 아니다** —
// 화면 곳곳에 그걸 명시한다.

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase/client";
import { useAuth } from "../../lib/identity/useAuth";
import { isEnabled } from "../../lib/features.js";
import LessonPlanView from "../../components/LessonPlanView";
import LessonPlanIntro from "../../components/LessonPlanIntro";
import { downloadLessonPlan, printLessonPlan } from "../../lib/lessonExport";
import { myLessonPlanAccess, saveLessonPlan } from "../../lib/community/lessonPlanSaves";
import {
  GRADES, subjectsForGrade, TEACHING_MODELS, PLAN_TYPES, DURATIONS,
  validatePlanInput, withDefaults, defaultModelFor, OPTIONAL_LIMITS,
} from "../../lib/lessonPlan";

const MESSAGES = {
  ai_not_configured: "지도안 생성 기능이 아직 준비 중이에요.",
  not_available_yet: "지도안 생성은 아직 운영자에게만 열려 있어요. 곧 열어드릴게요.",
  daily_total_exceeded: "오늘 생성 한도를 다 썼어요. 내일 다시 시도해 주세요.",
  daily_user_exceeded: "오늘 내가 쓸 수 있는 만큼 다 썼어요. 내일 다시 만나요.",
  single_call_too_expensive: "요청이 너무 커요. 단원·주제를 짧게 적어주세요.",
  generation_failed: "만들지 못했어요. 잠시 뒤 다시 시도해 주세요.",
  empty_result: "결과가 비어서 왔어요. 다시 시도해 주세요.",
  unauthorized: "로그인이 풀렸어요. 다시 로그인해 주세요.",
  insufficient_sr: "SR이 모자라요. 강의평을 쓰거나 광고를 보면 채울 수 있어요.",
  credit_unavailable: "잔액을 확인하지 못했어요. 잠시 뒤 다시 시도해 주세요.",
  unknown_purpose: "이 기능의 요금이 아직 정해지지 않았어요.",
  no_member: "회원 정보를 찾지 못했어요. 다시 로그인해 주세요.",
};

export default function LessonPlanPage() {
  const { session, profile, loading: authLoading } = useAuth();
  // 생성 가능 여부: 공개 flag 가 켜졌거나(모두) owner 본인. 서버가 최종 판정한다.
  const canUse = isEnabled("lessonPlanPublic") || profile?.role === "owner";
  const [planType, setPlanType] = useState("brief");
  const [grade, setGrade] = useState(3);
  const [subject, setSubject] = useState("국어");
  const [unit, setUnit] = useState("");
  const [textbookId, setTextbookId] = useState("");
  const [duration, setDuration] = useState(40);
  // 2단계(선택). 비워 두면 프롬프트에 줄 자체가 안 들어간다.
  // model 은 빈 값이면 교과·학년으로 자동 추천된다 — 고르라고 강요하면
  // 처음 쓰는 교생이 거기서 멈춘다.
  const [model, setModel] = useState("");
  const [opt, setOpt] = useState({
    goal: "", learners: "", focus: "", materials: "", evaluation: "", request: "",
  });
  const [showMore, setShowMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  // 약안·세안을 각각 보전한다 — 세안을 뽑아도 돈 주고 만든 약안이 날아가지 않게.
  const [results, setResults] = useState({}); // { brief: data, full: data }
  const [view, setView] = useState(null);     // 현재 보는 종류 ('brief'|'full')
  const result = view ? results[view] : null; // 파생: 지금 화면에 표시할 결과
  const [access, setAccess] = useState(null); // 내 이용권 상태 {allowed,source,remaining}
  const [saveMsg, setSaveMsg] = useState(null); // 저장 결과 안내
  // 실제 교과서 단원 목록. 있으면 자유 입력 대신 골라서 근거가 100% 매칭된다.
  // 없으면(데이터 미비·네트워크 실패) 자유 입력으로 떨어진다 — 둘 다 동작.
  const [unitList, setUnitList] = useState([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      // 학년·교과가 바뀌면 이전 단원은 무의미하다("5학년 국어" 단원을 "3학년
      // 수학" 에 들고 가면 근거가 안 맞는다). 항상 비우고 새로 고르게 한다.
      setUnitList([]);
      setUnit("");
      setTextbookId("");
      try {
        const r = await fetch(`/api/lesson-plan/units?grade=${grade}&subject=${encodeURIComponent(subject)}`);
        const d = r.ok ? await r.json() : null;
        if (alive && Array.isArray(d?.units)) setUnitList(d.units);
      } catch { /* 자유 입력으로 떨어진다 */ }
    })();
    return () => { alive = false; };
  }, [grade, subject]);

  const subjects = subjectsForGrade(grade);
  const effectiveModel = model || defaultModelFor(subject, grade);
  const setOptField = (k, v) => setOpt((o) => ({ ...o, [k]: v }));
  const filledCount = Object.values(opt).filter((s) => s.trim()).length + (model ? 1 : 0);

  function changeGrade(g) {
    setGrade(g);
    // 1~2학년은 통합교과라 고를 수 있는 교과가 다르다. 남아 있으면 서버가 거부한다.
    if (!subjectsForGrade(g).includes(subject)) setSubject(subjectsForGrade(g)[0]);
  }

  // 내 이용권 상태(잔여 횟수 표시용).
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!session) { if (alive) setAccess(null); return; }
      const { data } = await myLessonPlanAccess();
      if (alive) setAccess(data ?? null);
    })();
    return () => { alive = false; };
  }, [session]);

  // 지금 보고 있는 지도안을 저장한다(텍스트라 가볍다). 제목은 폼값에서 자동 생성.
  async function saveCurrent() {
    if (!result?.text) return;
    const type = PLAN_TYPES.find((t) => t.key === result.planType);
    const title = `${grade}학년 ${subject}${unit ? " " + unit : ""} · ${type?.label ?? "지도안"}`.slice(0, 120);
    setSaveMsg(null);
    const { error } = await saveLessonPlan({ planType: result.planType, title, body: result.text });
    if (error) {
      const m = { limit_reached: "저장은 최대 50개까지예요. '내 지도안'에서 정리해 주세요.", unauthorized: "로그인이 필요해요." }[error.message];
      setSaveMsg({ type: "error", text: m || "저장하지 못했어요." });
    } else {
      setSaveMsg({ type: "ok", text: "저장했어요. '내 지도안'에서 다시 볼 수 있어요." });
    }
  }

  async function submit(planTypeOverride) {
    const pt = planTypeOverride || planType;
    const input = withDefaults({ planType: pt, grade, subject, unit, textbookId, duration, model, ...opt });
    const invalid = validatePlanInput(input);
    if (invalid) { setNotice({ type: "error", text: invalid }); return; }

    // 이전 결과를 지우지 않는다 — 세안 생성이 실패해도 약안이 화면에 남게.
    setBusy(true); setNotice(null);
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
      setResults((prev) => ({ ...prev, [data.planType]: data }));
      setView(data.planType);
    } catch {
      setNotice({ type: "error", text: "연결이 끊겼어요. 잠시 뒤 다시 시도해 주세요." });
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
        {session && (
          <Link href="/practicum/lesson-plan/saved" className="ml-auto text-xs font-bold text-[#0095da]">📁 내 지도안</Link>
        )}
      </div>

      <LessonPlanIntro />

      {/* 내 이용권 잔여 표시 */}
      {session && access?.source === "owner" && (
        <p className="rounded-lg bg-[#eef7ff] px-3 py-1.5 text-[11px] font-bold text-[#0c4470]/70">관리자 — 지도안을 무제한으로 만들 수 있어요.</p>
      )}
      {session && access?.source === "entitlement" && (
        <p className="rounded-lg bg-[#eef7ff] px-3 py-1.5 text-[11px] font-bold text-[#0c4470]/70">
          이용권: {access.grant_type === "unlimited" ? "무제한" : `남은 횟수 ${access.remaining ?? 0}회`}
        </p>
      )}

      {!authLoading && !session && (
        <div className="rounded-2xl border border-dashed border-[#0095da]/30 bg-white p-5 text-center">
          <p className="text-sm text-[#0c4470]/50">로그인하면 쓸 수 있어요.</p>
          <Link href="/login"
            className="mt-3 inline-block rounded-full bg-[#0095da] px-4 py-2 text-sm font-bold text-white">
            로그인하기
          </Link>
        </div>
      )}

      {session && !canUse && (
        <div className="rounded-2xl border border-dashed border-[#0095da]/30 bg-white p-5 text-center">
          <p className="text-2xl">🛠️</p>
          <p className="mt-1 text-sm font-bold text-[#0c4470]">지도안 생성은 준비 중이에요</p>
          <p className="mt-1 text-xs leading-relaxed text-[#0c4470]/50">
            지금은 운영자만 쓸 수 있어요. 곧 모두에게 열어드릴게요.
          </p>
        </div>
      )}

      {session && canUse && (
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

            {/* 실제 교과서 단원이 있으면 골라서 넣는다 — 자유 입력 오타로
                근거를 못 쓰는 일을 없앤다. 직접 적고 싶으면 '직접 입력'. */}
            {unitList.length > 0 ? (
              <>
                <p className="mt-3 text-xs font-bold text-[#0c4470]/40">
                  단원 <span className="font-normal text-[#0c4470]/35">· 교과서 단원을 고르면 더 정확해요</span>
                </p>
                <div className="mt-2 flex flex-col gap-1">
                  {unitList.map((u) => {
                    const label = `${u.unitNo}. ${u.unit}`;
                    return (
                      <button key={`${u.term}-${u.unitNo}-${u.unit}-${u.publisher}-${u.textbookId}`}
                        onClick={() => {
                          // 같은 단원을 다시 누르면 선택 해제(토글). 안 그러면 한 번
                          // 고른 뒤 나갔다 와야만 바꿀 수 있다.
                          if (unit === u.unit && textbookId === (u.textbookId || "")) {
                            setUnit(""); setTextbookId("");
                          } else {
                            setUnit(u.unit); setTextbookId(u.textbookId || "");
                          }
                        }}
                        className={`rounded-lg px-3 py-2 text-left text-sm ${
                          unit === u.unit && textbookId === (u.textbookId || "") ? "bg-[#0095da] font-bold text-white"
                                          : "bg-[#f2f6fa] text-[#0c4470]/80"}`}>
                        {label}
                        <span className={`ml-1.5 text-[11px] ${unit === u.unit ? "text-white/70" : "text-[#0c4470]/35"}`}>
                          {u.term}학기 · {u.totalPeriods}차시{u.textbookName ? ` · ${u.textbookName} 책` : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <input
                  value={unitList.some((u) => u.unit === unit && textbookId === (u.textbookId || "")) ? "" : unit}
                  onChange={(e) => { setUnit(e.target.value); setTextbookId(""); }} maxLength={60}
                  placeholder="목록에 없으면 직접 적어주세요"
                  className="mt-1.5 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
                />
              </>
            ) : (
              <input
                value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={60}
                placeholder="단원·주제 (예: 추론하며 읽어요)"
                className="mt-3 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
              />
            )}

            <p className="mt-3 text-xs font-bold text-[#0c4470]/40">수업 시간</p>
            <div className="mt-2 flex gap-1.5">
              {DURATIONS.map((d) => (
                <button key={d} onClick={() => setDuration(d)} className={chip(duration === d)}>
                  {d}분{d === 80 ? " (블록)" : ""}
                </button>
              ))}
            </div>

            {/* 여기까지가 필수. 이것만 채우면 바로 만들 수 있다.
                아래는 접어 둔다 — 옵션이 늘어서 첫 화면이 길어지면 안 쓴다. */}
            <button
              onClick={() => setShowMore((v) => !v)}
              className="mt-3 flex w-full items-center justify-between rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-left">
              <span className="text-xs font-bold text-[#0c4470]/60">
                더 자세히 정하기
                {filledCount > 0 && (
                  <span className="ml-1.5 rounded-full bg-[#0095da] px-1.5 py-0.5 text-[10px] text-white">
                    {filledCount}
                  </span>
                )}
              </span>
              <span className="text-xs text-[#0c4470]/40">{showMore ? "접기" : "펼치기"}</span>
            </button>

            {showMore && (
              <div className="mt-2 rounded-xl border border-[#f2f6fa] p-3">
                <p className="text-[11px] text-[#0c4470]/45">
                  안 채워도 됩니다. 채우면 더 맞는 지도안이 나와요.
                </p>

                <p className="mt-3 text-xs font-bold text-[#0c4470]/40">
                  수업모형
                  {!model && (
                    <span className="ml-1.5 font-normal text-[#0c4470]/35">
                      · 안 고르면 {TEACHING_MODELS.find((m) => m.key === effectiveModel)?.label}으로 잡아요
                    </span>
                  )}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {TEACHING_MODELS.map((m) => (
                    <button key={m.key}
                      onClick={() => setModel(model === m.key ? "" : m.key)}
                      className={chip(model === m.key)}>
                      {m.label}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] text-[#0c4470]/45">
                  {TEACHING_MODELS.find((m) => m.key === effectiveModel)?.steps}
                </p>

                {[
                  { k: "goal", ph: "학습목표 (안 적으면 알아서 잡아줘요)" },
                  { k: "learners", ph: "학습자 특성 (예: 수준차가 크고 발표를 꺼려요)" },
                  { k: "focus", ph: "중점을 둘 활동 (예: 모둠 토의를 길게)" },
                  { k: "materials", ph: "쓸 수 있는 기자재 (예: 실물화상기, 태블릿 없음)" },
                  { k: "evaluation", ph: "평가 방식 (예: 관찰 평가 위주)" },
                  { k: "request", ph: "지도교사 요구사항 (예: 판서 계획을 꼭 넣을 것)" },
                ].map(({ k, ph }) => (
                  <input key={k}
                    value={opt[k]} onChange={(e) => setOptField(k, e.target.value)}
                    maxLength={OPTIONAL_LIMITS[k]} placeholder={ph}
                    className="mt-2 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
                  />
                ))}
              </div>
            )}

            {notice && (
              <p className={`mt-3 text-xs ${notice.type === "ok" ? "text-[#1c7a4a]" : "text-[#c0392b]"}`}>
                {notice.text}
              </p>
            )}

            <button onClick={() => submit()} disabled={busy}
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
              {/* 약안·세안 둘 다 있으면 전환 탭 — 뽑은 약안이 사라지지 않고 오갈 수 있다. */}
              {results.brief && results.full && (
                <div className="mt-2 flex gap-1.5">
                  {["brief", "full"].map((k) => (
                    <button key={k} onClick={() => setView(k)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-bold ${
                        view === k ? "bg-[#0095da] text-white" : "bg-[#f2f6fa] text-[#0c4470]/70"}`}>
                      {k === "brief" ? "약안" : "세안"}
                    </button>
                  ))}
                </div>
              )}
              {/* 잘린 결과를 완성본처럼 보여주지 않는다 — 실습 제출물이라
                  모르고 그대로 내면 사용자가 손해를 본다. */}
              {result.truncated && (
                <div className="mt-2 rounded-xl bg-[#fdecea] px-3 py-2">
                  <p className="text-[11px] font-bold leading-relaxed text-[#c0392b]">
                    분량 한도에 걸려 뒷부분이 잘렸어요. 다시 만들거나 단원·주제를
                    좁혀서 시도해 주세요.
                  </p>
                </div>
              )}
              <div className="mt-2 rounded-xl bg-[#fff8e5] px-3 py-2">
                <p className="text-[11px] leading-relaxed text-[#8a6d00]">
                  ⚠️ AI 가 만든 초안이에요. 성취기준 코드와 차시 배당은 교과서·교육과정을
                  직접 확인해 주세요. 그대로 제출하면 실습 평가에 불리할 수 있어요.
                </p>
              </div>

              {/* 내보내기 · 세안 만들기 */}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button
                  onClick={() => printLessonPlan(result.text,
                    `${PLAN_TYPES.find((t) => t.key === result.planType)?.label ?? "지도안"} 초안`)}
                  className="rounded-lg bg-[#f2f6fa] px-3 py-1.5 text-xs font-bold text-[#0c4470]/70">
                  🖨️ PDF·인쇄
                </button>
                <button
                  onClick={() => downloadLessonPlan(result.text,
                    `수업지도안_${result.planType === "full" ? "세안" : "약안"}.doc`)}
                  className="rounded-lg bg-[#f2f6fa] px-3 py-1.5 text-xs font-bold text-[#0c4470]/70">
                  📄 한글·워드(.doc)
                </button>
                {/* 저장 — 새로고침해도 '내 지도안'에서 다시 볼 수 있게. */}
                <button onClick={saveCurrent}
                  className="rounded-lg bg-[#eaf6ff] px-3 py-1.5 text-xs font-bold text-[#0095da]">
                  💾 저장
                </button>
                {/* 세안이 아직 없을 때만 제안 — 이미 뽑았으면 위 탭으로 오간다(중복 과금 방지). */}
                {result.planType === "brief" && !results.full && (
                  <button
                    onClick={() => { setPlanType("full"); submit("full"); }}
                    disabled={busy}
                    className="rounded-lg bg-[#0095da] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40">
                    ✨ 이 약안으로 세안 만들기
                  </button>
                )}
              </div>
              {saveMsg && (
                <p className={`mt-1.5 text-[11px] font-bold ${saveMsg.type === "ok" ? "text-[#1a9b6c]" : "text-[#d05b6a]"}`}>{saveMsg.text}</p>
              )}

              {/* 약안·세안 폼으로 렌더 — 캡처해서 바로 쓸 수 있게 */}
              <div className="mt-2 max-h-[60vh] overflow-auto rounded-xl border border-black/5 bg-white p-3">
                <LessonPlanView text={result.text} />
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
