// 로딩 중에 보여줄 "깜빡이는 회색 카드" 목록 (앱 느낌)
export default function SkeletonList({ count = 5 }) {
  return (
    <ul className="flex flex-col gap-2">
      {Array.from({ length: count }).map((_, i) => (
        <li
          key={i}
          className="flex items-center gap-3 rounded-xl bg-white p-3 shadow-sm"
        >
          <div className="h-11 w-14 shrink-0 animate-pulse rounded-lg bg-[#eaf6fd]" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-3/4 animate-pulse rounded bg-black/5" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-black/5" />
          </div>
        </li>
      ))}
    </ul>
  );
}
