// 공지 목록 중계소 (주소: /api/notices)
// 학사공지 게시판(HTML)을 받아 한 줄씩 파싱해서 목록 JSON으로 정리.
// 필터가 의미있게 동작하도록 최근 3페이지(약 45개)를 모아서 돌려줌.

import * as cheerio from "cheerio";

const LIST_URL = "https://www.snue.ac.kr/snue/na/ntt/selectNttList.do";

// HTML 한 페이지에서 공지 행들을 뽑아내는 함수
function parsePage(html) {
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
  return items;
}

export async function GET() {
  try {
    // 1~3페이지를 동시에 요청 (currPage로 페이지 이동)
    const pages = [1, 2, 3];
    const htmls = await Promise.all(
      pages.map((p) =>
        fetch(LIST_URL, {
          method: "POST",
          headers: {
            "User-Agent": "Mozilla/5.0",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            currPage: String(p),
            mi: "1280",
            bbsId: "1081",
          }),
          next: { revalidate: 1800 }, // 30분 캐시
        }).then((r) => r.text())
      )
    );

    // 페이지들을 합치되, 상단 고정공지가 페이지마다 겹치므로 글 번호로 중복 제거
    const seen = new Set();
    const items = [];
    for (const html of htmls) {
      for (const it of parsePage(html)) {
        if (seen.has(it.nttSn)) continue;
        seen.add(it.nttSn);
        items.push(it);
      }
    }

    return Response.json(items);
  } catch (err) {
    return Response.json({ error: "공지를 불러오지 못했어요" }, { status: 502 });
  }
}
