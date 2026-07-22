// ============================================================
// lessonExport.js — 지도안 내보내기(PDF 인쇄 / 한글·워드 .doc)
// ============================================================
// 마크다운 지도안을 인쇄용 HTML 로 바꿔 (1) 새 창 인쇄 → "PDF 로 저장" (2) .doc
// 파일 다운로드(한글·MS워드에서 열림)를 제공한다.
//
// ⚠️ 진짜 .hwp 바이너리 생성은 브라우저에서 불가능하다(사설 포맷). 서버측 변환기
//    (예: hwpx 라이브러리·LibreOffice)를 붙이기 전까지는 .doc 로 내보낸다 — 한글이
//    .doc 를 열어 편집·저장(.hwp)할 수 있다. PDF 는 브라우저 인쇄로 바로 된다.

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// AI 텍스트의 literal <br> 은 실제 줄바꿈으로, **굵게** 는 <strong> 으로.
function inlineHtml(s) {
  const out = String(s).split(/<br\s*\/?>/i).map(esc).join("<br/>");
  return out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}
const isSep = (l) => /^\s*\|?[\s:-]*\|[\s:|-]*$/.test(l) && l.includes("-");
const isRow = (l) => l.trim().startsWith("|");

// 마크다운 지도안 → HTML 문자열(본문만).
export function lessonPlanToHtml(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isRow(lines[i]) && !isSep(lines[i])) { rows.push(splitRow(lines[i])); i += 1; }
      out.push(
        "<table><thead><tr>" +
        header.map((c) => `<th>${inlineHtml(c)}</th>`).join("") +
        "</tr></thead><tbody>" +
        rows.map((r) => "<tr>" + r.map((c) => `<td>${inlineHtml(c)}</td>`).join("") + "</tr>").join("") +
        "</tbody></table>"
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { const n = Math.min(h[1].length + 1, 4); out.push(`<h${n}>${inlineHtml(h[2])}</h${n}>`); i += 1; continue; }
    if (/^\s*---+\s*$/.test(line)) { out.push("<hr/>"); i += 1; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i += 1; }
      out.push("<ul>" + items.map((it) => `<li>${inlineHtml(it)}</li>`).join("") + "</ul>");
      continue;
    }
    if (line.trim() === "") { i += 1; continue; }
    out.push(`<p>${inlineHtml(line)}</p>`);
    i += 1;
  }
  return out.join("\n");
}

const PRINT_CSS = `
  body{font-family:'Malgun Gothic','맑은 고딕',sans-serif;color:#111;margin:24px;font-size:12px;line-height:1.5;}
  h1,h2,h3,h4{margin:10px 0 6px;color:#0c4470;}
  h2{font-size:15px;} h3{font-size:13px;}
  table{width:100%;border-collapse:collapse;margin:8px 0;font-size:11px;}
  th,td{border:1px solid #999;padding:5px 6px;text-align:left;vertical-align:top;}
  th{background:#eef3f8;font-weight:bold;}
  hr{border:none;border-top:1px solid #ccc;margin:8px 0;}
  ul{margin:6px 0 6px 18px;}
  @page{size:A4;margin:14mm;}
`;

function wrapDoc(title, bodyHtml, forWord) {
  const head = forWord
    ? `<meta charset="utf-8"><title>${esc(title)}</title>`
    : `<meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style>`;
  const wordStyle = forWord ? `<style>${PRINT_CSS}</style>` : "";
  return `<!DOCTYPE html><html><head>${head}${wordStyle}</head><body>${bodyHtml}</body></html>`;
}

// 새 창을 열어 인쇄(브라우저의 "PDF 로 저장" 사용).
export function printLessonPlan(text, title = "수업지도안") {
  if (typeof window === "undefined") return;
  const html = wrapDoc(title, lessonPlanToHtml(text), false);
  const w = window.open("", "_blank");
  if (!w) return; // 팝업 차단 시
  w.document.write(html);
  w.document.close();
  w.focus();
  // 렌더 후 인쇄
  setTimeout(() => { try { w.print(); } catch { /* 사용자가 수동 인쇄 */ } }, 300);
}

// 한글·워드에서 열리는 .doc 다운로드.
export function downloadLessonPlan(text, filename = "수업지도안.doc") {
  if (typeof window === "undefined") return;
  const html = wrapDoc(filename.replace(/\.\w+$/, ""), lessonPlanToHtml(text), true);
  const blob = new Blob(["﻿", html], { type: "application/msword" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
