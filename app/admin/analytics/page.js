"use client"; // 집계를 Supabase RPC 로 받으므로 브라우저에서 동작

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase/client";
import { useAuth } from "../../lib/identity/useAuth";
import { isEnabled } from "../../lib/features.js";
import {
  analyticsOverview, analyticsEventSegments, analyticsDaily,
} from "../../lib/community/analyticsAdmin";

// 화면 게이트일 뿐이다. 실제 경계는 DB(actor_role_check('operator'))다.
const ALLOWED_ROLES = ["operator", "owner"];

// registry 와 같은 이벤트 목록(선택기용). 서버가 최종 판정하므로 여기 값은 표시용.
const EVENTS = [
  "screen_view", "feature_start", "feature_complete", "button_click",
  "search_submitted", "error", "sponsor_impression", "sponsor_click",
];

const GRADE_LABEL = (g) => (g >= 1 && g <= 4 ? `${g}학년` : `${g}`);

export default function AnalyticsDashboardPage() {
  const { session, profile, loading: authLoading, profileLoading } = useAuth();
  const role = profile?.role ?? null;
  const canView = ALLOWED_ROLES.includes(role);
  const flagOn = isEnabled("productAnalytics");

  const [overview, setOverview] = useState(null);
  const [event, setEvent] = useState("screen_view");
  const [segments, setSegments] = useState(null);
  const [daily, setDaily] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0); // "새로고침" 트리거

  // 개요 로드 — setState 는 async 콜백 안에서만(effect 본문 동기 setState 회피).
  useEffect(() => {
    const ready = supabase && session && canView && flagOn && !authLoading && !profileLoading;
    if (!ready) return;
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await analyticsOverview();
      if (!alive) return;
      if (err) {
        setError(/not allowed/i.test(err.message || "")
          ? "이 화면을 볼 권한이 없어요."
          : `불러오지 못했어요 (${err.message})`);
      } else {
        setOverview(data);
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [session, canView, flagOn, authLoading, profileLoading, tick]);

  // 선택 이벤트의 세그먼트·시계열 로드.
  useEffect(() => {
    const ready = supabase && session && canView && flagOn;
    if (!ready) return;
    let alive = true;
    (async () => {
      setSegments(null);
      setDaily(null);
      const seg = await analyticsEventSegments(event);
      if (alive) setSegments(seg.data ?? null);
      const dy = await analyticsDaily(event);
      if (alive) setDaily(dy.data ?? null);
    })();
    return () => { alive = false; };
  }, [event, session, canView, flagOn, tick]);

  if (authLoading || profileLoading) return <Shell><Muted>확인 중이에요…</Muted></Shell>;

  if (!flagOn) {
    return (
      <Shell>
        <Muted>이용통계 기능이 아직 켜져 있지 않아요.</Muted>
        <p className="mt-1 text-xs text-[#0c4470]/40">
          준비는 끝났고, 설정(productAnalytics)을 켜면 집계가 시작돼요.
        </p>
      </Shell>
    );
  }
  if (!session) {
    return (
      <Shell>
        <Muted>로그인이 필요해요.</Muted>
        <Link href="/login" className="mt-3 inline-block text-sm font-bold text-[#0095da]">로그인하기</Link>
      </Shell>
    );
  }
  if (!canView) {
    return (
      <Shell>
        <Muted>이 화면은 운영자만 볼 수 있어요.</Muted>
        <p className="mt-1 text-xs text-[#0c4470]/40">현재 권한: {role ?? "알 수 없음"}</p>
      </Shell>
    );
  }

  const m = overview?.members;
  const byDept = overview?.by_department ?? [];
  const byGrade = overview?.by_grade ?? [];
  const events = overview?.events ?? {};

  return (
    <Shell>
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-[#0c4470]">이용통계</p>
        <button onClick={() => setTick((t) => t + 1)}
          className="rounded-lg bg-[#f2f6fa] px-3 py-1.5 text-xs font-bold text-[#0c4470]/70">
          새로고침
        </button>
      </div>
      <p className="mt-1 text-[11px] text-[#0c4470]/40">
        개인 단위 조회는 제공하지 않아요. 5명 미만 세그먼트는 숨겨져요(k-익명).
      </p>

      {loading && <Muted className="mt-4">불러오는 중…</Muted>}
      {error && <p className="mt-4 text-sm text-[#c0392b]">{error}</p>}

      {!loading && !error && (
        <>
          {/* 회원 총계 */}
          <Card title="회원">
            <div className="flex gap-4">
              <Stat label="전체" value={m?.total} />
              <Stat label="인증" value={m?.verified} />
              <Stat label="대기" value={m?.pending} />
            </div>
          </Card>

          {/* 학과 분포 */}
          <Card title="학과 분포 (5명 이상)">
            {byDept.length === 0 ? <Muted>표시할 세그먼트가 없어요.</Muted> : (
              <div className="flex flex-col gap-1">
                {byDept.map((d) => (
                  <Row key={d.department} label={d.department} value={d.n} />
                ))}
              </div>
            )}
          </Card>

          {/* 학년 분포 */}
          <Card title="학년 분포 (5명 이상)">
            {byGrade.length === 0 ? <Muted>표시할 세그먼트가 없어요.</Muted> : (
              <div className="flex flex-col gap-1">
                {byGrade.map((g) => (
                  <Row key={g.grade} label={GRADE_LABEL(g.grade)} value={g.n} />
                ))}
              </div>
            )}
          </Card>

          {/* 이벤트 총량 */}
          <Card title="이벤트 총량">
            {Object.keys(events).length === 0 ? <Muted>아직 수집된 이벤트가 없어요.</Muted> : (
              <div className="flex flex-col gap-1">
                {Object.entries(events).map(([ev, n]) => (
                  <Row key={ev} label={ev} value={n} />
                ))}
              </div>
            )}
          </Card>

          {/* 이벤트별 세그먼트 — 직전 완결 ISO 주(불변 스냅샷) */}
          <Card title="이벤트별 학과·학년 세그먼트 (동의자, 지난 주)">
            <select value={event} onChange={(e) => setEvent(e.target.value)}
              className="mb-2 w-full rounded-lg bg-[#f2f6fa] px-3 py-2 text-sm text-[#0c4470]">
              {EVENTS.map((ev) => <option key={ev} value={ev}>{ev}</option>)}
            </select>
            {segments?.week_start && (
              <p className="mb-1 text-[11px] text-[#0c4470]/40">
                {segments.week_start} ~ {segments.week_end} (확정 스냅샷)
              </p>
            )}
            {!segments ? <Muted>불러오는 중…</Muted>
              : (segments.segments ?? []).length === 0
                ? <Muted>5명 이상인 세그먼트가 없어요.</Muted>
                : (
                  <div className="flex flex-col gap-1">
                    {segments.segments.map((s, i) => (
                      <Row key={i}
                        label={`${s.department ?? "미상"} · ${GRADE_LABEL(s.grade)}`}
                        value={s.n} />
                    ))}
                  </div>
                )}
            {daily && (daily.daily ?? []).length > 0 && (
              <p className="mt-2 text-[11px] text-[#0c4470]/40">
                최근 {daily.days}일 합계 {daily.daily.reduce((a, b) => a + Number(b.n), 0)}건
              </p>
            )}
          </Card>
        </>
      )}
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center gap-2">
        <Link href="/settings" className="text-sm text-[#0c4470]/50">‹</Link>
        <h1 className="text-base font-bold text-[#0c4470]">이용통계</h1>
      </div>
      {children}
    </div>
  );
}
function Card({ title, children }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <p className="mb-2 text-xs font-bold text-[#0c4470]/70">{title}</p>
      {children}
    </div>
  );
}
function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-[#0c4470]/80">{label}</span>
      <span className="font-bold text-[#0c4470]">{value}</span>
    </div>
  );
}
function Stat({ label, value }) {
  return (
    <div className="flex flex-col">
      <span className="text-lg font-bold text-[#0c4470]">{value ?? "-"}</span>
      <span className="text-[11px] text-[#0c4470]/50">{label}</span>
    </div>
  );
}
function Muted({ children, className = "" }) {
  return <p className={`text-sm text-[#0c4470]/50 ${className}`}>{children}</p>;
}
