import Link from "next/link";
import { CAMPUS, BUILDINGS, ORGS, NOTES } from "../lib/campus";

// 캠퍼스 안내 — 위치·교통·건물·교내 기관.
// 정적 데이터라 서버 컴포넌트로 둔다(클라이언트 JS 불필요).

export const metadata = { title: "캠퍼스 안내" };

export default function CampusPage() {
  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="flex items-center gap-2">
        <Link href="/" className="text-sm text-[#0c4470]/50">←</Link>
        <h2 className="text-lg font-bold text-[#0c4470]">캠퍼스 안내</h2>
      </div>

      {/* 오시는 길 */}
      <section className="rounded-2xl bg-[#0095da] p-4 text-white shadow-sm">
        <p className="text-sm font-bold">📍 오시는 길</p>
        <p className="mt-1.5 text-sm leading-relaxed">{CAMPUS.address}</p>
        <p className="text-xs opacity-70">{CAMPUS.addressOld}</p>
        <div className="mt-3 flex flex-col gap-1.5 text-xs">
          <p className="leading-relaxed">
            <span className="mr-1.5 rounded bg-white/20 px-1.5 py-0.5 font-bold">지하철</span>
            {CAMPUS.subway}
          </p>
          <p className="leading-relaxed">
            <span className="mr-1.5 rounded bg-white/20 px-1.5 py-0.5 font-bold">버스</span>
            {Object.entries(CAMPUS.bus)
              .map(([kind, nos]) => `${kind} ${nos.join(", ")}`)
              .join(" · ")}
          </p>
        </div>
        <a
          href={`https://map.kakao.com/link/search/${encodeURIComponent("서울교육대학교")}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 block rounded-xl bg-white/15 py-2 text-center text-xs font-bold active:bg-white/25"
        >
          지도에서 보기 ↗
        </a>
      </section>

      {/* 출입문 */}
      <section>
        <h3 className="mb-2 text-sm font-bold text-[#0c4470]">🚪 출입문</h3>
        <div className="flex gap-2">
          {CAMPUS.gates.map((g) => (
            <div key={g.name} className="flex-1 rounded-xl bg-white p-3 text-center shadow-sm">
              <p className="font-bold text-[#0c4470]">{g.name}</p>
              <p className="mt-0.5 text-[11px] text-[#0c4470]/50">{g.role}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 건물 */}
      <section>
        <h3 className="mb-2 text-sm font-bold text-[#0c4470]">🏫 건물</h3>
        <ul className="grid grid-cols-2 gap-2">
          {BUILDINGS.map((b) => (
            <li
              key={b.no}
              className={`flex items-center gap-2 rounded-xl p-2.5 shadow-sm ${
                b.highlight ? "bg-[#eaf6fd]" : "bg-white"
              }`}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#0095da] text-[11px] font-bold text-white">
                {b.no}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-[#0c4470]">{b.name}</span>
                {b.alt && <span className="block truncate text-[11px] text-[#0c4470]/45">{b.alt}</span>}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-[#0c4470]/40">
          번호는 캠퍼스맵 표기 기준이에요. 자료에 없는 번호는 비어 있어요.
        </p>
      </section>

      {/* 알아두면 좋은 곳 */}
      <section>
        <h3 className="mb-2 text-sm font-bold text-[#0c4470]">💡 알아두면 좋은 곳</h3>
        <ul className="flex flex-col gap-1.5">
          {NOTES.map((n) => (
            <li key={n.name} className="rounded-xl bg-white p-3 shadow-sm">
              <p className="text-sm font-bold text-[#0c4470]">{n.name}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-[#0c4470]/55">{n.note}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* 교내 기관 */}
      <section>
        <h3 className="mb-2 text-sm font-bold text-[#0c4470]">🏛️ 교내 기관</h3>
        <div className="flex flex-col gap-2">
          {ORGS.map((o) => (
            <div key={o.group} className="rounded-2xl bg-white p-3.5 shadow-sm">
              <p className="mb-1.5 text-xs font-bold text-[#0095da]">{o.group}</p>
              <p className="text-xs leading-relaxed text-[#0c4470]/70">{o.items.join(" · ")}</p>
            </div>
          ))}
        </div>
        {/* 없는 정보를 있는 척하지 않는다 */}
        <p className="mt-2 text-[11px] leading-relaxed text-[#0c4470]/40">
          부서별 전화번호·이메일은 아직 확인된 자료가 없어 넣지 않았어요.
          정확한 연락처는 학교 홈페이지에서 확인해 주세요.
        </p>
      </section>
    </div>
  );
}
