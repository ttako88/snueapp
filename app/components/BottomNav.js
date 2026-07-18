"use client"; // 이 컴포넌트는 브라우저에서 동작 (현재 주소를 알아야 하므로)

import Link from "next/link";
import { usePathname } from "next/navigation";

// 탭 4개 정의 (아이콘은 우선 이모지로)
const TABS = [
  { href: "/", label: "홈", icon: "🏠" },
  { href: "/meal", label: "급식", icon: "🍚" },
  { href: "/schedule", label: "학사일정", icon: "📅" },
  { href: "/notices", label: "공지", icon: "📢" },
];

export default function BottomNav() {
  const pathname = usePathname(); // 지금 보고 있는 주소 (예: "/meal")

  return (
    <nav className="flex shrink-0 border-t border-black/5 bg-white">
      {TABS.map((tab) => {
        // 홈은 정확히 "/"일 때만, 나머지는 주소가 그 탭으로 시작할 때 활성화
        const active =
          tab.href === "/"
            ? pathname === "/"
            : pathname.startsWith(tab.href);

        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition-colors ${
              active ? "text-[#0095da]" : "text-[#0c4470]/40"
            }`}
          >
            <span className="text-xl">{tab.icon}</span>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
