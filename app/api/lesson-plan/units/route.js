// ============================================================
// GET /api/lesson-plan/units?grade=5&subject=국어 — 단원 목록
// ============================================================
// 왜 필요한가
//   지도안 화면에서 사용자가 단원을 **자유 입력**하면 실제 데이터의 단원명과
//   글자가 조금만 달라도(예: "글쓴이의 주장" vs "추론하며 읽어요") 근거 주입이
//   안 된다. 실제 단원 목록을 골라 주면 근거가 100% 매칭된다 — 이게 "딸깍" 의
//   핵심이다.
//
//   데이터(app/data/lessonPrompt/)는 서버 전용 fs 로 읽으므로 클라이언트가
//   직접 못 본다. 그래서 이 라우트로 목록만 내려보낸다. 인증 불필요 —
//   교과서 단원명은 공개 정보다.
//
//   데이터가 없으면 빈 목록. 화면은 그때 자유 입력으로 떨어진다(둘 다 동작).
import { NextResponse } from "next/server";
import { loadUnits, loadStandards } from "../../../lib/server/ai/lessonData.mjs";
import { GRADES, subjectsForGrade } from "../../../lib/lessonPlan";

export const runtime = "nodejs";

// 매 요청마다 CSV 를 읽지 않는다. 배포 때만 바뀐다. 읽기 실패는 캐시하지 않는다.
let cache = null;
function units() {
  if (cache) return cache;
  try {
    const std = loadStandards();
    cache = loadUnits(std.byCode.size ? new Set(std.byCode.keys()) : null).rows;
  } catch { return []; }
  return cache;
}

export async function GET(request) {
  const sp = new URL(request.url).searchParams;
  const grade = Number(sp.get("grade"));
  const subject = sp.get("subject");

  if (!GRADES.includes(grade) || !subjectsForGrade(grade).includes(subject)) {
    return NextResponse.json({ error: "bad_params" }, { status: 400 });
  }

  const rows = units().filter((u) => u.grade === grade && u.subject === subject);

  // 단원 단위로 접는다(차시가 여럿이라 단원명이 반복된다). 출판사·학기·차시수도
  // 같이 준다 — 화면이 "5학년 2학기 · 미래엔 · 14차시" 처럼 보여줄 수 있게.
  const byUnit = new Map();
  for (const u of rows) {
    const key = `${u.term}/${u.unitNo}/${u.unit}/${u.publisher}`;
    if (!byUnit.has(key)) {
      byUnit.set(key, {
        term: u.term, unitNo: u.unitNo, unit: u.unit,
        publisher: u.publisher, totalPeriods: u.totalPeriods,
      });
    }
  }
  const list = [...byUnit.values()].sort((a, b) =>
    a.term - b.term || a.unitNo - b.unitNo);

  return NextResponse.json(
    { grade, subject, units: list },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
