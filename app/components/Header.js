import Image from "next/image";

// 화면 맨 위 바. 모든 화면에 공통으로 뜸.
export default function Header() {
  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-black/5 bg-white px-4 py-3">
      {/* 새록이 미니 얼굴 */}
      <Image
        src="/saerok.png"
        alt="새록이"
        width={32}
        height={32}
        className="rounded-full"
      />
      <div className="leading-tight">
        <p className="text-base font-bold text-[#0095da]">서울교대</p>
        <p className="text-[11px] text-[#0c4470]/50">새록이와 함께하는 캠퍼스</p>
      </div>
    </header>
  );
}
