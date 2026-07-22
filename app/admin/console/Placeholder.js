"use client";
// 콘솔 모듈 공통 플레이스홀더 — "무엇이 올지" 를 정직하게 보여준다.

export default function Placeholder({ title, lines = [] }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold text-[#0c4470]">{title}</span>
        <span className="rounded-full bg-[#f2f6fa] px-2 py-0.5 text-[10px] font-bold text-[#0c4470]/50">
          준비 중
        </span>
      </div>
      <ul className="mt-2 flex flex-col gap-1">
        {lines.map((l, i) => (
          <li key={i} className="text-xs text-[#0c4470]/60">· {l}</li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] text-[#0c4470]/40">
        다음 배포에서 활성화돼요. 지금은 회원 관리·이용권이 먼저 열려 있어요.
      </p>
    </div>
  );
}
