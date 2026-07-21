"use client";

// 학생 인증 제출 화면.
//
// 제출은 begin → 업로드 → finalize 3단계다. 중간에 끊길 수 있으므로
// 어느 단계에서 멈췄는지 사용자에게 보여주고, 업로드까지 끝났다면
// finalize 만 다시 시도할 수 있게 한다.
//
// 학번·이름은 제출 후 화면에 남기지 않는다.

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase/client";
import { useAuth } from "../../lib/identity/useAuth";
import {
  DOC_TYPES, ACCEPT_MIME, MAX_BYTES,
  submitVerification, retryFinalize, messageFor,
  listMyVerificationRequests, withdrawVerification,
} from "../../lib/community/verificationSubmit";
import { REQUEST_STATUS_LABEL, DOC_TYPE_LABEL, REJECT_REASONS } from "../../lib/community/verification";

const REJECT_LABEL = Object.fromEntries(REJECT_REASONS.map((r) => [r.code, r.label]));

function fmt(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

const STEP_TEXT = { begin: "확인하는 중…", upload: "올리는 중…", finalize: "제출하는 중…" };

export default function VerificationPage() {
  const { session, loading: authLoading } = useAuth();
  const [realName, setRealName] = useState("");
  const [studentNo, setStudentNo] = useState("");
  const [docType, setDocType] = useState(null);
  const [file, setFile] = useState(null);
  const [step, setStep] = useState(null);
  const [notice, setNotice] = useState(null);
  // 업로드는 됐는데 finalize 가 실패한 신청. 재시도 버튼을 띄우는 근거.
  const [stuckId, setStuckId] = useState(null);
  const [mine, setMine] = useState([]);
  const [listLoading, setListLoading] = useState(true);

  function load() {
    setListLoading(true);
    listMyVerificationRequests().then(({ data, error }) => {
      if (!error) setMine(data ?? []);
      setListLoading(false);
    });
  }

  useEffect(() => {
    if (!supabase || authLoading || !session) { setListLoading(false); return; }
    load();
  }, [session, authLoading]);

  const active = mine.find((r) => r.status === "uploading" || r.status === "submitted");
  const busy = step !== null;

  async function send() {
    if (!docType) { setNotice({ type: "error", text: "서류 종류를 골라주세요." }); return; }
    if (!file) { setNotice({ type: "error", text: "증빙 파일을 선택해주세요." }); return; }
    setNotice(null);

    const res = await submitVerification({ realName, studentNo, docType, file }, setStep);
    setStep(null);

    if (res.error) {
      setNotice({ type: "error", text: messageFor(res.error.code) });
      // finalize 에서만 재시도가 의미 있다. begin 실패는 신청 자체가 없다.
      setStuckId(res.step === "finalize" ? res.requestId ?? null : null);
      load();
      return;
    }
    setRealName(""); setStudentNo(""); setDocType(null); setFile(null);
    setStuckId(null);
    setNotice({ type: "ok", text: "제출했어요. 심사는 보통 하루 안에 끝나요." });
    load();
  }

  async function retry() {
    setStep("finalize");
    const res = await retryFinalize(stuckId);
    setStep(null);
    if (res.error) { setNotice({ type: "error", text: messageFor(res.error.code) }); return; }
    setStuckId(null);
    setNotice({ type: "ok", text: "제출했어요." });
    load();
  }

  async function withdraw(id) {
    if (!confirm("신청을 철회할까요? 올린 서류는 파기돼요.")) return;
    const { error } = await withdrawVerification(id);
    if (error) { setNotice({ type: "error", text: "철회하지 못했어요." }); return; }
    setNotice({ type: "ok", text: "철회했어요." });
    load();
  }

  function pickFile(e) {
    const f = e.target.files?.[0] ?? null;
    if (f && f.size > MAX_BYTES) {
      setNotice({ type: "error", text: "파일이 10MB를 넘어요." });
      setFile(null);
      e.target.value = "";
      return;
    }
    setNotice(null);
    setFile(f);
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center gap-2">
        <Link href="/settings" className="text-sm text-[#0c4470]/50">‹</Link>
        <h1 className="text-base font-bold text-[#0c4470]">학생 인증</h1>
      </div>

      {!authLoading && !session && (
        <div className="rounded-2xl border border-dashed border-[#0095da]/30 bg-white p-5 text-center">
          <p className="text-sm text-[#0c4470]/50">로그인하면 인증을 신청할 수 있어요.</p>
          <Link href="/login" className="mt-3 inline-block rounded-full bg-[#0095da] px-4 py-2 text-sm font-bold text-white">
            로그인하기
          </Link>
        </div>
      )}

      {session && (
        <>
          <section className="rounded-2xl bg-[#eef6fc] p-4">
            <p className="text-xs leading-relaxed text-[#0c4470]/60">
              이름·학번·증빙 서류로 재학 여부를 확인해요. 학번은 서버에서 한 방향으로
              변환해 저장하고 원문은 남기지 않아요. 서류는 심사가 끝나면 파기돼요.
            </p>
          </section>

          {active && (
            <section className="rounded-2xl bg-white p-4 shadow-sm">
              <p className="text-sm font-bold text-[#0c4470]">
                {active.status === "submitted" ? "심사 중이에요" : "제출이 끝나지 않았어요"}
              </p>
              <p className="mt-1 text-xs text-[#0c4470]/50">
                {DOC_TYPE_LABEL[active.doc_type] ?? active.doc_type} · {fmt(active.submitted_at)}
              </p>
              <button
                onClick={() => withdraw(active.id)}
                className="mt-3 w-full rounded-xl bg-[#f2f6fa] py-2.5 text-sm font-bold text-[#0c4470]/60"
              >
                신청 철회
              </button>
            </section>
          )}

          {!active && (
            <section className="rounded-2xl bg-white p-4 shadow-sm">
              <p className="text-xs font-bold text-[#0c4470]/40">어떤 서류인가요?</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {DOC_TYPES.map((d) => (
                  <button
                    key={d.code}
                    onClick={() => setDocType(d.code)}
                    className={`rounded-lg px-2.5 py-1.5 text-xs ${
                      docType === d.code
                        ? "bg-[#0095da] font-bold text-white"
                        : "bg-[#f2f6fa] text-[#0c4470]/70"}`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              {docType && (
                <p className="mt-1.5 text-[11px] text-[#0c4470]/40">
                  {DOC_TYPES.find((d) => d.code === docType)?.hint}
                </p>
              )}

              <input
                value={realName}
                onChange={(e) => setRealName(e.target.value)}
                maxLength={40}
                placeholder="이름 (서류와 같게)"
                className="mt-3 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
              />
              <input
                value={studentNo}
                onChange={(e) => setStudentNo(e.target.value)}
                inputMode="numeric"
                maxLength={10}
                placeholder="학번 8자리"
                className="mt-2 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
              />

              <label className="mt-2 flex cursor-pointer items-center justify-between rounded-xl bg-[#f2f6fa] px-3 py-2.5">
                <span className={`truncate text-sm ${file ? "text-[#0c4470]" : "text-[#0c4470]/35"}`}>
                  {file ? file.name : "증빙 파일 선택 (JPG·PNG·WebP·PDF)"}
                </span>
                <span className="ml-2 shrink-0 text-xs font-bold text-[#0095da]">찾기</span>
                <input type="file" accept={ACCEPT_MIME} onChange={pickFile} className="hidden" />
              </label>

              {notice && (
                <p className={`mt-2 text-xs ${
                  notice.type === "ok" ? "text-[#1c7a4a]" : "text-[#c0392b]"}`}>
                  {notice.text}
                </p>
              )}

              {stuckId ? (
                <button
                  onClick={retry}
                  disabled={busy}
                  className="mt-2 w-full rounded-xl bg-[#0095da] py-2.5 text-sm font-bold text-white disabled:opacity-40"
                >
                  {busy ? STEP_TEXT[step] : "제출 다시 시도"}
                </button>
              ) : (
                <button
                  onClick={send}
                  disabled={busy}
                  className="mt-2 w-full rounded-xl bg-[#0095da] py-2.5 text-sm font-bold text-white disabled:opacity-40"
                >
                  {busy ? STEP_TEXT[step] : "인증 신청"}
                </button>
              )}
            </section>
          )}

          <section className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="mb-2 text-xs font-bold text-[#0c4470]/40">신청 이력</p>
            {listLoading && <p className="py-3 text-center text-xs text-[#0c4470]/35">불러오는 중…</p>}
            {!listLoading && mine.length === 0 && (
              <p className="py-3 text-center text-xs text-[#0c4470]/35">아직 신청한 적이 없어요.</p>
            )}
            <ul className="flex flex-col gap-2.5">
              {mine.map((r) => (
                <li key={r.id} className="border-b border-black/5 pb-2.5 last:border-0 last:pb-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm text-[#0c4470]">
                      {DOC_TYPE_LABEL[r.doc_type] ?? r.doc_type}
                    </p>
                    <p className="shrink-0 text-[11px] font-bold text-[#0c4470]/45">
                      {REQUEST_STATUS_LABEL[r.status] ?? r.status}
                    </p>
                  </div>
                  <p className="mt-0.5 text-[11px] text-[#0c4470]/40">
                    {fmt(r.submitted_at ?? r.reviewed_at)}
                    {r.status === "rejected" && r.reject_reason_code
                      ? ` · ${REJECT_LABEL[r.reject_reason_code] ?? r.reject_reason_code}`
                      : ""}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
