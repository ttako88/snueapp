// 단원 API가 화면에 보낼 선택지 구성. Next 런타임과 분리해 데이터 규칙 자체를
// 단위 테스트할 수 있게 둔다. 교과서ID가 있는 행은 책별로 절대 합치지 않는다.
const TEXTBOOK_NAMES = {
  "1380": "봄", "1383": "여름", "1385": "가을", "1386": "학교",
  "1405": "하루", "1406": "상상", "1407": "성장", "1408": "이야기",
  "1378": "나", "1379": "마을", "1381": "세계", "1384": "자연",
  "1401": "계절", "1402": "우리", "1403": "물건", "1404": "기억",
};

export function textbookName(textbookId) {
  const seq = String(textbookId ?? "").match(/-(\d+)$/)?.[1];
  return seq ? TEXTBOOK_NAMES[seq] ?? "" : "";
}

export function buildUnitList(rows, { grade, subject }) {
  const byUnit = new Map();
  for (const u of rows) {
    if (u.grade !== grade || u.subject !== subject) continue;
    const textbookId = u.textbookId || "";
    const key = `${u.term}/${u.unitNo}/${u.unit}/${u.publisher}/${textbookId}`;
    if (!byUnit.has(key)) {
      byUnit.set(key, {
        term: u.term, unitNo: u.unitNo, unit: u.unit,
        publisher: u.publisher, totalPeriods: u.totalPeriods,
        textbookId, textbookName: textbookName(textbookId),
      });
    }
  }
  return [...byUnit.values()].sort((a, b) =>
    a.term - b.term || a.unitNo - b.unitNo || a.textbookId.localeCompare(b.textbookId));
}
