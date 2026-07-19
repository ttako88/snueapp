"use client";

// ⚠️ 진단 전용 페이지 (/eclass/test)
// 비밀번호 방식이 "정확히 어디서" 막히는지 확인하려고 임시로 만든 화면.
// 정식 화면은 /eclass (달력 구독 방식) — 이 페이지는 그것과 완전히 분리돼 있음.
// 진단이 끝나면 이 페이지와 /api/eclass/token 은 삭제할 예정.

import Link from "next/link";
import { useState } from "react";

export default function EclassTestPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);

  const add = (msg) =>
    setLog((l) => [...l, `[${new Date().toLocaleTimeString("ko-KR")}] ${msg}`]);

  async function run(e) {
    e.preventDefault();
    setLog([]);
    setBusy(true);
    try {
      add("① 버튼 클릭됨 — 자바스크립트가 실행되고 있어요");
      add("② 우리 서버(/api/eclass/token)로 요청 보내는 중…");

      const t0 = performance.now();
      const res = await fetch("/api/eclass/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const ms = Math.round(performance.now() - t0);
      add(`③ 응답 도착! HTTP ${res.status} (${ms}ms)`);

      const raw = await res.text();
      add(`④ 응답 내용: ${raw.slice(0, 300)}`);

      try {
        const data = JSON.parse(raw);
        if (data.token) {
          add("✅ 성공! 토큰이 발급됐어요 (값은 화면에 안 띄웁니다)");
          add(`   토큰 길이: ${data.token.length}자`);
        } else {
          add(`❌ 토큰 없음 — 학교가 준 메시지: ${data.error}`);
        }
      } catch {
        add("⚠️ JSON이 아닌 응답이 왔어요 (HTML일 수 있음)");
      }
    } catch (err) {
      add(`💥 요청 자체가 실패: ${err.name} — ${err.message}`);
      add("   → 이 경우 요청이 서버까지 못 갔다는 뜻이에요 (보안프로그램/네트워크 차단 의심)");
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="flex items-center gap-2">
        <Link href="/eclass" className="text-[#0c4470]/50">‹ e-Class</Link>
        <h2 className="text-lg font-bold text-[#0c4470]">🔬 진단 테스트</h2>
      </div>

      <section className="rounded-2xl bg-[#fbf1d3] p-3.5">
        <p className="text-xs leading-relaxed text-[#96760f]">
          <b>⚠️ 임시 진단용 화면이에요.</b>
          <br />
          비밀번호 방식이 <b>정확히 어디서 막히는지</b> 확인하려고 만든 페이지예요.
          단계별로 어디까지 진행됐는지 아래에 표시돼요.
          <br />
          진단이 끝나면 이 화면은 삭제할 거예요. 정식 연동은{" "}
          <Link href="/eclass" className="font-bold underline">
            /eclass (달력 방식)
          </Link>
          를 쓰세요.
        </p>
      </section>

      <form onSubmit={run} className="flex flex-col gap-2.5">
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="학번"
          autoComplete="username"
          className="w-full rounded-xl bg-white px-3 py-3 text-sm text-[#0c4470] shadow-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="비밀번호"
          autoComplete="current-password"
          className="w-full rounded-xl bg-white px-3 py-3 text-sm text-[#0c4470] shadow-sm outline-none focus:ring-2 focus:ring-[#0095da]/40"
        />
        <button
          type="submit"
          disabled={busy || !username.trim() || !password.trim()}
          className="w-full rounded-xl bg-[#0c4470] py-3 text-sm font-bold text-white active:opacity-80 disabled:opacity-40"
        >
          {busy ? "테스트 중…" : "🔬 진단 테스트 실행"}
        </button>
      </form>

      {log.length > 0 && (
        <section className="rounded-2xl bg-[#0c4470] p-3.5">
          <p className="mb-2 text-xs font-bold text-white/70">진단 로그</p>
          <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-[#a2d3f4]">
            {log.join("\n")}
          </pre>
        </section>
      )}

      <p className="text-center text-[11px] leading-relaxed text-[#0c4470]/40">
        어느 단계까지 나왔는지 알려주세요.
        <br />
        ①에서 멈춤 = 자바스크립트 차단 / ②③ 사이 = 네트워크 차단 / ③④ = 학교 응답 도착
      </p>
    </div>
  );
}
