import Link from "next/link";
import Timetable from "../components/Timetable";

// 강의 탭 허브 — 맨 위 '내 시간표' + 아래 도구 카드들.
// ready=true인 카드(학점계산기·마법사·e-Class)는 동작, 나머지는 '준비 중'.

// 도구 카드 정의 (ready=true면 눌러서 들어감)
const TOOLS = [
  { href: "/courses/gpa", icon: "📊", title: "학점 계산기", desc: "성적 넣으면 평점 자동", ready: true },
  { href: "/courses/wizard", icon: "🧙", title: "시간표 마법사", desc: "교양·재이수 경우의 수", ready: true },
  { href: "/eclass", icon: "🔗", title: "e-Class 연동", desc: "과제·영상강의 마감 가져오기", ready: true },
  { href: null, icon: "🔍", title: "강의 검색", desc: "전체 강의 시간표 조회", ready: false },
  { href: null, icon: "⭐", title: "강의평가", desc: "수강 후기·평점", ready: false },
];

export default function CoursesPage() {
  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <h2 className="text-lg font-bold text-[#0c4470]">강의</h2>

      {/* 내 시간표 */}
      <Timetable editable />

      {/* 도구 카드들 (2열) */}
      <div className="grid grid-cols-2 gap-2.5">
        {TOOLS.map((t) => {
          const inner = (
            <div
              className={`flex h-full flex-col gap-1 rounded-2xl bg-white p-4 shadow-sm ${
                t.ready ? "active:bg-[#eaf6fd]" : "opacity-55"
              }`}
            >
              <span className="text-2xl">{t.icon}</span>
              <span className="font-bold text-[#0c4470]">{t.title}</span>
              <span className="text-xs text-[#0c4470]/50">{t.desc}</span>
              {!t.ready && (
                <span className="mt-1 inline-block w-fit rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-bold text-[#0c4470]/40">
                  준비 중
                </span>
              )}
            </div>
          );

          return t.ready ? (
            <Link key={t.title} href={t.href}>
              {inner}
            </Link>
          ) : (
            <div key={t.title}>{inner}</div>
          );
        })}
      </div>
    </div>
  );
}
