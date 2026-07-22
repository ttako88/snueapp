"use client"; // 로그인·회원가입 절차는 전부 브라우저에서

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase/client";
import { useAuth, signOut } from "../lib/identity/useAuth";
import {
  checkUsername, checkNickname, checkHakbeon, submitSignup, loginWithUsername,
} from "../lib/identity/signupClient";
import { canSignUp, signUpBlockedMessage, signUpHint } from "../lib/authPolicy";

// 로그인 방식
//  ① 아이디+비밀번호(기본) — 통상적 회원가입/로그인. 한 번 가입하면 이후 메일 없이 로그인.
//  ② 메일 링크(대안) — 기존 매직링크 사용자 호환.
// ⚠️ 학번 원문은 서버 라우트 안에서만 다룬다(HMAC 만 저장). 여긴 원문을 잠깐 입력받아
//    확인 라우트로 보낼 뿐, 저장·노출하지 않는다.

const SIGNUP_ERR = {
  hakbeon_consent_required: "학번 수집·이용에 동의해야 가입할 수 있어요.",
  username_format: "아이디는 영문·숫자·_ 4~20자로 지어주세요.",
  username_taken: "이미 사용 중인 아이디예요.",
  email_format: "이메일 형식을 확인해 주세요.",
  email_taken: "이미 가입된 이메일이에요.",
  password_format: "비밀번호는 6자 이상으로 정해주세요.",
  nickname_format: "닉네임은 2~16자로 지어주세요.",
  nickname_taken: "이미 사용 중인 닉네임이에요.",
  hakbeon_taken: "이미 가입된 학번이에요. 한 사람당 한 계정만 만들 수 있어요.",
  student_no_format: "학번 형식이 올바르지 않아요(8자리).",
  student_no_year: "학번의 입학년도가 올바르지 않아요.",
  server_config: "서버 설정 문제로 지금은 가입할 수 없어요. 잠시 뒤 다시 시도해 주세요.",
  signup_failed: "가입하지 못했어요. 잠시 뒤 다시 시도해 주세요.",
  network: "연결이 끊겼어요. 잠시 뒤 다시 시도해 주세요.",
};

