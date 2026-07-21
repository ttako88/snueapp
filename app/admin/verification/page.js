"use client"; // 심사 목록·처리를 Supabase RPC 로 하므로 브라우저에서 동작

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabase/client";
import { useAuth } from "../../lib/identity/useAuth";
import {
  DOC_TYPE_LABEL, REJECT_REASONS,
  listVerificationRequests, reviewVerification, requestDocumentUrl,
} from "../../lib/community/verification";

// 이 화면은 UX 게이트일 뿐이다. 실제 권한 경계는 DB 다 —
// list_verification_requests 와 review_verification 이 actor_role_check('operator')
// 를 첫 문장에서 부른다. 화면을 우회해 RPC 를 직접 불러도 막힌다.
const ALLOWED_ROLES = ["operator", "owner"];

function fmt(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function VerificationConsolePage() {
  const { session, profile, loading: authLoading, profileLoading } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [rejecting, setRejecting] = useState(null); // { id, code }
  const [docUrl, setDocUrl] = useState(null);       // { id, url, pdf }
  const [docBusyId, setDocBusyId] = useState(null);
  const [notice, setNotice] = useState(null);

  const role = profile?.role ?? null;
  const canReview = ALLOWED_ROLES.includes(role);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listVerificationRequests().then(({ data, error: err }) => {
      if (err) {
        // 권한 오류와 그 밖의 오류를 구분해 안내한다.
        setError(/not allowed/i.test(err.message || "")
          ? "이 화면을 볼 권한이 없어요."
          : `목록을 불러오지 못했어요 (${err.message})`);
        setRows([]);
      } else {
        setRows(data ?? []);
      }
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!supabase || authLoading || profileLoading || !session || !canReview) {
      setLoading(false);
      return;
    }
    load();
  }, [session, authLoading, profileLoading, canReview, load]);

  async function openDoc(id) {
    setDocBusyId(id);
    setNotice(null);
    const { data, error: err } = await requestDocumentUrl(id);
    setDocBusyId(null);
    if (err || !data?.url) {
      // audit_unavailable 은 서버가 일부러 막은 것이다 — 접근 기록을 남기지
      // 못하면 열람을 허용하지 않는다. 심사자가 "왜 안 열리지" 하고 헤매지
      // 않도록 차단 사유를 그대로 말해 준다.
      setNotice({
        type: "error",
        text: err?.code === "purged" ? "이 서류는 이미 파기됐어요."
          : err?.code === "audit_unavailable"
            ? "보안 접근 기록을 남길 수 없어 서류 열람을 차단했어요. 잠시 후 다시 시도해 주세요."
            : "서류를 열지 못했어요.",
      });
      return;
    }
    // 형식을 화면에서 추측하지 않는다. 경로에는 확장자가 없고(서버가 일부러
    // 빼놨다) URL 로도 알 수 없다. finalize 가 magic bytes 판정 결과로
    // Content-Type 을 바로잡아 두므로, <object> 가 헤더를 보고 알아서 그린다.
    setDocUrl({ id, url: data.url });
  }

  async function handle(id, approve, rejectCode) {
    setBusyId(id);
    setNotice(null);
    const { error: err } = await reviewVerification({ requestId: id, approve, rejectCode });
    setBusyId(null);
    if (err) {
      setNotice({ type: "error", text: `처리하지 못했어요 (${err.message})` });
      return;
    }
    setRejecting(null);
    setNotice({ type: "ok", text: approve ? "승인했어요." : "반려했어요." });
    // 목록을 다시 불러온다. 낙관적 갱신은 하지 않는다 —
    // 서버가 상태를 바꿨는지 확인하지 않고 화면만 바꾸면 어긋난다.
    load();
  }

  if (authLoading || profileLoading) return <Shell><Muted>확인 중이에요…</Muted></Shell>;

  if (!session) {
    return (
      <Shell>
        <Muted>로그인이 필요해요.</Muted>
        <Link href="/login" className="mt-3 inline-block text-sm font-bold text-[#0095da]">
          로그인하기
        </Link>
      </Shell>
    );
  }

  if (!canReview) {
    return (
      <Shell>
        <Muted>이 화면은 운영자만 볼 수 있어요.</Muted>
        <p className="mt-1 text-xs text-[#0c4470]/40">현재 권한: {role ?? "알 수 없음"}</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-[#0c4470]">심사 대기 {rows.length}건</p>
        <button
          onClick={load}
          className="rounded-lg bg-[#f2f6fa] px-3 py-1.5 text-xs font-bold text-[#0c4470]/70"
        >
          새로고침
        </button>
      </div>

      {notice && (
        <p className={`mt-3 rounded-xl px-3 py-2 text-xs ${
          notice.type === "ok" ? "bg-[#eaf6ef] text-[#1c7a4a]" : "bg-[#fdeaea] text-[#c0392b]"}`}>
          {notice.text}
        </p>
      )}

      {loading && <Muted className="mt-4">불러오는 중…</Muted>}
      {error && <p className="mt-4 text-sm text-[#c0392b]">{error}</p>}

      {!loading && !error && rows.length === 0 && (
        <div className="mt-6 rounded-2xl bg-white p-6 text-center shadow-sm">
          <p className="text-sm text-[#0c4470]/50">심사할 신청이 없어요.</p>
        </div>
      )}

      <div className="mt-3 flex flex-col gap-2">
        {rows.map((r) => (
          <div key={r.id} className="rounded-2xl bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-[#0c4470]">{r.real_name}</p>
                <p className="mt-0.5 text-xs text-[#0c4470]/50">
                  {DOC_TYPE_LABEL[r.doc_type] ?? r.doc_type} · {fmt(r.submitted_at)}
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-[#fff5e5] px-2 py-0.5 text-[11px] font-bold text-[#b8860b]">
                대기
              </span>
            </div>

            {/* 서류 열람 — 서버가 60초 signed URL 을 발급한다. URL 을 상태에
                담아두지 않는 이유: 60초면 만료되므로 남겨두면 "눌렀는데 안 열리는"
                버튼이 된다. 누를 때마다 새로 받는다. */}
            {docUrl?.id === r.id ? (
              <div className="mt-3 overflow-hidden rounded-xl border border-black/5">
                <object data={docUrl.url} className="h-96 w-full bg-[#f8f9fb]">
                  {/* 브라우저가 내장 뷰어로 못 그릴 때만 이 링크가 보인다 */}
                  <a href={docUrl.url} target="_blank" rel="noreferrer"
                     className="block px-3 py-6 text-center text-xs font-bold text-[#0095da]">
                    새 창에서 열기
                  </a>
                </object>
                <button
                  onClick={() => setDocUrl(null)}
                  className="w-full bg-[#f8f9fb] py-2 text-[11px] font-bold text-[#0c4470]/50"
                >
                  닫기 (링크는 60초 뒤 만료돼요)
                </button>
              </div>
            ) : (
              <button
                onClick={() => openDoc(r.id)}
                disabled={docBusyId === r.id}
                className="mt-3 w-full rounded-xl bg-[#f2f6fa] py-2.5 text-xs font-bold text-[#0c4470]/70 disabled:opacity-40"
              >
                {docBusyId === r.id ? "여는 중…" : "제출 서류 보기"}
              </button>
            )}

            {rejecting?.id === r.id ? (
              <div className="mt-3">
                <p className="text-xs font-bold text-[#0c4470]">반려 사유</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {REJECT_REASONS.map((reason) => (
                    <button
                      key={reason.code}
                      onClick={() => setRejecting({ id: r.id, code: reason.code })}
                      className={`rounded-lg px-2.5 py-1.5 text-xs ${
                        rejecting.code === reason.code
                          ? "bg-[#0095da] font-bold text-white"
                          : "bg-[#f2f6fa] text-[#0c4470]/70"}`}
                    >
                      {reason.label}
                    </button>
                  ))}
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    disabled={!rejecting.code || busyId === r.id}
                    onClick={() => handle(r.id, false, rejecting.code)}
                    className="flex-1 rounded-xl bg-[#c0392b] py-2.5 text-sm font-bold text-white disabled:opacity-40"
                  >
                    {busyId === r.id ? "처리 중…" : "반려하기"}
                  </button>
                  <button
                    onClick={() => setRejecting(null)}
                    className="rounded-xl bg-[#f2f6fa] px-4 py-2.5 text-sm font-bold text-[#0c4470]/70"
                  >
                    취소
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex gap-2">
                <button
                  disabled={busyId === r.id}
                  onClick={() => handle(r.id, true)}
                  className="flex-1 rounded-xl bg-[#0095da] py-2.5 text-sm font-bold text-white disabled:opacity-40"
                >
                  {busyId === r.id ? "처리 중…" : "승인"}
                </button>
                <button
                  disabled={busyId === r.id}
                  onClick={() => setRejecting({ id: r.id, code: null })}
                  className="rounded-xl bg-[#f2f6fa] px-4 py-2.5 text-sm font-bold text-[#0c4470]/70 disabled:opacity-40"
                >
                  반려
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center gap-2">
        <Link href="/settings" className="text-sm text-[#0c4470]/50">‹</Link>
        <h1 className="text-base font-bold text-[#0c4470]">학생 인증 심사</h1>
      </div>
      {children}
    </div>
  );
}

function Muted({ children, className = "" }) {
  return <p className={`text-sm text-[#0c4470]/50 ${className}`}>{children}</p>;
}
