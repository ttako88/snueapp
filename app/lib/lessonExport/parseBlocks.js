// 지도안 마크다운 → 블록 구조. LessonPlanView 의 렌더 로직과 동일 문법을 공유한다
// (약안·세안이 쓰는 좁은 마크다운만: ## 제목 · 표 · **굵게** · <br> · --- · - 목록).
// 내보내기(docx/hwpx)와 화면 렌더가 같은 파서를 쓰도록 단일 출처로 뺐다.

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}
const isTableSep = (line) => /^\s*\|?[\s:-]*\|[\s:|-]*$/.test(line) && line.includes("-");
const isTableRow = (line) => line.trim().startsWith("|");

/** 마크다운 텍스트 → 블록 배열. */
export function parseBlocks(text) {
  if (!text) return [];
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]) && !isTableSep(lines[i])) {
        rows.push(splitRow(lines[i])); i += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { blocks.push({ type: "heading", level: h[1].length, text: h[2] }); i += 1; continue; }
    if (/^\s*---+\s*$/.test(line)) { blocks.push({ type: "hr" }); i += 1; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i += 1;
      }
      blocks.push({ type: "ul", items });
      continue;
    }
    if (line.trim() === "") { i += 1; continue; }
    blocks.push({ type: "p", text: line });
    i += 1;
  }
  return blocks;
}

/**
 * 인라인 텍스트 → 줄 배열. 각 줄은 run 배열 [{text, bold}].
 * <br> 로 줄을 나누고 **굵게** 를 run 으로 분리한다.
 */
export function parseInline(text) {
  const rawLines = String(text ?? "").split(/<br\s*\/?>/i);
  return rawLines.map((line) => {
    const parts = line.split(/(\*\*[^*]+\*\*)/g).filter((s) => s !== "");
    const runs = parts.map((p) => {
      const m = /^\*\*([^*]+)\*\*$/.exec(p);
      return m ? { text: m[1], bold: true } : { text: p, bold: false };
    });
    return runs.length ? runs : [{ text: "", bold: false }];
  });
}

/** 파일명용: 첫 제목(#/##) 또는 기본값. 파일명 불가 문자 제거. */
export function titleFromText(text, fallback = "지도안") {
  const blocks = parseBlocks(text);
  const h = blocks.find((b) => b.type === "heading");
  const raw = (h?.text || fallback).replace(/\*\*/g, "").trim();
  return (raw || fallback).replace(/[\\/:*?"<>|]+/g, " ").slice(0, 60);
}
