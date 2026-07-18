// 학사일정 중계소 (주소: /api/schedule)
// 우리 서버가 학교 서버에 대신 물어보고, 필요한 것만 정리해서 넘겨줌.

export async function GET() {
  const year = new Date().getFullYear(); // 올해 (예: 2026)

  try {
    const res = await fetch(
      "https://www.snue.ac.kr/snue/sm/schdul/selectSchdulInfo.do",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0",
        },
        body: new URLSearchParams({
          schdulId: "1000",
          sysId: "snue",
          yearFirst: "Y",
          year: String(year),
        }),
        // 1시간 동안은 학교에 다시 안 물어보고 저장해둔 값 사용 (부담 줄이기)
        next: { revalidate: 3600 },
      }
    );

    const raw = await res.json();

    // 학교가 주는 복잡한 필드 중 우리가 쓸 것만 골라서 깔끔하게 정리
    const events = raw.map((e) => ({
      title: e.schdulTitle, // 일정 이름
      detail: e.schdulCn, // 상세(대괄호로 [학부]/[대학원] 등 구분)
      start: e.bgnde, // 시작일 "2026/01/02"
      end: e.endde, // 종료일
      startLabel: e.substrSdt1, // "01.02"
      endLabel: e.substrEdt1, // "01.09"
      startWeek: e.sWeek, // "(금)"
      endWeek: e.eWeek,
      type: e.schdulType, // A/B/C/E (카테고리)
    }));

    return Response.json(events);
  } catch (err) {
    // 학교 서버가 응답 안 하면 빈 목록 + 에러표시
    return Response.json({ error: "학사일정을 불러오지 못했어요" }, { status: 502 });
  }
}
