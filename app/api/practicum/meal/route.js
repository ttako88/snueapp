// ============================================================
// GET /api/practicum/meal — 실습학교 급식
// ============================================================
// 대학 급식(/api/meal)은 학교 홈페이지 HTML 을 긁어야 하지만, 초등학교 급식은
// NEIS 오픈API 가 JSON 으로 준다. 인증키 없이도 조회된다(실측 2026-07-22).
//
// 학교코드를 클라이언트가 아무거나 넣지 못하게 한다 — 협력학교 목록에 있는
// 코드만 허용한다. 임의 학교 조회 창구를 만들 이유가 없고, 열어두면 이 앱이
// 전국 초등학교 급식 프록시가 된다.
import { NextResponse } from "next/server";
import schools from "../../../data/practicumSchools.json";

const ALLOWED = new Map(
  schools.schools.filter((s) => s.neisCode).map((s) => [s.neisCode, s]),
);

/** NEIS 는 <br/> 로 줄을 나누고 뒤에 알레르기 번호를 괄호로 붙인다. */
function parseDishes(raw) {
  return String(raw || "")
    .split(/<br\s*\/?>/i)
    .map((line) => {
      const t = line.trim();
      if (!t) return null;
      // "반미샌드위치 (2.5.6.10)" → 이름 + 알레르기 번호 배열
      const m = /^(.*?)\s*\(([\d.\s]+)\)\s*$/.exec(t);
      if (!m) return { name: t, allergens: [] };
      return {
        name: m[1].trim(),
        allergens: m[2].split(".").map((x) => x.trim()).filter(Boolean),
      };
    })
    .filter(Boolean);
}

export async function GET(request) {
  const sp = new URL(request.url).searchParams;
  const code = sp.get("school");
  const date = sp.get("date"); // YYYYMMDD, 없으면 오늘

  const school = ALLOWED.get(code);
  if (!school) {
    return NextResponse.json({ error: "unknown_school" }, { status: 400 });
  }
  const ymd = /^\d{8}$/.test(date || "")
    ? date
    : new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).replaceAll("-", "");

  const url = "https://open.neis.go.kr/hub/mealServiceDietInfo"
    + `?Type=json&pIndex=1&pSize=10`
    + `&ATPT_OFCDC_SC_CODE=${encodeURIComponent(school.officeCode || "B10")}`
    + `&SD_SCHUL_CODE=${encodeURIComponent(school.neisCode)}`
    + `&MLSV_YMD=${ymd}`;

  let j;
  try {
    const res = await fetch(url, { next: { revalidate: 3600 } });
    j = await res.json();
  } catch {
    return NextResponse.json({ error: "upstream_unavailable" }, { status: 503 });
  }

  const rows = j?.mealServiceDietInfo?.[1]?.row;
  if (!rows?.length) {
    // 급식이 없는 날(주말·방학)과 오류를 구분해서 준다 — 화면 문구가 달라야 한다.
    const msg = j?.RESULT?.MESSAGE || "";
    const noData = /데이터가 없습니다|해당하는 데이터/.test(msg);
    return NextResponse.json(
      { school: school.short, date: ymd, meals: [], reason: noData ? "no_meal" : "error" },
      { status: 200, headers: { "Cache-Control": "public, max-age=1800" } },
    );
  }

  const meals = rows.map((m) => ({
    type: m.MMEAL_SC_NM,                    // 중식·석식
    dishes: parseDishes(m.DDISH_NM),
    calorie: m.CAL_INFO || null,
    origin: m.ORPLC_INFO ? String(m.ORPLC_INFO).split(/<br\s*\/?>/i).filter(Boolean) : [],
  }));

  return NextResponse.json(
    { school: school.short, schoolFull: school.full, date: ymd, meals },
    { status: 200, headers: { "Cache-Control": "public, max-age=1800" } },
  );
}
