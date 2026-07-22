"use client";
// 관리자 콘솔 — 현황(hub). 모듈 안내 + 자주 쓰는 작업 바로가기.

import Link from "next/link";
import { useAuth } from "../../lib/identity/useAuth";
import { roleHasPerm } from "../../lib/community/adminConsole";

const MODULES = [
  { href: "/admin/console/members", icon: "👤", title: "회원 관리",
    desc: "검색·상태·역할·제재·이용권 부여", perm: "member.read_basic" },
  { href: "/admin/console/entitlements", icon: "🎫", title: "이용권",
    desc: "지도안 생성권 등 개별 부여·회수 현황", perm: "entitlement.read" },
  { href: "/admin/analytics", icon: "📊", title: "이용통계",
    desc: "화면·기능 사용 집계, 학과·학년 세그먼트", perm: "member.read_basic" },
  { href: "/admin/console/boards", icon: "📌", title: "게시판 운영",
    desc: "게시판별 공지 작성·고정", perm: "board.notice" },
  { href: "/admin/console/moderation", icon: "🚩", title: "모더레이션",
    desc: "신고 큐·게시물 숨김·제재", perm: "moderation.sanction" },
  { href: "/admin/console/sponsors", icon: "📣", title: "광고·후원",
    desc: "게시판별 광고 슬롯·소재(초안)", perm: "sponsor.manage" },
  { href: "/admin/console/settings", icon: "⚙️", title: "운영 설정",
    desc: "런타임 기능 토글", perm: "flag.manage" },
  { href: "/admin/console/audit", icon: "🧾", title: "작업·감사",
    desc: "관리자 행위 로그", perm: "audit.read" },
];

export default function ConsoleHome() {
  const { profile } = useAuth();
  const role = profile?.role ?? null;
  const mods = MODULES.filter((m) => roleHasPerm(role, m.perm));

  return (
    <div className="flex flex-col gap-3">
      {role === "owner" && (
        <div className="rounded-2xl bg-[#eaf6ff] p-4">
          <p className="text-xs font-bold text-[#0c4470]">베타테스터에게 지도안 열어주기</p>
          <p className="mt-1 text-xs text-[#0c4470]/60">
            회원 관리에서 지인을 찾아 <b>지도안 생성 이용권</b>을 부여하면, 결제 없이 지도안을
            뽑아볼 수 있어요(기본 30일·10회).
          </p>
          <Link href="/admin/console/members"
            className="mt-2 inline-block rounded-lg bg-[#0095da] px-3 py-1.5 text-xs font-bold text-white">
            회원 찾아 부여하기 →
          </Link>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {mods.map((m) => (
          <Link key={m.href} href={m.href}
            className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm active:opacity-80">
            <span className="text-2xl">{m.icon}</span>
            <span className="min-w-0">
              <span className="block text-sm font-bold text-[#0c4470]">{m.title}</span>
              <span className="block truncate text-xs text-[#0c4470]/50">{m.desc}</span>
            </span>
          </Link>
        ))}
      </div>

      <p className="mt-1 text-[11px] text-[#0c4470]/40">
        각 작업의 실제 권한은 서버(DB)가 판정해요. 이 화면은 안내일 뿐이에요.
      </p>
    </div>
  );
}
