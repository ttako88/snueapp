// 급식 중계소 (주소: /api/meal)
// 학교는 급식을 JSON이 아니라 HTML(웹페이지)로 줌 → cheerio로 메뉴만 뽑아냄.

import * as cheerio from "cheerio";

export async function GET() {
  try {
    const res = await fetch(
      "https://www.snue.ac.kr/snue/mm/menu/userMenuList.do?mi=1275",
      {
        headers: { "User-Agent": "Mozilla/5.0" },
        next: { revalidate: 3600 }, // 1시간 캐시
      }
    );
    const html = await res.text();
    const $ = cheerio.load(html);

    // 급식 표는 .list 블록으로 나뉨: [0]학생중식 [1]학생석식 [2]교직원중식 [3]교직원석식
    // 우리는 학생 것(0, 1)만 사용.
    const lists = $(".list");

    function parseList(idx) {
      const days = [];
      $(lists[idx])
        .find("li")
        .each((_, li) => {
          const $li = $(li);
          const day = $li.find("h4").text().trim(); // 요일 "월"
          const date = $li.find("strong").text().trim(); // "07.13"

          // <p>소고기<br>유린기...</p> 에서 <br>을 줄바꿈으로 바꿔 메뉴 목록화
          const $p = $li.find(".menu p");
          $p.find("br").replaceWith("\n");
          const menu = $p
            .text()
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean); // 빈 줄 제거

          days.push({ day, date, menu });
        });
      return days;
    }

    return Response.json({
      lunch: parseList(0), // 학생 중식
      dinner: parseList(1), // 학생 석식
    });
  } catch (err) {
    return Response.json({ error: "급식을 불러오지 못했어요" }, { status: 502 });
  }
}
