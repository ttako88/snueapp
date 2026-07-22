"use client";
// 관리자 콘솔 허브 — 운영자 전용 도구 모음.
// 화면 게이트일 뿐이고 각 도구의 진짜 경계는 DB(actor_role_check)다.
import Link from "next/link";
import { useAuth } from "../lib/identity/useAuth";
import { isEnabled } from "../lib/features.js";

const ALLOWED = ["moderator", "operator", "owner"];

export default function AdminConsolePage() {
  const { session, profile, loading, profileLoading } = useAuth();
  const role = profile?.role ?? null;
  const canView = ALLOWED.includes(role);

  if (loading || profileLoading) return <Shell><Muted>확인 중이에요…</Muted></Shell>;
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

  const tools = [
    { href: "/admin/console", icon: "🎛️", title: "통합 운영 콘솔", desc: "회원·이용권·게시판·모더레이션 한 곳에서", roles: ["moderator", "operator", "owner"] },
    { href: "/admin/verification", icon: "🪪", title: "학생 인증 심사", desc: "제출 서류 확인·승인·반려", roles: ["operator", "owner"] },
    {
      href: "/admin/analytics", icon: "📊", title: "이용통계",
      desc: isEnabled("productAnalytics") ? "학과·학년 세그먼트·이벤트 집계" : "준비됨(productAnalytics OFF — 켜면 집계 시작)",
      roles: ["operator", "owner"],
    },
  ];

  return (
    <Shell>
      <p className="text-xs text-[#0c4470]/45">현재 권한: <b>{role}</b></p>
      <div className="mt-2 flex flex-col gap-2">
        {tools.filter((t) => t.roles.includes(role)).map((t) => (
          <Link key={t.href} href={t.href}
            className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm active:opacity-80">
            <span className="text-2xl">{t.icon}</span>
            <span className="min-w-0">
              <span className="block text-sm font-bold text-[#0c4470]">{t.title}</span>
              <span className="block truncate text-xs text-[#0c4470]/50">{t.desc}</span>
            </span>
          </Link>
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
        <h1 className="text-base font-bold text-[#0c4470]">관리자 콘솔</h1>
      </div>
      {children}
    </div>
  );
}
function Muted({ children, className = "" }) {
  return <p className={`text-sm text-[#0c4470]/50 ${className}`}>{children}</p>;
}
