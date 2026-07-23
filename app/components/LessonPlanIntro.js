"use client";
// 지도안 툴 상단 소개/자랑 — AI가 아무렇게나 쓰는 게 아니라 교육과정을 통째로
// 학습시킨 근거 기반이라는 걸 어필. 데이터 수치는 app/data/lessonPrompt 기준.

export default function LessonPlanIntro() {
  return (
    <div className="overflow-hidden rounded-2xl border border-[#0095da]/15 bg-gradient-to-b from-[#eef7ff] to-white p-4">
      <p className="text-sm font-bold text-[#0c4470]">🎓 아무 AI한테나 시키는 게 아니에요</p>
      <p className="mt-1 text-[12px] leading-relaxed text-[#0c4470]/70">
        <b>2022 개정 교육과정</b>을 통째로 먹이고, 초등 교과서를 전부 분류·정제해서 학습시켰어요.
        그래서 <b>성취기준을 지어내는 할루시네이션이 없어요</b> — 실제 교육과정 코드에 그라운딩됩니다.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-1.5">
        <Stat n="6" unit="개 출판사" sub="미래엔·비상·YBM·아이스크림·지학사·천재" />
        <Stat n="11" unit="개 전 과목" sub="국·수·사·과·도·미·음·체·실·영·통합" />
        <Stat n="1~6" unit="학년 전 학년" sub="499개 단원 · 5,884개 차시" />
        <Stat n="611" unit="개 성취기준" sub="평가기준 1,000+ · 수업모형 10종" />
      </div>

      <p className="mt-3 rounded-xl bg-white/70 px-3 py-2 text-[12px] font-bold leading-relaxed text-[#0095da]">
        ✨ 게다가 원하는 AI를 골라서 작성할 수 있어요! <span className="font-normal text-[#0c4470]/50">(곧 GPT·Claude 등 추가 예정)</span>
      </p>
    </div>
  );
}

function Stat({ n, unit, sub }) {
  return (
    <div className="rounded-xl bg-white/70 px-3 py-2">
      <p className="text-[#0c4470]">
        <b className="text-base">{n}</b>
        <span className="ml-0.5 text-[11px] font-bold text-[#0c4470]/70">{unit}</span>
      </p>
      <p className="mt-0.5 truncate text-[10px] text-[#0c4470]/45">{sub}</p>
    </div>
  );
}
