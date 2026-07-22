"use client"; // 로그인 절차는 전부 브라우저에서

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase/client";
import { useAuth, signOut } from "../lib/identity/useAuth";

// 로그인 방식은 두 가지를 제공한다.
//  ① 비밀번호(기본) — 통상적인 아이디(이메일)+비밀번호. 한 번 가입하면 이후엔
//     메일 없이 바로 로그인된다(반복 메일·세션 드롭 불편 해소).
//  ② 메일 링크(대안) — 비밀번호 없이 메일의 로그인 링크만 누르는 방식.
//
// ⚠️ 보안 경계는 여기 화면이 아니라 DB 트리거(private.enforce_snue_email, 010)와
//    Supabase Auth 설정이다. 여기 검사는 UX 이지 잠금장치가 아니다.
// ⚠️ 신규 가입은 Supabase Auth 의 "Allow new users to sign up" 이 켜져 있어야 한다.
//    (임시로 꺼두면 회원가입이 거부된다 — 화면엔 안내만 뜬다.)
// ⚠️ 기존 매직링크 계정은 비밀번호가 없다 → "비밀번호를 잊으셨나요?"(재설정 메일)로
//    비밀번호를 처음 설정한 뒤 비번 로그인을 쓸 수 있다.
import { canSignUp, signUpBlockedMessage, signUpHint } from "../lib/authPolicy";

