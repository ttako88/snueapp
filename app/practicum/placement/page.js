"use client";

// 학기별 실습학교 설정.
//
// 우리 학교는 2-1부터 4-1까지 다섯 학기 실습을 나가고 **학기마다 학교가 바뀐다.**
// 그래서 한 번 고르고 끝나는 화면이 아니라, 학기 칸이 다섯 개 있는 화면이다.
//
// ⚠️ 이건 "학교 인증" 이 아니다. 배정을 검증할 방법이 없으므로 화면에도
//    "본인이 설정한 실습학교" 로 적는다. 게시판 분탕을 막는 실질적 장벽은
//    학생 인증(재학증명서)이고, 이 설정은 그 위에 얹는 분류일 뿐이다.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabase/client";
import { useAuth } from "../../lib/identity/useAuth";
import { isEnabled } from "../../lib/features";
import { SCHOOLS } from "../../lib/practicum/schools";
import {
  REASONS_AFTER_LOCK, semestersForEntryYear,
} from "../../lib/practicum/placement";

const THIS_YEAR = Number(
  new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 4));

// 입학연도 후보. 재학생 범위만 보여 준다.
const ENTRY_YEARS = Array.from({ length: 8 }, (_, i) => THIS_YEAR - i);

const MESSAGES = {
  not_allowed: "학생 인증을 마쳐야 설정할 수 있어요.",
  bad_semester: "학기 형식이 올바르지 않아요.",
  bad_school: "학교 이름이 올바르지 않아요.",
  locked_needs_reason: "이미 글을 쓴 학기예요. 바꾸는 이유를 골라주세요.",
};

