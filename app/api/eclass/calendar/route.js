// ─────────────────────────────────────────────────────────────
//  e-Class 일정 가져오기 (주소: /api/eclass/calendar)
//
//  방식: 학교 e-Class(무들)가 학생에게 공식으로 제공하는
//        "일정 내보내기(달력 구독 iCal)" 주소를 그대로 읽어옵니다.
//        → 비밀번호도, 웹서비스 토큰도 필요 없습니다.
//
//  🔒 개인정보 안내
//  - 이 서버는 여러분의 달력 주소를 저장하지 않습니다. 요청 때 잠깐 받아
//    학교 서버에서 일정을 읽어오고, 결과만 돌려준 뒤 잊습니다.
//  - 달력 주소는 여러분 기기(브라우저)에만 보관됩니다.
//  - 주소가 로그에 남지 않도록 GET이 아닌 POST 본문으로 받습니다.
//
//  🛡️ 보안: 이 서버가 아무 주소나 대신 열어주는 통로로 악용되지 않도록,
//     학교 e-Class의 일정 내보내기 주소만 허용합니다(SSRF 방지).
// ─────────────────────────────────────────────────────────────

const ALLOWED_PREFIX = "https://lms.snue.ac.kr/calendar/export_execute.php";

/* ---------- iCal(ICS) 파서 ---------- */

// 여러 줄로 접힌(folded) 줄을 한 줄로 펴기
function unfold(text) {
  return text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
}

// ICS 이스케이프 되돌리기
function unescapeIcs(v) {
  return v
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

// 20260901T090000Z / 20260901T090000 / 20260901 → 유닉스 초
function parseIcsDate(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return Math.floor(Date.UTC(+y, +mo - 1, +d) / 1000);
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) / 1000;
  // Z가 없으면 한국시간(UTC+9)으로 간주
  return Math.floor(z ? utc : utc - 9 * 3600);
}

function parseIcs(text) {
  const body = unfold(text);
  const blocks = body.split("BEGIN:VEVENT").slice(1);
  const events = [];

  for (const raw of blocks) {
    const block = raw.split("END:VEVENT")[0];
    const field = (key) => {
      const re = new RegExp("^" + key + "(?:;[^:\\r\\n]*)?:(.*)$", "mi");
      const m = re.exec(block);
      return m ? m[1].trim() : "";
    };

    const summary = unescapeIcs(field("SUMMARY"));
    const ts = parseIcsDate(field("DTSTART"));
    if (!summary || !ts) continue;

    events.push({
      id: field("UID") || `${summary}-${ts}`,
      title: summary,
      course: unescapeIcs(field("CATEGORIES")),
      description: unescapeIcs(field("DESCRIPTION")).slice(0, 300),
      timestamp: ts,
      type: guessType(summary),
    });
  }

  // 시간순 정렬
  return events.sort((a, b) => a.timestamp - b.timestamp);
}

// 제목으로 일정 성격 추측 (색상용)
function guessType(summary) {
  const s = summary.toLowerCase();
  if (/퀴즈|quiz|시험|exam/.test(s)) return "시험";
  if (/동영상|영상|vod|출석|lesson|강의/.test(s)) return "영상강의";
  if (/과제|assign|제출|due/.test(s)) return "과제";
  return "기타";
}

export async function POST(request) {
  try {
    const { url } = await request.json();
    if (!url) {
      return Response.json({ error: "달력 주소가 없어요. e-Class에서 주소를 먼저 가져와 주세요." }, { status: 400 });
    }
    if (!url.startsWith(ALLOWED_PREFIX)) {
      return Response.json(
        { error: "e-Class 일정 주소가 아니에요. '일정 URL 불러오기'로 나온 주소를 그대로 붙여넣어 주세요." },
        { status: 400 }
      );
    }

    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      cache: "no-store",
    });
    const text = await res.text();

    // 정상 iCal인지 확인 (로그인 페이지나 에러 HTML이 오는 경우 걸러냄)
    if (!text.includes("BEGIN:VCALENDAR")) {
      return Response.json(
        { error: "일정을 읽지 못했어요. 주소가 만료됐을 수 있으니 e-Class에서 다시 가져와 주세요.", expired: true },
        { status: 401 }
      );
    }

    return Response.json({ events: parseIcs(text) });
  } catch (err) {
    return Response.json({ error: "e-Class 일정을 불러오는 중 문제가 생겼어요." }, { status: 502 });
  }
}