export default function LoginPage() {
  const router = useRouter();
  const { session, profile, setProfile, loading } = useAuth();

  const [method, setMethod] = useState("password"); // password | link
  const [mode, setMode] = useState("login");         // login | signup (password 방식)
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // {type: "error"|"info", text}
  const [sentKind, setSentKind] = useState(null); // 'link' | 'signup' | 'reset' | null
  const [recovery, setRecovery] = useState(false); // 비밀번호 재설정 링크로 들어온 상태

  // 재설정 메일의 링크로 들어오면 Supabase 가 PASSWORD_RECOVERY 이벤트를 준다.
  // 그때는 "새 비밀번호 설정" 폼을 띄운다.
  useEffect(() => {
    if (!supabase) return;
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

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

  // ── 비밀번호 재설정 링크로 진입 → 새 비밀번호 설정 ──
  if (recovery && session) {
    async function setNewPassword() {
      if (password.length < 6) { setMsg({ type: "error", text: "비밀번호는 6자 이상으로 정해주세요." }); return; }
      if (password !== password2) { setMsg({ type: "error", text: "비밀번호가 서로 달라요." }); return; }
      setBusy(true); setMsg(null);
      const { error } = await supabase.auth.updateUser({ password });
      setBusy(false);
      if (error) { setMsg({ type: "error", text: `설정에 실패했어요 (${error.message})` }); return; }
      setRecovery(false); setPassword(""); setPassword2("");
      setMsg({ type: "info", text: "새 비밀번호를 저장했어요. 이제 이 비밀번호로 로그인돼요." });
    }
    return (
      <Shell>
        <div className="rounded-2xl bg-white p-5 shadow-sm">
          <p className="text-sm font-bold text-[#0c4470]">새 비밀번호 설정</p>
          <p className="mt-1 text-xs text-[#0c4470]/50">앞으로 이 비밀번호로 로그인해요.</p>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="새 비밀번호 (6자 이상)" autoComplete="new-password"
            className="mt-3 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40" />
          <input type="password" value={password2} onChange={(e) => setPassword2(e.target.value)}
            placeholder="비밀번호 확인" autoComplete="new-password"
            className="mt-2 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40" />
          {msg && <Msg msg={msg} />}
          <button onClick={setNewPassword} disabled={busy}
            className="mt-3 w-full rounded-xl bg-[#0095da] py-2.5 text-sm font-bold text-white active:opacity-80 disabled:opacity-40">
            {busy ? "저장 중..." : "비밀번호 저장"}
          </button>
        </div>
      </Shell>
    );
  }

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
              onClick={async () => { await signOut(); resetForm(); }}
              className="rounded-xl bg-black/5 px-4 py-2.5 text-sm font-medium text-[#0c4470]/60">
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
      setBusy(true); setMsg(null);
      const { error } = await supabase.rpc("set_initial_nickname", { p_nick: nick });
      if (error) {
        setBusy(false);
        const dup = /nickname in use/i.test(error.message || "");
        setMsg({ type: "error",
          text: dup ? "이미 사용 중인 닉네임이에요. 다른 걸로 지어주세요." : `저장에 실패했어요 (${error.message})` });
        return;
      }
      const { data: rows } = await supabase.rpc("get_my_member");
      setBusy(false);
      setProfile(Array.isArray(rows) ? rows[0] ?? null : rows ?? null);
      router.push("/board");
    }
    return (
      <Shell>
        <div className="rounded-2xl bg-white p-5 shadow-sm">
          <p className="text-sm font-bold text-[#0c4470]">거의 다 됐어요 — 닉네임 만들기</p>
          <p className="mt-1 text-xs text-[#0c4470]/50">
            게시판에서 쓸 이름이에요. 실명 대신 별명을 추천해요. (나중에 설정에서 변경 가능)
          </p>
          <input value={nickname} onChange={(e) => setNickname(e.target.value)}
            placeholder="닉네임 (2~16자)" maxLength={16}
            className="mt-3 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40" />
          {msg && <Msg msg={msg} />}
          <button onClick={createProfile} disabled={busy}
            className="mt-3 w-full rounded-xl bg-[#0095da] py-2.5 text-sm font-bold text-white active:opacity-80 disabled:opacity-40">
            {busy ? "저장 중..." : "이 닉네임으로 시작하기"}
          </button>
        </div>
      </Shell>
    );
  }

  function resetForm() {
    setPassword(""); setPassword2(""); setSentKind(null); setMsg(null); setMode("login");
  }

  // ── 비밀번호 로그인 ──
  async function passwordLogin() {
    const em = email.trim();
    if (!em || !password) { setMsg({ type: "error", text: "이메일과 비밀번호를 입력해 주세요." }); return; }
    setBusy(true); setMsg(null);
    const { error } = await supabase.auth.signInWithPassword({ email: em, password });
    setBusy(false);
    if (error) {
      const m = String(error.message || "").toLowerCase();
      setMsg({ type: "error", text: /invalid login/.test(m)
        ? "이메일 또는 비밀번호가 맞지 않아요. (기존 메일링크로 가입했다면 아래 '비밀번호를 잊으셨나요?'로 먼저 설정해 주세요.)"
        : `로그인하지 못했어요 (${error.message})` });
      return;
    }
    // 세션이 잡히면 useAuth 가 감지해 닉네임/로그인 화면으로 전환된다.
  }

  // ── 비밀번호 회원가입 ──
  async function passwordSignup() {
    const em = email.trim();
    if (!canSignUp(em)) { setMsg({ type: "error", text: signUpBlockedMessage() }); return; }
    if (password.length < 6) { setMsg({ type: "error", text: "비밀번호는 6자 이상으로 정해주세요." }); return; }
    if (password !== password2) { setMsg({ type: "error", text: "비밀번호가 서로 달라요." }); return; }
    setBusy(true); setMsg(null);
    const { data, error } = await supabase.auth.signUp({
      email: em, password,
      options: { emailRedirectTo: `${window.location.origin}/login` },
    });
    setBusy(false);
    if (error) {
      const m = String(error.message || "").toLowerCase();
      setMsg({ type: "error", text: /signup.*disabled|not allowed/.test(m)
        ? "지금은 신규 가입이 잠시 막혀 있어요. 잠시 뒤 다시 시도해 주세요."
        : /already regist|exists/.test(m)
        ? "이미 가입된 이메일이에요. '로그인'으로 들어오거나 비밀번호를 재설정해 주세요."
        : `가입하지 못했어요 (${error.message})` });
      return;
    }
    // 이메일 확인이 켜져 있으면 session 이 아직 없다 → 확인 메일 안내.
    if (!data.session) { setSentKind("signup"); return; }
    // 확인이 꺼져 있으면 바로 로그인된다(useAuth 가 감지).
  }

  // ── 비밀번호 재설정 메일 ──
  async function sendReset() {
    const em = email.trim();
    if (!em) { setMsg({ type: "error", text: "이메일 주소를 먼저 입력해 주세요." }); return; }
    setBusy(true); setMsg(null);
    const { error } = await supabase.auth.resetPasswordForEmail(em, {
      redirectTo: `${window.location.origin}/login`,
    });
    setBusy(false);
    if (error) { setMsg({ type: "error", text: "메일을 보내지 못했어요. 잠시 뒤 다시 시도해 주세요." }); return; }
    setSentKind("reset");
  }

  // ── 메일 링크(매직링크) ──
  async function sendLink() {
    const em = email.trim();
    const allowed = canSignUp(em);
    setBusy(true); setMsg(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: em,
      options: { emailRedirectTo: `${window.location.origin}/login`, shouldCreateUser: allowed },
    });
    setBusy(false);
    if (error) {
      if (!allowed) { setMsg({ type: "error", text: signUpBlockedMessage() }); return; }
      const m = String(error.message || "").toLowerCase();
      const rateLimited = error.status === 429 || /rate limit|too many|exceeded/.test(m);
      setMsg({ type: "error", text: rateLimited
        ? "지금 메일 요청이 많아 잠시 막혔어요. 1~2분 뒤 다시 시도해 주세요. (스팸함도 확인!)"
        : "메일을 보내지 못했어요. 주소를 확인하고 잠시 뒤 다시 시도해 주세요." });
      return;
    }
    setSentKind("link");
  }

  // ── 메일 보냄 안내 화면 (링크/가입확인/재설정) ──
  if (sentKind) {
    const info = {
      link: { emoji: "📬", title: "로그인 메일을 보냈어요!", body: <>메일함에서 <b>&quot;로그인&quot; 링크</b>를 눌러주세요.</> },
      signup: { emoji: "✉️", title: "확인 메일을 보냈어요!", body: <>메일함의 <b>확인 링크</b>를 누르면 가입이 끝나요. 그다음부턴 이메일·비밀번호로 바로 로그인돼요.</> },
      reset: { emoji: "🔑", title: "재설정 메일을 보냈어요!", body: <>메일의 <b>재설정 링크</b>를 누르면 새 비밀번호를 정할 수 있어요.</> },
    }[sentKind];
    return (
      <Shell>
        <div className="rounded-2xl bg-white p-5 shadow-sm">
          <p className="text-2xl">{info.emoji}</p>
          <p className="mt-1 text-sm font-bold text-[#0c4470]">{info.title}</p>
          <p className="mt-1 text-xs leading-relaxed text-[#0c4470]/55">
            <b>{email}</b> — {info.body} 지금 이 기기에서 열어야 이 브라우저로 로그인돼요. 메일이 안 보이면 스팸함도 확인!
          </p>
          {msg && <Msg msg={msg} />}
          <button onClick={resetForm} className="mt-3 w-full py-1 text-xs font-medium text-[#0c4470]/40">
            ‹ 처음으로
          </button>
        </div>
      </Shell>
    );
  }

  // ── 비로그인: 로그인/가입 폼 ──
  return (
    <Shell>
      {/* 방식 탭 */}
      <div className="flex gap-1.5">
        {[["password", "비밀번호"], ["link", "메일 링크"]].map(([k, label]) => (
          <button key={k} onClick={() => { setMethod(k); setMsg(null); }}
            className={`flex-1 rounded-xl py-2 text-sm font-bold ${
              method === k ? "bg-[#0095da] text-white" : "bg-[#f2f6fa] text-[#0c4470]/60"}`}>
            {label}
          </button>
        ))}
      </div>

      <div className="rounded-2xl bg-white p-5 shadow-sm">
        {method === "password" ? (
          <>
            {/* 로그인/가입 토글 */}
            <div className="mb-3 flex gap-3 text-sm">
              {[["login", "로그인"], ["signup", "회원가입"]].map(([k, label]) => (
                <button key={k} onClick={() => { setMode(k); setMsg(null); }}
                  className={`font-bold ${mode === k ? "text-[#0095da]" : "text-[#0c4470]/35"}`}>
                  {label}
                </button>
              ))}
            </div>
            <input value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="이메일 주소" type="email" inputMode="email" autoComplete="email"
              className="w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40" />
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="비밀번호" autoComplete={mode === "signup" ? "new-password" : "current-password"}
              onKeyDown={(e) => e.key === "Enter" && mode === "login" && passwordLogin()}
              className="mt-2 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40" />
            {mode === "signup" && (
              <input type="password" value={password2} onChange={(e) => setPassword2(e.target.value)}
                placeholder="비밀번호 확인" autoComplete="new-password"
                className="mt-2 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40" />
            )}
            {mode === "signup" && (
              <p className="mt-2 text-[11px] text-[#0c4470]/45">{signUpHint()}</p>
            )}
            {msg && <Msg msg={msg} />}
            <button onClick={mode === "login" ? passwordLogin : passwordSignup} disabled={busy}
              className="mt-3 w-full rounded-xl bg-[#0095da] py-2.5 text-sm font-bold text-white active:opacity-80 disabled:opacity-40">
              {busy ? "처리 중..." : mode === "login" ? "로그인" : "가입하기"}
            </button>
            {mode === "login" && (
              <button onClick={sendReset} disabled={busy}
                className="mt-2 w-full py-1 text-xs font-medium text-[#0c4470]/45">
                비밀번호를 잊으셨나요? (재설정 메일)
              </button>
            )}
          </>
        ) : (
          <>
            <p className="text-sm font-bold text-[#0c4470]">메일 링크로 로그인</p>
            <p className="mt-1 text-xs text-[#0c4470]/50">
              비밀번호 없이 메일로 오는 링크만 누르면 끝. {signUpHint()}
            </p>
            <input value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="이메일 주소" type="email" inputMode="email" autoComplete="email"
              className="mt-3 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40" />
            {msg && <Msg msg={msg} />}
            <button onClick={sendLink} disabled={busy}
              className="mt-3 w-full rounded-xl bg-[#0095da] py-2.5 text-sm font-bold text-white active:opacity-80 disabled:opacity-40">
              {busy ? "보내는 중..." : "로그인 링크 받기"}
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
