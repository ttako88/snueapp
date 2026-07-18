// 공지 상세 중계소 (주소: /api/notices/글번호)
// 글 하나의 본문 텍스트와 첨부파일을 뽑아 정리.

import * as cheerio from "cheerio";

export async function GET(request, { params }) {
  const { nttSn } = await params; // 주소에서 글 번호 꺼내기

  try {
    const res = await fetch(
      `https://www.snue.ac.kr/snue/na/ntt/selectNttInfo.do?mi=1280&bbsId=1081&nttSn=${nttSn}`,
      { headers: { "User-Agent": "Mozilla/5.0" }, next: { revalidate: 1800 } }
    );
    const html = await res.text();
    const $ = cheerio.load(html);

    // 상단 정보: th 라벨에 딱 맞는 값의 옆 칸(td) 읽기
    const metaByLabel = (label) => {
      const th = $("th")
        .filter((_, e) => $(e).text().trim() === label)
        .first();
      return th.next("td").text().trim();
    };

    // 본문: colspan=6 인 칸이 내용 영역. 줄바꿈 살려서 텍스트로.
    const $body = $('td[colspan="6"]').first();
    $body.find("br").replaceWith("\n");
    $body.find("p, div").append("\n");
    const body = $body
      .text()
      .replace(/ /g, " ") // &nbsp; → 공백
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // 첨부파일: 다운로드 링크 모으기 (중복 제거)
    const files = [];
    const seen = new Set();
    $('a[href*="nttFileDownload.do"]').each((_, a) => {
      // 파일명만 깔끔하게: 개행/탭 정리 + "(다운로드 : N회)" 꼬리표 제거
      const name = $(a)
        .text()
        .replace(/\s+/g, " ")
        .replace(/\(다운로드\s*:\s*\d+회\)/, "")
        .trim();
      const href = $(a).attr("href");
      if (!name || !href || seen.has(name)) return;
      seen.add(name);
      files.push({
        name,
        url: new URL(href, "https://www.snue.ac.kr").href,
      });
    });

    return Response.json({
      category: metaByLabel("구분"),
      writer: metaByLabel("작성자"),
      date: metaByLabel("등록일"),
      body,
      files,
    });
  } catch (err) {
    return Response.json({ error: "공지 내용을 불러오지 못했어요" }, { status: 502 });
  }
}
