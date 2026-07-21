"use client";

import { useState } from "react";
import {
  VOTE, REPORT_REASONS, votePost, toggleBookmark, submitReport,
} from "../lib/community/interactions";

// 글 하단 상호작용 바 — 추천·반대·스크랩·신고.
//
// 서버 반환값을 그대로 화면에 반영한다. 낙관적 갱신을 하지 않는 이유는
// 추천이 토글이라 서버가 계산한 결과와 화면 추측이 어긋나기 쉽고,
// 어긋나면 사용자가 두 번 눌러야 맞는 상태가 되기 때문이다.
//
// 각 RPC 는 실패해도 예외를 던지지 않고 { data, error } 를 돌려준다.

export default function PostActions({ postId, initialVoteCount = 0 }) {
  const [voteCount, setVoteCount] = useState(initialVoteCount);
  const [myVote, setMyVote] = useState(0);
  const [bookmarked, setBookmarked] = useState(false);
  const [busy, setBusy] = useState(null);
  const [reporting, setReporting] = useState(false);
  const [reasonCode, setReasonCode] = useState(null);
  const [detail, setDetail] = useState("");
  const [notice, setNotice] = useState(null);

  async function vote(value) {
    // 같은 값을 다시 누르면 취소. DB 도 같은 규칙이라 여기서 미리 계산해 보낸다.
    const next = myVote === value ? VOTE.CANCEL : value;
    setBusy("vote");
    const { data, error } = await votePost(postId, next);
    setBusy(null);
    if (error) { setNotice(msgOf(error)); return; }
    // 반환 jsonb 의 필드명이 구현마다 다를 수 있어 방어적으로 읽는다.
    if (data && typeof data === "object") {
      if (typeof data.vote_count === "number") setVoteCount(data.vote_count);
      else if (typeof data.count === "number") setVoteCount(data.count);
      if (typeof data.my_value === "number") setMyVote(data.my_value);
      else setMyVote(next);
    } else setMyVote(next);
    setNotice(null);
  }

  async function bookmark() {
    setBusy("bookmark");
    const { data, error } = await toggleBookmark(postId);
    setBusy(null);
    if (error) { setNotice(msgOf(error)); return; }
    const on = data && typeof data === "object" && typeof data.bookmarked === "boolean"
      ? data.bookmarked : !bookmarked;
    setBookmarked(on);
    setNotice({ type: "ok", text: on ? "스크랩했어요." : "스크랩을 해제했어요." });
  }

  async function report() {
    setBusy("report");
    const { error } = await submitReport({
      targetType: "post", targetId: postId, reasonCode, detail,
    });
    setBusy(null);
    if (error) { setNotice(msgOf(error)); return; }
    setReporting(false);
    setReasonCode(null);
    setDetail("");
    setNotice({ type: "ok", text: "신고했어요. 운영자가 확인할게요." });
  }

  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <button
          onClick={() => vote(VOTE.UP)}
          disabled={busy === "vote"}
          className={`flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-bold disabled:opacity-40 ${
            myVote === VOTE.UP ? "bg-[#0095da] text-white" : "bg-[#f2f6fa] text-[#0c4470]/70"}`}
        >
          <span>👍</span><span>{voteCount}</span>
        </button>
        <button
          onClick={() => vote(VOTE.DOWN)}
          disabled={busy === "vote"}
          className={`rounded-xl px-3 py-2 text-sm font-bold disabled:opacity-40 ${
            myVote === VOTE.DOWN ? "bg-[#d05b6a] text-white" : "bg-[#f2f6fa] text-[#0c4470]/70"}`}
        >
          👎
        </button>
        <button
          onClick={bookmark}
          disabled={busy === "bookmark"}
          className={`rounded-xl px-3 py-2 text-sm font-bold disabled:opacity-40 ${
            bookmarked ? "bg-[#fff5e5] text-[#b8860b]" : "bg-[#f2f6fa] text-[#0c4470]/70"}`}
        >
          {bookmarked ? "★ 스크랩됨" : "☆ 스크랩"}
        </button>
        <button
          onClick={() => setReporting((v) => !v)}
          className="ml-auto text-xs font-bold text-[#0c4470]/40"
        >
          신고
        </button>
      </div>

      {notice && (
        <p className={`mt-2 text-xs ${
          notice.type === "ok" ? "text-[#1c7a4a]" : "text-[#c0392b]"}`}>
          {notice.text}
        </p>
      )}

      {reporting && (
        <div className="mt-3 border-t border-black/5 pt-3">
          <p className="text-xs font-bold text-[#0c4470]">신고 사유</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {REPORT_REASONS.map((r) => (
              <button
                key={r.code}
                onClick={() => setReasonCode(r.code)}
                className={`rounded-lg px-2.5 py-1.5 text-xs ${
                  reasonCode === r.code
                    ? "bg-[#0095da] font-bold text-white"
                    : "bg-[#f2f6fa] text-[#0c4470]/70"}`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="자세한 내용 (선택, 500자까지)"
            className="mt-2 w-full resize-none rounded-xl bg-[#f2f6fa] px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
          />
          <div className="mt-2 flex gap-2">
            <button
              disabled={!reasonCode || busy === "report"}
              onClick={report}
              className="flex-1 rounded-xl bg-[#d05b6a] py-2 text-sm font-bold text-white disabled:opacity-40"
            >
              {busy === "report" ? "보내는 중…" : "신고하기"}
            </button>
            <button
              onClick={() => setReporting(false)}
              className="rounded-xl bg-[#f2f6fa] px-4 py-2 text-sm font-bold text-[#0c4470]/60"
            >
              취소
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** DB 가 던지는 메시지를 사용자 말로 바꾼다. 모르는 것은 그대로 보여준다. */
function msgOf(error) {
  const m = error?.message ?? "";
  if (/not allowed/i.test(m)) return { type: "error", text: "인증을 마친 회원만 할 수 있어요." };
  if (/already/i.test(m)) return { type: "error", text: "이미 처리된 요청이에요." };
  return { type: "error", text: `처리하지 못했어요 (${m})` };
}
