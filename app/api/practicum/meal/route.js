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
// 파싱은 순수 모듈로 뺐다 — 라우트 안에 있으면 테스트할 수 없다.
import { parseDishes } from "../../../lib/mealParse";

const ALLOWED = new Map(
  schools.schools.filter((s) => s.neisCode).map((s) => [s.neisCode, s]),
);

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

  let j, httpOk;
  try {
    const res = await fetch(url, { next: { revalidate: 3600 } });
    httpOk = res.ok;
    j = await res.json();
  } catch {
    // 응답이 JSON 이 아니거나 네트워크가 끊긴 경우. 빈 급식으로 위장하지 않는다 —
    // 사용자가 "오늘 급식 없구나" 로 오해하면 안 된다.
    return NextResponse.json({ error: "upstream_unavailable" }, { status: 503 });
  }
  if (!httpOk) {
    return NextResponse.json({ error: "upstream_unavailable" }, { status: 503 });
  }

  const rows = j?.mealServiceDietInfo?.[1]?.row;
  if (!rows?.length) {
    // 급식이 없는 날과 오류를 구분해서 준다 — 화면 문구가 달라야 한다.
    //
    // NEIS 실측(2026-07-22):
    //   · 평일 학기중 → mealServiceDietInfo 에 row 있음
    //   · 일요일      → 최상위 {"RESULT":{"CODE":"INFO-200", ...}}
    //   · 여름방학중  → **row 있음** (방학 급식을 운영한다)
    //   즉 "방학이니까 없다" 고 단정하면 안 된다. 날짜만 보고 추측하지 않는다.
    //
    // 정상 응답일 때 RESULT 는 head[1] 안에 있고, 오류일 때만 최상위에 온다.
    // 두 자리를 다 본다 — 한 자리만 보면 코드가 있는데 못 찾아 'error' 로 샌다.
    const result = j?.RESULT ?? j?.mealServiceDietInfo?.[0]?.head?.[1]?.RESULT ?? null;
    const code = result?.CODE ?? "";
    const noData = code === "INFO-200"
      || /데이터가 없습니다|해당하는 데이터/.test(result?.MESSAGE ?? "");

    // 주말은 계산으로 확정할 수 있다. API 응답을 기다릴 필요가 없고,
    // 이것만으로도 "주말이라 급식이 없어요" 라는 정확한 문구를 줄 수 있다.
    // (평일인데 없으면 휴업일·방학 등인데, 그건 여기서 구별할 방법이 없다.)
    const dow = new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00+09:00`)
      .getUTCDay();   // +09:00 로 파싱했으므로 UTC 기준 요일이 KST 요일과 같다
    const weekend = dow === 0 || dow === 6;

    return NextResponse.json(
      {
        school: school.short, date: ymd, meals: [],
        // no_meal   = 급식이 없는 날 (주말·휴업일 등)
        // error     = NEIS 가 데이터 없음이라고 말하지 않았는데 비어 있다
        reason: noData ? "no_meal" : "error",
        weekend,
        // 진단용. 화면에 그대로 띄우지 말 것 — 사용자 말이 아니다.
        upstreamCode: code || null,
      },
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
