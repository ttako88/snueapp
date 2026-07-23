"use client";
// 콘솔 — 지도안 생성 분석 (035). 오늘 집계 + 효용지표 + 실행 내역.
// 권한 경계는 DB(admin_lesson_* 의 require_permission('analytics.read')).
import { useEffect, useState } from "react";
import { lessonAnalyticsOverview, lessonRunsList } from "../../../lib/community/adminLessonAnalytics";
import { isNotActivated } from "../../../lib/community/adminConsole";

const FUNDING = { owner: "관리자", entitlement: "이용권", paid: "SR" };
const fmtTime = (s) => { try { return new Date(s).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch { return s; } };

export default function LessonAnalyticsPage() {
  const [ov, setOv] = useState(null);
  const [runs, setRuns] = useState([]);
  const [state, setState] = useState("loading"); // loading | ok | not_activated | error

  useEffect(() => {
    let alive = true;
    (async () => {
      const [o, r] = await Promise.all([lessonAnalyticsOverview(), lessonRunsList({ limit: 50 })]);
      if (!alive) return;
      if (o.error) { setState(isNotActivated(o.error) ? "not_activated" : "error"); return; }
      setOv(o.data ?? null);
      setRuns(Array.isArray(r.data) ? r.data : []);
      setState("ok");
    })();
    return () => { alive = false; };
  }, []);

  if (state === "loading") return <Muted>불러오는 중…</Muted>;
  if (state === "not_activated") return <Muted>분석 기능이 아직 활성화되지 않았어요. (마이그레이션 035 적용 필요)</Muted>;
  if (state === "error") return <Muted>불러오지 못했어요. 권한(analytics.read)을 확인해 주세요.</Muted>;

  const ret = ov?.retention ?? {};
  const won = (n) => `₩${Number(n ?? 0).toLocaleString()}`;
  return (
    <div className="flex flex-col gap-4">
      <section>
        <H>오늘 · {ov?.day}</H>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Card n={ov?.brief_count ?? 0} label="약안 생성" />
          <Card n={ov?.full_count ?? 0} label="세안 생성" />
          <Card n={ov?.users ?? 0} label="이용 인원" />
          <Card n={won(ov?.cost_krw)} label="API 비용" />
          <Card n={`${Number(ov?.sr_spent ?? 0).toLocaleString()} SR`} label="SR 사용" />
        </div>
      </section>

      <section>
        <H>효용 지표 · 전체 누적</H>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Card n={`${ov?.upgrade_rate ?? 0}%`} label="약안→세안 전환" sub="약안 쓴 사람 중 세안까지 간 비율" />
          <Card n={`${ov?.export_rate ?? 0}%`} label="내보내기 전환" sub="뽑고 파일로 저장까지" />
          <Card n={ov?.total_runs ?? 0} label="총 생성 횟수" />
        </div>
        <div className="mt-2 rounded-xl bg-[#f2f6fa] p-3 text-xs text-[#0c4470]/70">
          <b>재사용(단골) 분포</b> — 1회 <b>{ret.once ?? 0}</b>명 · 2~4회 <b>{ret.few ?? 0}</b>명 · 5회+ <b>{ret.loyal ?? 0}</b>명
          <p className="mt-1 text-[11px] text-[#0c4470]/45">1회만 쓰고 안 돌아온 사람이 많으면 생성기 효용을 점검할 신호예요.</p>
        </div>
      </section>

      <section>
        <H>실행 내역 · 최근 {runs.length}건</H>
        {runs.length === 0 ? (
          <Muted>아직 생성 내역이 없어요.</Muted>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full border-collapse whitespace-nowrap text-[11px]">
              <thead>
                <tr className="text-left text-[#0c4470]/45">
                  {["시각", "닉네임", "종류", "학년", "교과", "단원", "모델", "자금", "₩", "SR", "체인", "내보내기"].map((h) => (
                    <th key={h} className="border-b border-black/10 px-1.5 py-1 font-bold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="text-[#0c4470]/80">
                    <td className="px-1.5 py-1">{fmtTime(r.created_at)}</td>
                    <td className="px-1.5 py-1">{r.nickname ?? "—"}</td>
                    <td className="px-1.5 py-1">{r.plan_type === "full" ? "세안" : "약안"}</td>
                    <td className="px-1.5 py-1">{r.grade ?? "—"}</td>
                    <td className="px-1.5 py-1">{r.subject ?? "—"}</td>
                    <td className="max-w-[140px] truncate px-1.5 py-1" title={r.unit ?? ""}>{r.unit ?? "—"}</td>
                    <td className="px-1.5 py-1">{r.model}</td>
                    <td className="px-1.5 py-1">{FUNDING[r.funding_source] ?? r.funding_source}</td>
                    <td className="px-1.5 py-1">{Number(r.cost_krw ?? 0).toLocaleString()}</td>
                    <td className="px-1.5 py-1">{r.sr_spent ?? 0}</td>
                    <td className="px-1.5 py-1">{r.chained ? "↳" : ""}</td>
                    <td className="px-1.5 py-1">{[r.exported_docx && "docx", r.exported_hwp && "hwp", r.exported_pdf && "pdf"].filter(Boolean).join("·") || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function H({ children }) { return <p className="mb-1.5 text-xs font-bold text-[#0c4470]/40">{children}</p>; }
function Muted({ children }) { return <p className="text-sm text-[#0c4470]/50">{children}</p>; }
function Card({ n, label, sub }) {
  return (
    <div className="rounded-xl bg-white p-3 shadow-sm">
      <p className="text-lg font-bold text-[#0c4470]">{n}</p>
      <p className="text-[11px] font-bold text-[#0c4470]/60">{label}</p>
      {sub && <p className="mt-0.5 text-[10px] text-[#0c4470]/40">{sub}</p>}
    </div>
  );
}
