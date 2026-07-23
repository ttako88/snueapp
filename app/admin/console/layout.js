"use client";
// 관리자 통합 콘솔 — 공통 진입 게이트 + 모듈 탭.
//
// ⚠️ 이 layout 의 게이트는 **1차 차단(UX)**이다. 진짜 경계는 각 모듈이 부르는
//    RPC 의 require_permission(...) 이다(감사보고서 12.8 원칙). 화면을 우회해
//    RPC 를 직접 불러도 DB 가 막는다.
//
// 접근 격리(GPT R2 Q1) = SAME_APP_ADMIN_ROUTE. 별도 웹앱을 만들지 않는다.
// staff(moderator/operator/owner)가 아니면 콘솔 자체가 안 보인다.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "../../lib/identity/useAuth";
import { roleHasPerm } from "../../lib/community/adminConsole";

const STAFF = ["moderator", "operator", "owner"];

// 모듈 탭 — perm 은 화면 노출 판정(미러). 각 모듈의 RPC 가 서버에서 재검사한다.
const TABS = [
  { href: "/admin/console",            label: "현황",   perm: null },
  { href: "/admin/console/members",     label: "회원",   perm: "member.read_basic" },
  { href: "/admin/console/entitlements", label: "이용권", perm: "entitlement.read" },
  // 이용통계는 기존 /admin/analytics 페이지로 연결한다(별도 배포된 라이브 기능).
  // 여기서는 콘솔 진입점만 제공하고, 그 페이지 자체는 건드리지 않는다.
  { href: "/admin/analytics",           label: "분석",   perm: "member.read_basic", external: true },
  { href: "/admin/console/lesson-analytics", label: "지도안분석", perm: "analytics.read" },
  { href: "/admin/console/boards",      label: "게시판", perm: "board.notice" },
  { href: "/admin/console/moderation",  label: "모더레이션", perm: "moderation.sanction" },
  { href: "/admin/console/sponsors",    label: "광고",   perm: "sponsor.manage" },
  { href: "/admin/console/settings",    label: "설정",   perm: "flag.manage" },
  { href: "/admin/console/audit",       label: "감사",   perm: "audit.read" },
];

export default function ConsoleLayout({ children }) {
  const { session, profile, loading, profileLoading } = useAuth();
  const pathname = usePathname();
  const role = profile?.role ?? null;
  const isStaff = STAFF.includes(role);

  if (loading || profileLoading) return <Shell><Muted>확인 중이에요…</Muted></Shell>;
  if (!session) {
    return (
      <Shell>
        <Muted>로그인이 필요해요.</Muted>
        <Link href="/login" className="mt-3 inline-block text-sm font-bold text-[#0095da]">로그인하기</Link>
      </Shell>
    );
  }
  if (!isStaff) {
    return (
      <Shell>
        <Muted>이 화면은 운영자만 볼 수 있어요.</Muted>
        <p className="mt-1 text-xs text-[#0c4470]/40">현재 권한: {role ?? "알 수 없음"}</p>
      </Shell>
    );
  }

  const tabs = TABS.filter((t) => t.perm === null || roleHasPerm(role, t.perm));

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex items-center gap-2">
        <Link href="/settings" className="text-sm text-[#0c4470]/50">‹</Link>
        <h1 className="text-base font-bold text-[#0c4470]">관리자 콘솔</h1>
        <span className="ml-auto text-[11px] text-[#0c4470]/40">권한: {role}</span>
      </div>

      {/* 모듈 탭 — 가로 스크롤 */}
      <nav className="-mx-4 overflow-x-auto px-4">
        <div className="flex gap-1.5 whitespace-nowrap">
          {tabs.map((t) => {
            const active = pathname === t.href
              || (t.href !== "/admin/console" && pathname.startsWith(t.href));
            return (
              <Link key={t.href} href={t.href}
                className={`rounded-full px-3 py-1.5 text-xs font-bold ${
                  active ? "bg-[#0095da] text-white" : "bg-[#f2f6fa] text-[#0c4470]/70"
                }`}>
                {t.label}
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="mt-1">{children}</div>
    </div>
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
