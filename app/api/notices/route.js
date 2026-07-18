// 공지 목록 중계소 (주소: /api/notices)
// 학사공지 게시판(HTML)을 받아 한 줄씩 파싱해서 목록 JSON으로 정리.

import * as cheerio from "cheerio";

export async function GET() {
  try {
    const res = await fetch(
      "https://www.snue.ac.kr/snue/na/ntt/selectNttList.do?mi=1280&bbsId=1081",
      {
        headers: { "User-Agent": "Mozilla/5.0" },
        next: { revalidate: 1800 }, // 30분 캐시
      }
    );
    const html = await res.text();
    const $ = cheerio.load(html);

    const items = [];
    $("table tbody tr").each((_, tr) => {
      const tds = $(tr).find("td");
      const a = $(tr).find("a.nttInfoBtn"); // 제목 링크
      const nttSn = a.attr("data-id"); // 글 번호
      if (!nttSn) return; // 제목 없는 줄(다른 표 등)은 건너뜀

      items.push({
        nttSn,
        category: $(tds[1]).text().trim(), // 구분: 중요공지/수강신청/교육실습…
        title: a.text().trim(),
        writer: $(tds[3]).text().trim(),
        date: $(tds[4]).text().trim(),
        isNotice: $(tds[0]).find("b").length > 0, // 상단 고정 '공지'인지
      });
    });

    return Response.json(items);
  } catch (err) {
    return Response.json({ error: "공지를 불러오지 못했어요" }, { status: 502 });
  }
}
