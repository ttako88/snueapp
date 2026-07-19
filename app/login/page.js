"use client"; // 로그인 절차는 전부 브라우저에서 (비밀번호 없음 — 이메일 로그인링크 방식)

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth, signOut } from "../lib/useAuth";

// 이메일 → 메일의 로그인 링크 클릭 → (첫 가입이면) 닉네임 만들기.
// 비밀번호를 아예 안 받으므로 유출·재사용 걱정이 없음. 세션은 supabase-js가
// 브라우저에 보관하고 자동 갱신함.
// (기본 메일 템플릿이 6자리 코드 없이 링크만 보내는 구조라 링크 방식 채택.
//  나중에 커스텀 SMTP를 붙이면 코드 입력 방식으로 바꿀 수 있음.)
//
// 학교 이메일 검사는 여기서도 미리 하지만(불필요한 메일 발송 방지용 UX),
// 진짜 잠금장치는 DB 트리거(enforce_snue_email, supabase/migrations/002_*.sql)다 —
// 여기 정규식만 믿으면 API를 직접 호출해 우회할 수 있으므로 반드시 서버(DB)에서도 막아야 함.
const SNUE_EMAIL_RE = /^[^\s@]+@([a-zA-Z0-9-]+\.)*snue\.ac\.kr$/;

export default function LoginPage() {
  const router = useRouter();
  const { session, profile, setProfile, loading } = useAuth();

  const [step, setStep] = useState("email"); // email | sent
  const [email, setEmail] = useState("");
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // {type: "error"|"info", text}

  if (!supabase) {
    return (
      <Shell>
        <p className="py-8 text-center text-sm text-[#0c4470]/50">
          서버 연결 설정이 아직 준비되지 않았어요.
        </p>
      </Shell>
    );
  }
  if (loading) return null;

  // ── 이미 로그인됨 ──
  if (session && profile) {
    return (
      <Shell>
        <div className="rounded-2xl bg-white p-5 text-center shadow-sm">
          <p className="text-2xl">🎉</p>
          <p className="mt-1 text-sm font-bold text-[#0c4470]">{profile.nickname}님, 로그인되어 있어요</p>
          <p className="mt-0.5 text-xs text-[#0c4470]/50">{session.user.email}</p>
          <div className="mt-4 flex gap-2">
            <button
              onClick={async () => {
                await signOut();
                setStep("email");
              }}
              className="rounded-xl bg-black/5 px-4 py-2.5 text-sm font-medium text-[#0c4470]/60"
            >
              로그아웃
            </button>
            <Link href="/board" className="flex-1 rounded-xl bg-[#0095da] py-2.5 text-center text-sm font-bold text-white">
              게시판으로 가기
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  // ── 로그인됐지만 닉네임이 아직 없음 → 닉네임 만들기 ──
  if (session && !profile) {
    async function createProfile() {
      const nick = nickname.trim();
      if (nick.length < 2 || nick.length > 16) {
        setMsg({ type: "error", text: "닉네임은 2~16자로 지어주세요." });
        return;
      }
      setBusy(true);
      setMsg(null);
      const { data, error } = await supabase
        .from("profiles")
        .insert({ id: session.user.id, nickname: nick })
        .select()
        .single();
      setBusy(false);
      if (error) {
        setMsg({
          type: "error",
          text: error.code === "23505" ? "이미 사용 중인 닉네임이에요. 다른 걸로 지어주세요." : `저장에 실패했어요 (${error.message})`,
        });
        return;
      }
      setProfile(data);
      router.push("/board");
    }
    return (
      <Shell>
        <div className="rounded-2xl bg-white p-5 shadow-sm">
          <p className="text-sm font-bold text-[#0c4470]">거의 다 됐어요 — 닉네임 만들기</p>
          <p className="mt-1 text-xs text-[#0c4470]/50">
            게시판에서 쓸 이름이에요. 실명 대신 별명을 추천해요. (나중에 설정에서 변경 가능)
          </p>
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="닉네임 (2~16자)"
            maxLength={16}
            className="mt-3 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
          />
          {msg && <Msg msg={msg} />}
          <button
            onClick={createProfile}
            disabled={busy}
            className="mt-3 w-full rounded-xl bg-[#0095da] py-2.5 text-sm font-bold text-white active:opacity-80 disabled:opacity-40"
          >
            {busy ? "저장 중..." : "이 닉네임으로 시작하기"}
          </button>
        </div>
      </Shell>
    );
  }

  // ── 비로그인: 이메일 → 로그인 링크 메일 ──
  async function sendLink() {
    const em = email.trim();
    if (!SNUE_EMAIL_RE.test(em)) {
      setMsg({ type: "error", text: "서울교대 이메일(@snue.ac.kr 계열)만 가입할 수 있어요." });
      return;
    }
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: em,
      options: { emailRedirectTo: `${window.location.origin}/login` },
    });
    setBusy(false);
    if (error) {
      setMsg({ type: "error", text: `메일 발송에 실패했어요 (${error.message})` });
      return;
    }
    setStep("sent");
  }

  return (
    <Shell>
      <div className="rounded-2xl bg-white p-5 shadow-sm">
        {step === "email" ? (
          <>
            <p className="text-sm font-bold text-[#0c4470]">이메일로 간편 로그인</p>
            <p className="mt-1 text-xs text-[#0c4470]/50">
              비밀번호가 없어요 — 메일로 오는 로그인 링크만 누르면 끝. 처음이면 자동으로 가입돼요.
            </p>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="이메일 주소"
              type="email"
              inputMode="email"
              className="mt-3 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
            />
            {msg && <Msg msg={msg} />}
            <button
              onClick={sendLink}
              disabled={busy}
              className="mt-3 w-full rounded-xl bg-[#0095da] py-2.5 text-sm font-bold text-white active:opacity-80 disabled:opacity-40"
            >
              {busy ? "보내는 중..." : "로그인 링크 받기"}
            </button>
          </>
        ) : (
          <>
            <p className="text-2xl">📬</p>
            <p className="mt-1 text-sm font-bold text-[#0c4470]">메일을 보냈어요!</p>
            <p className="mt-1 text-xs leading-relaxed text-[#0c4470]/55">
              <b>{email}</b> 메일함에서 <b>"Sign in"(로그인) 링크</b>를 눌러주세요.
              지금 이 기기에서 열어야 이 브라우저로 로그인돼요. 메일이 안 보이면 스팸함도 확인!
            </p>
            {msg && <Msg msg={msg} />}
            <button
              onClick={() => {
                setStep("email");
                setMsg(null);
              }}
              className="mt-3 w-full py-1 text-xs font-medium text-[#0c4470]/40"
            >
              ‹ 이메일 다시 입력
            </button>
          </>
        )}
      </div>
      <p className="mt-3 text-center text-[11px] leading-relaxed text-[#0c4470]/35">
        이메일은 로그인 확인 용도로만 쓰이고 다른 사용자에게 공개되지 않아요.
      </p>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center gap-2">
        <Link href="/board" className="text-[#0c4470]/50">‹ 게시판</Link>
        <h2 className="text-lg font-bold text-[#0c4470]">로그인</h2>
      </div>
      {children}
    </div>
  );
}

function Msg({ msg }) {
  return (
    <p className={`mt-2 rounded-lg px-3 py-2 text-xs ${msg.type === "error" ? "bg-[#fdecec] text-[#d05b6a]" : "bg-[#eaf6fd] text-[#0c4470]/70"}`}>
      {msg.text}
    </p>
  );
}