export default function LoginPage() {
  const router = useRouter();
  const { session, profile, setProfile, loading } = useAuth();

  const [method, setMethod] = useState("password"); // password | link
  const [mode, setMode] = useState("login");         // login | signup
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [sentKind, setSentKind] = useState(null); // 'link' | 'reset'
  const [recovery, setRecovery] = useState(false);

  // 로그인 입력
  const [loginId, setLoginId] = useState("");
  const [loginPw, setLoginPw] = useState("");
  const [linkEmail, setLinkEmail] = useState("");

  // 가입 입력
  const [su, setSu] = useState({ username: "", email: "", password: "", password2: "", hakbeon: "", nickname: "" });
  const [hakbeonConsent, setHakbeonConsent] = useState(false);
  const [analyticsConsent, setAnalyticsConsent] = useState(false);
  const setField = (k, v) => setSu((s) => ({ ...s, [k]: v }));

  // 실시간 중복확인 (아이디·닉네임·학번)
  const uAvail = useAvailability(su.username, checkUsername, (v) => /^[A-Za-z0-9_]{4,20}$/.test(v));
  const nAvail = useAvailability(su.nickname, checkNickname, (v) => v.trim().length >= 2 && v.trim().length <= 16);
  const hAvail = useAvailability(su.hakbeon, checkHakbeon, (v) => /^\d{8}$/.test(v.replace(/[\s-]/g, "")));

  useEffect(() => {
    if (!supabase) return;
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!supabase) {
    return <Shell><p className="py-8 text-center text-sm text-[#0c4470]/50">서버 연결 설정이 아직 준비되지 않았어요.</p></Shell>;
  }
  if (loading) return null;

  // ── 비밀번호 재설정 링크 진입 → 새 비밀번호 ──
  if (recovery && session) {
    async function setNewPassword() {
      if (loginPw.length < 6) { setMsg({ type: "error", text: "비밀번호는 6자 이상으로 정해주세요." }); return; }
      setBusy(true); setMsg(null);
      const { error } = await supabase.auth.updateUser({ password: loginPw });
      setBusy(false);
      if (error) { setMsg({ type: "error", text: `설정에 실패했어요 (${error.message})` }); return; }
      setRecovery(false); setLoginPw("");
      setMsg({ type: "info", text: "새 비밀번호를 저장했어요." });
    }
    return (
      <Shell>
        <div className="rounded-2xl bg-white p-5 shadow-sm">
          <p className="text-sm font-bold text-[#0c4470]">새 비밀번호 설정</p>
          <input type="password" value={loginPw} onChange={(e) => setLoginPw(e.target.value)}
            placeholder="새 비밀번호 (6자 이상)" autoComplete="new-password"
            className="mt-3 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40" />
          {msg && <Msg msg={msg} />}
          <button onClick={setNewPassword} disabled={busy}
            className="mt-3 w-full rounded-xl bg-[#0095da] py-2.5 text-sm font-bold text-white disabled:opacity-40">
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
            <button onClick={async () => { await signOut(); }}
              className="rounded-xl bg-black/5 px-4 py-2.5 text-sm font-medium text-[#0c4470]/60">로그아웃</button>
            <Link href="/board" className="flex-1 rounded-xl bg-[#0095da] py-2.5 text-center text-sm font-bold text-white">게시판으로 가기</Link>
          </div>
        </div>
      </Shell>
    );
  }

  // ── 로그인됐지만 닉네임 없음(매직링크 등 구경로) → 닉네임 만들기 ──
  if (session && !profile) {
    async function createProfile() {
      const nick = (su.nickname || "").trim();
      if (nick.length < 2 || nick.length > 16) { setMsg({ type: "error", text: "닉네임은 2~16자로 지어주세요." }); return; }
      setBusy(true); setMsg(null);
      const { error } = await supabase.rpc("set_initial_nickname", { p_nick: nick });
      if (error) {
        setBusy(false);
        const dup = /nickname in use/i.test(error.message || "");
        setMsg({ type: "error", text: dup ? "이미 사용 중인 닉네임이에요." : `저장에 실패했어요 (${error.message})` });
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
          <input value={su.nickname} onChange={(e) => setField("nickname", e.target.value)}
            placeholder="닉네임 (2~16자)" maxLength={16}
            className="mt-3 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40" />
          {msg && <Msg msg={msg} />}
          <button onClick={createProfile} disabled={busy}
            className="mt-3 w-full rounded-xl bg-[#0095da] py-2.5 text-sm font-bold text-white disabled:opacity-40">
            {busy ? "저장 중..." : "이 닉네임으로 시작하기"}
          </button>
        </div>
      </Shell>
    );
  }

  // ── 아이디 로그인 ──
  async function doLogin() {
    if (!loginId.trim() || !loginPw) { setMsg({ type: "error", text: "아이디와 비밀번호를 입력해 주세요." }); return; }
    setBusy(true); setMsg(null);
    const { ok, error } = await loginWithUsername(loginId.trim(), loginPw);
    setBusy(false);
    if (!ok) setMsg({ type: "error", text: error === "invalid_login" ? "아이디 또는 비밀번호가 맞지 않아요." : "로그인하지 못했어요. 잠시 뒤 다시 시도해 주세요." });
    // ok 면 useAuth 가 세션을 감지해 화면 전환.
  }

  // ── 회원가입 ──
  async function doSignup() {
    if (!hakbeonConsent) { setMsg({ type: "error", text: SIGNUP_ERR.hakbeon_consent_required }); return; }
    if (!canSignUp(su.email.trim())) { setMsg({ type: "error", text: signUpBlockedMessage() }); return; }
    if (su.password.length < 6) { setMsg({ type: "error", text: SIGNUP_ERR.password_format }); return; }
    if (su.password !== su.password2) { setMsg({ type: "error", text: "비밀번호가 서로 달라요." }); return; }
    if (uAvail !== true) { setMsg({ type: "error", text: "아이디 중복확인을 통과해야 해요." }); return; }
    if (nAvail !== true) { setMsg({ type: "error", text: "닉네임 중복확인을 통과해야 해요." }); return; }
    if (hAvail !== true) { setMsg({ type: "error", text: "학번 확인을 통과해야 해요." }); return; }

    setBusy(true); setMsg(null);
    const r = await submitSignup({
      username: su.username, email: su.email.trim(), password: su.password,
      hakbeon: su.hakbeon, nickname: su.nickname.trim(),
      hakbeonConsent: true, analyticsConsent,
    });
    if (r.error) { setBusy(false); setMsg({ type: "error", text: SIGNUP_ERR[r.error] || SIGNUP_ERR.signup_failed }); return; }
    // 가입 성공 → 바로 아이디로 로그인해 세션 확보.
    const lg = await loginWithUsername(su.username, su.password);
    setBusy(false);
    if (!lg.ok) { setMsg({ type: "info", text: "가입됐어요! 이제 아이디·비밀번호로 로그인해 주세요." }); setMode("login"); setLoginId(su.username); return; }
    // 로그인되면 useAuth 가 감지 → 닉네임은 가입 때 이미 설정됨 → 게시판.
  }

  // 전체동의 = 학번(필수)+통계(선택) 둘 다
  const allConsent = hakbeonConsent && analyticsConsent;
  const toggleAll = () => { const v = !allConsent; setHakbeonConsent(v); setAnalyticsConsent(v); };

  // ── 매직링크 ──
  async function sendLink() {
    const em = linkEmail.trim();
    const allowed = canSignUp(em);
    setBusy(true); setMsg(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: em, options: { emailRedirectTo: `${window.location.origin}/login`, shouldCreateUser: allowed },
    });
    setBusy(false);
    if (error) {
      if (!allowed) { setMsg({ type: "error", text: signUpBlockedMessage() }); return; }
      setMsg({ type: "error", text: "메일을 보내지 못했어요. 잠시 뒤 다시 시도해 주세요." });
      return;
    }
    setSentKind("link");
  }
  async function sendReset() {
    if (!su.email.trim() && !loginId.trim()) { setMsg({ type: "error", text: "가입한 이메일을 입력해 주세요." }); return; }
    const em = su.email.trim() || linkEmail.trim();
    if (!em) { setMsg({ type: "error", text: "가입한 이메일을 입력해 주세요(메일 링크 탭에서)." }); return; }
    setBusy(true); setMsg(null);
    const { error } = await supabase.auth.resetPasswordForEmail(em, { redirectTo: `${window.location.origin}/login` });
    setBusy(false);
    if (error) { setMsg({ type: "error", text: "메일을 보내지 못했어요." }); return; }
    setSentKind("reset");
  }

  if (sentKind) {
    const info = {
      link: { emoji: "📬", title: "로그인 메일을 보냈어요!" },
      reset: { emoji: "🔑", title: "재설정 메일을 보냈어요!" },
    }[sentKind];
    return (
      <Shell>
        <div className="rounded-2xl bg-white p-5 shadow-sm">
          <p className="text-2xl">{info.emoji}</p>
          <p className="mt-1 text-sm font-bold text-[#0c4470]">{info.title}</p>
          <p className="mt-1 text-xs leading-relaxed text-[#0c4470]/55">메일함의 링크를 눌러주세요. 안 보이면 스팸함도 확인!</p>
          <button onClick={() => { setSentKind(null); setMsg(null); }} className="mt-3 w-full py-1 text-xs font-medium text-[#0c4470]/40">‹ 처음으로</button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex gap-1.5">
        {[["password", "아이디"], ["link", "메일 링크"]].map(([k, label]) => (
          <button key={k} onClick={() => { setMethod(k); setMsg(null); }}
            className={`flex-1 rounded-xl py-2 text-sm font-bold ${method === k ? "bg-[#0095da] text-white" : "bg-[#f2f6fa] text-[#0c4470]/60"}`}>{label}</button>
        ))}
      </div>

      <div className="rounded-2xl bg-white p-5 shadow-sm">
        {method === "password" ? (
          <>
            <div className="mb-3 flex gap-3 text-sm">
              {[["login", "로그인"], ["signup", "회원가입"]].map(([k, label]) => (
                <button key={k} onClick={() => { setMode(k); setMsg(null); }}
                  className={`font-bold ${mode === k ? "text-[#0095da]" : "text-[#0c4470]/35"}`}>{label}</button>
              ))}
            </div>

            {mode === "login" ? (
              <>
                <input value={loginId} onChange={(e) => setLoginId(e.target.value)} placeholder="아이디" autoComplete="username"
                  className="w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40" />
                <input type="password" value={loginPw} onChange={(e) => setLoginPw(e.target.value)} placeholder="비밀번호" autoComplete="current-password"
                  onKeyDown={(e) => e.key === "Enter" && doLogin()}
                  className="mt-2 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40" />
                {msg && <Msg msg={msg} />}
                <button onClick={doLogin} disabled={busy}
                  className="mt-3 w-full rounded-xl bg-[#0095da] py-2.5 text-sm font-bold text-white disabled:opacity-40">{busy ? "로그인 중..." : "로그인"}</button>
                <button onClick={sendReset} disabled={busy} className="mt-2 w-full py-1 text-xs font-medium text-[#0c4470]/45">비밀번호를 잊으셨나요? (재설정 메일 — 메일 링크 탭에서 이메일 입력)</button>
              </>
            ) : (
              <>
                <FieldWithCheck label="아이디" value={su.username} onChange={(v) => setField("username", v)}
                  placeholder="영문·숫자·_ 4~20자" autoComplete="username" avail={uAvail}
                  okText="가입 가능한 아이디입니다" takenText="이미 사용 중인 아이디입니다" formatText="아이디 형식(영문·숫자·_ 4~20자)을 확인해 주세요" />
                <input value={su.email} onChange={(e) => setField("email", e.target.value)} placeholder="이메일 (실계정 인증·아이디/비번 찾기용)"
                  type="email" inputMode="email" autoComplete="email"
                  className="mt-2 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40" />
                <input type="password" value={su.password} onChange={(e) => setField("password", e.target.value)} placeholder="비밀번호 (6자 이상)" autoComplete="new-password"
                  className="mt-2 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40" />
                <input type="password" value={su.password2} onChange={(e) => setField("password2", e.target.value)} placeholder="비밀번호 확인" autoComplete="new-password"
                  className="mt-2 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40" />
                <FieldWithCheck label="학번" value={su.hakbeon} onChange={(v) => setField("hakbeon", v)}
                  placeholder="학번 8자리" inputMode="numeric" avail={hAvail}
                  okText="가입 가능한 학번입니다" takenText="이미 가입된 학번입니다" formatText="학번 형식(8자리)을 확인해 주세요" />
                <p className="mt-1 text-[11px] leading-relaxed text-[#0c4470]/40">
                  입력한 학번은 <b className="text-[#0c4470]/55">추후 재학생 인증 서류의 정보와 대조</b>됩니다.
                  정보가 다를 경우 재학생 인증 및 일부 서비스 이용이 제한될 수 있어요.
                </p>
                <FieldWithCheck label="닉네임" value={su.nickname} onChange={(v) => setField("nickname", v)}
                  placeholder="닉네임 (2~16자)" avail={nAvail}
                  okText="사용 가능한 닉네임입니다" takenText="이미 사용 중인 닉네임입니다" formatText="닉네임은 2~16자예요" />

                {/* 동의 */}
                <div className="mt-3 rounded-xl bg-[#f7fafc] p-3">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={allConsent} onChange={toggleAll} className="h-4 w-4 accent-[#0095da]" />
                    <span className="text-xs font-bold text-[#0c4470]">전체 동의</span>
                  </label>
                  <div className="mt-2 flex flex-col gap-2 border-t border-black/5 pt-2">
                    <label className="flex items-start gap-2">
                      <input type="checkbox" checked={hakbeonConsent} onChange={(e) => setHakbeonConsent(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#0095da]" />
                      <span className="text-[11px] leading-relaxed text-[#0c4470]/70">
                        <b>[필수]</b> 학번은 <b>서울교대 재학생 확인</b>과 <b>1인 1계정(중복가입 방지)</b>에만 쓰여요.
                        입력한 학번은 <b>단방향 암호화(해시)되어 저장</b>되고 <b>원문은 보관하지 않아요.</b> 다른 용도·제3자 제공 없어요.
                      </span>
                    </label>
                    <label className="flex items-start gap-2">
                      <input type="checkbox" checked={analyticsConsent} onChange={(e) => setAnalyticsConsent(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#0095da]" />
                      <span className="text-[11px] leading-relaxed text-[#0c4470]/70">
                        <b>[선택]</b> 더 나은 서비스를 위해 <b>가명 처리된 학과·학년 단위 통계</b>에만 활용해요. 개인 식별 저장 없고(5명 미만 비공개),
                        언제든 설정에서 철회 가능해요. 동의 안 해도 모든 기능 그대로 써요.
                      </span>
                    </label>
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-[#0c4470]/45">{signUpHint()}</p>
                {msg && <Msg msg={msg} />}
                <button onClick={doSignup} disabled={busy}
                  className="mt-3 w-full rounded-xl bg-[#0095da] py-2.5 text-sm font-bold text-white disabled:opacity-40">{busy ? "가입 중..." : "가입하기"}</button>
              </>
            )}
          </>
        ) : (
          <>
            <p className="text-sm font-bold text-[#0c4470]">메일 링크로 로그인</p>
            <p className="mt-1 text-xs text-[#0c4470]/50">비밀번호 없이 메일 링크만 누르면 끝. {signUpHint()}</p>
            <input value={linkEmail} onChange={(e) => setLinkEmail(e.target.value)} placeholder="이메일 주소" type="email" inputMode="email" autoComplete="email"
              className="mt-3 w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40" />
            {msg && <Msg msg={msg} />}
            <button onClick={sendLink} disabled={busy}
              className="mt-3 w-full rounded-xl bg-[#0095da] py-2.5 text-sm font-bold text-white disabled:opacity-40">{busy ? "보내는 중..." : "로그인 링크 받기"}</button>
          </>
        )}
      </div>
      <p className="mt-3 text-center text-[11px] leading-relaxed text-[#0c4470]/35">이메일은 로그인 확인·계정 찾기 용도로만 쓰이고 다른 사용자에게 공개되지 않아요.</p>
    </Shell>
  );
}

// 값이 바뀌면 450ms 뒤 checkFn 으로 중복확인. setState 는 전부 콜백 안에서만.
function useAvailability(value, checkFn, validate) {
  const [state, setState] = useState(null); // null | 'checking' | true | false | 'format'
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      if (!alive) return;
      const v = (value || "").trim();
      if (!v) { setState(null); return; }
      if (validate && !validate(v)) { setState("format"); return; }
      setState("checking");
      const r = await checkFn(v);
      if (!alive) return;
      if (r?.reason === "student_no_format" || r?.reason === "student_no_year") setState("format");
      else setState(r?.available === true ? true : false);
    }, 450);
    return () => { alive = false; clearTimeout(t); };
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

function FieldWithCheck({ label, value, onChange, placeholder, avail, okText, takenText, formatText, ...rest }) {
  return (
    <div className="mt-2">
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} {...rest}
        className="w-full rounded-xl bg-[#f2f6fa] px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[#0095da]/40" />
      {avail === "checking" && <p className="mt-1 text-[11px] text-[#0c4470]/40">확인 중…</p>}
      {avail === true && <p className="mt-1 text-[11px] font-bold text-[#1a9b6c]">✓ {okText}</p>}
      {avail === false && <p className="mt-1 text-[11px] font-bold text-[#d05b6a]">✕ {takenText}</p>}
      {avail === "format" && <p className="mt-1 text-[11px] text-[#d05b6a]">{formatText}</p>}
    </div>
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
  return <p className={`mt-2 rounded-lg px-3 py-2 text-xs ${msg.type === "error" ? "bg-[#fdecec] text-[#d05b6a]" : "bg-[#eaf6fd] text-[#0c4470]/70"}`}>{msg.text}</p>;
}
