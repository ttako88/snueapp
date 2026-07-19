// ─────────────────────────────────────────────────────────────
//  e-Class 마감 일정(과제·영상강의·퀴즈) 가져오기 (주소: /api/eclass/deadlines)
//
//  🔒 개인정보 안내
//  - 이 서버는 '이용권(토큰)'을 저장하지 않습니다. 요청할 때 잠깐 받아서
//    학교 서버에 전달하고, 결과만 돌려준 뒤 잊습니다.
//  - 토큰은 여러분 브라우저(기기)에만 보관됩니다.
//  - 토큰이 주소(URL)에 남지 않도록 POST 본문으로 받습니다.
//
//  사용하는 학교 API: core_calendar_get_action_events_by_timesort
//  (무들 공식 모바일 API — 학교 앱이 '해야 할 일'을 불러올 때 쓰는 것과 동일)
// ─────────────────────────────────────────────────────────────

const ECLASS_WS_URL = "https://lms.snue.ac.kr/webservice/rest/server.php";

export async function POST(request) {
  try {
    const { token } = await request.json();
    if (!token) {
      return Response.json({ error: "연결 정보가 없어요. e-Class를 먼저 연결해 주세요." }, { status: 400 });
    }

    const params = new URLSearchParams({
      wstoken: token,
      wsfunction: "core_calendar_get_action_events_by_timesort",
      moodlewsrestformat: "json",
      timesortfrom: String(Math.floor(Date.now() / 1000)), // 지금 이후 마감만
      limitnum: "50",
    });

    const res = await fetch(ECLASS_WS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0",
      },
      body: params,
      cache: "no-store",
    });
    const data = await res.json();

    // 토큰 만료·권한 오류 등
    if (data.errorcode || data.exception) {
      const expired = data.errorcode === "invalidtoken" || data.errorcode === "accessexception";
      return Response.json(
        {
          error: expired
            ? "연결이 만료됐어요. e-Class를 다시 연결해 주세요."
            : data.message || "일정을 불러오지 못했어요.",
          expired,
        },
        { status: 401 }
      );
    }

    // 필요한 것만 골라 깔끔하게 정리
    const events = (data.events || []).map((e) => ({
      id: e.id,
      title: e.name,
      course: e.course?.fullname || "",
      type: e.modulename || "", // assign(과제) / quiz(퀴즈) / vod·resource(영상강의) 등
      timestamp: e.timesort || e.timestart,
      url: e.url || "",
      actionName: e.action?.name || "",
      done: e.action?.actionable === false, // 이미 제출한 항목
    }));

    return Response.json({ events });
  } catch (err) {
    return Response.json({ error: "e-Class 연결 중 문제가 생겼어요." }, { status: 502 });
  }
}