export default function PlacementPage() {
  const { session, loading: authLoading } = useAuth();
  const [entryYear, setEntryYear] = useState(THIS_YEAR - 1);
  const [placements, setPlacements] = useState(null);   // null = 아직 안 읽음
  const [loadError, setLoadError] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [notice, setNotice] = useState(null);
  const [reasonFor, setReasonFor] = useState(null);     // 잠긴 학기 변경 사유 묻기

  const rows = semestersForEntryYear(entryYear);

  const load = useCallback(async () => {
    if (!session) return;
    const { data, error } = await supabase.rpc("get_my_placements");
    if (error) {
      // 조용히 빈 배열로 덮지 않는다 — "설정 안 함" 과 "못 읽음" 은 다르다.
      setLoadError("설정을 불러오지 못했어요.");
      return;
    }
    setLoadError(null);
    setPlacements(Array.isArray(data) ? data : []);
  }, [session]);

  useEffect(() => { load(); }, [load]);

  const current = (semester) =>
    (placements ?? []).find((p) => p.semester === semester) ?? null;

  async function save(semester, school, reason = null) {
    setBusyKey(semester); setNotice(null);
    try {
      const { data, error } = await supabase.rpc("set_practicum_placement", {
        p_semester: semester, p_school: school, p_reason: reason,
      });
      if (error) {
        setNotice({ type: "error", text: MESSAGES[error.message] ?? "저장하지 못했어요." });
        return;
      }
      if (data?.status === "locked_needs_reason") {
        // 이미 글을 쓴 학기다. 사유를 받아 다시 시도한다.
        setReasonFor({ semester, school });
        return;
      }
      if (data?.status && !["set", "changed", "unchanged"].includes(data.status)) {
        setNotice({ type: "error", text: MESSAGES[data.status] ?? "저장하지 못했어요." });
        return;
      }
      setReasonFor(null);
      setNotice({ type: "ok", text: "저장했어요." });
      await load();
    } catch {
      setNotice({ type: "error", text: "연결이 끊겼어요. 잠시 뒤 다시 시도해 주세요." });
    } finally {
      setBusyKey(null);
    }
  }

  if (!isEnabled("practicumPlacement")) {
    return (
      <div className="flex flex-col gap-3 px-4 py-4">
        <Header />
        <p className="rounded-2xl bg-white p-5 text-center text-sm text-[#0c4470]/50">
          준비 중인 기능이에요.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <Header />

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
            <p className="text-xs font-bold text-[#0c4470]/40">입학연도</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {ENTRY_YEARS.map((y) => (
                <button key={y} onClick={() => setEntryYear(y)}
                  className={`rounded-lg px-2.5 py-1.5 text-xs ${
                    entryYear === y ? "bg-[#0095da] font-bold text-white"
                                    : "bg-[#f2f6fa] text-[#0c4470]/70"}`}>
                  {y}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-[#0c4470]/45">
              학기 연도를 계산하는 데만 써요. 휴학했다면 아래에서 직접 골라주세요.
            </p>
          </section>

          {loadError && (
            <p className="rounded-2xl bg-[#fdecea] px-4 py-3 text-xs text-[#c0392b]">
              {loadError}{" "}
              <button onClick={load} className="font-bold underline">다시 시도</button>
            </p>
          )}

          {notice && (
            <p className={`px-1 text-xs ${
              notice.type === "ok" ? "text-[#1c7a4a]" : "text-[#c0392b]"}`}>
              {notice.text}
            </p>
          )}

          {rows.map((r) => (
            <TermCard
              key={r.semester}
              row={r}
              placement={current(r.semester)}
              busy={busyKey === r.semester}
              askingReason={reasonFor?.semester === r.semester ? reasonFor : null}
              onPick={(school) => save(r.semester, school)}
              onReason={(reason) => save(r.semester, reasonFor.school, reason)}
              onCancelReason={() => setReasonFor(null)}
            />
          ))}

          <p className="px-1 text-[11px] leading-relaxed text-[#0c4470]/40">
            본인이 직접 설정한 실습학교예요. 학교가 확인해 준 값이 아니에요.
            첫 글을 쓰기 전까지는 자유롭게 바꿀 수 있고, 그 뒤에는 사유만
            남기면 바꿀 수 있어요 (추가 비용 없음).
          </p>
        </>
      )}
    </div>
  );
}

function Header() {
  return (
    <div className="flex items-center gap-2">
      <Link href="/practicum" className="text-sm text-[#0c4470]/50">‹</Link>
      <h1 className="text-base font-bold text-[#0c4470]">실습학교 설정</h1>
    </div>
  );
}

function TermCard({ row, placement, busy, askingReason, onPick, onReason, onCancelReason }) {
  const [open, setOpen] = useState(false);
  const picked = placement?.school ?? null;

  return (
    <section className="rounded-2xl bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-bold text-[#0c4470]">{row.label}</p>
          <p className="text-[11px] text-[#0c4470]/40">{row.semester}</p>
        </div>
        {picked ? (
          <div className="text-right">
            <p className="text-sm font-bold text-[#0095da]">{picked}</p>
            {placement?.locked && (
              <p className="text-[10px] text-[#0c4470]/40">글을 써서 고정됨</p>
            )}
          </div>
        ) : (
          <p className="text-xs text-[#0c4470]/35">아직 안 정함</p>
        )}
      </div>

      {askingReason ? (
        <div className="mt-3 rounded-xl bg-[#fff8e5] p-3">
          <p className="text-[11px] text-[#8a6d00]">
            이 학기에 이미 글을 쓰셨어요. <b>{askingReason.school}</b> 으로 바꾸는
            이유를 골라주세요.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {REASONS_AFTER_LOCK.map((c) => (
              <button key={c.key} disabled={busy} onClick={() => onReason(c.key)}
                className="rounded-lg bg-white px-2.5 py-1.5 text-xs text-[#8a6d00] disabled:opacity-40">
                {c.label}
              </button>
            ))}
            <button onClick={onCancelReason}
              className="rounded-lg px-2.5 py-1.5 text-xs text-[#0c4470]/40">
              취소
            </button>
          </div>
        </div>
      ) : (
        <>
          <button onClick={() => setOpen((v) => !v)} disabled={busy}
            className="mt-2 text-xs font-bold text-[#0095da] disabled:opacity-40">
            {busy ? "저장 중…" : picked ? "바꾸기" : "학교 고르기"}
          </button>

          {open && !busy && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {SCHOOLS.map((s) => (
                <button key={s.short}
                  onClick={() => { onPick(s.short); setOpen(false); }}
                  className={`rounded-lg px-2.5 py-1.5 text-xs ${
                    picked === s.short ? "bg-[#0095da] font-bold text-white"
                                       : "bg-[#f2f6fa] text-[#0c4470]/70"}`}>
                  {s.short}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
