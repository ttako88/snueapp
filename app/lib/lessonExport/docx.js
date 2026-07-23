// 지도안 마크다운 → DOCX(Blob). 순수 클라이언트(jszip + 최소 OOXML).
// 한글(HWP)이 .docx 를 그대로 열어 '다른 이름으로 저장 > hwp' 가능 → 즉시 실사용.
import JSZip from "jszip";
import { parseBlocks, parseInline } from "./parseBlocks.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// runs 한 줄 → <w:r> 들. bold·크기 지정 가능.
function runsXml(runs, { bold = false, sz = null } = {}) {
  return runs.map((r) => {
    const b = r.bold || bold;
    const rPr = (b || sz) ? `<w:rPr>${b ? "<w:b/>" : ""}${sz ? `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>` : ""}</w:rPr>` : "";
    return `<w:r>${rPr}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`;
  }).join("");
}

// parseInline 줄들(줄=runs) → 문단 내부(줄 사이 <w:br/>).
function paraInnerXml(text, opts) {
  const lines = parseInline(text);
  return lines.map((runs) => runsXml(runs, opts))
    .join('<w:r><w:br/></w:r>');
}

function paraXml(text, { heading = 0 } = {}) {
  const sz = heading === 1 ? 30 : heading === 2 ? 26 : heading >= 3 ? 24 : null;
  const pPr = heading ? '<w:pPr><w:spacing w:before="160" w:after="60"/></w:pPr>' : "";
  return `<w:p>${pPr}${paraInnerXml(text, { bold: !!heading, sz })}</w:p>`;
}

const BORDER = '<w:top w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>'
  + '<w:left w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>'
  + '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>'
  + '<w:right w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>'
  + '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>'
  + '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>';

function cellXml(text, { headerCell = false } = {}) {
  const shd = headerCell ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F6FA"/>' : "";
  const tcPr = `<w:tcPr><w:tcW w:w="0" w:type="auto"/>${shd}</w:tcPr>`;
  return `<w:tc>${tcPr}<w:p>${paraInnerXml(text, { bold: headerCell })}</w:p></w:tc>`;
}

function tableXml(header, rows) {
  const tblPr = `<w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${BORDER}</w:tblBorders></w:tblPr>`;
  const head = `<w:tr>${header.map((c) => cellXml(c, { headerCell: true })).join("")}</w:tr>`;
  const body = rows.map((r) => `<w:tr>${r.map((c) => cellXml(c)).join("")}</w:tr>`).join("");
  return `<w:tbl>${tblPr}${head}${body}</w:tbl>`;
}

function bodyXml(blocks) {
  const parts = [];
  for (const b of blocks) {
    if (b.type === "heading") parts.push(paraXml(b.text, { heading: b.level }));
    else if (b.type === "hr") parts.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="DDDDDD"/></w:pBdr></w:pPr></w:p>');
    else if (b.type === "ul") for (const it of b.items) parts.push(paraXml("• " + it));
    else if (b.type === "table") { parts.push(tableXml(b.header, b.rows)); parts.push("<w:p/>"); }
    else parts.push(paraXml(b.text));
  }
  parts.push('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>');
  return parts.join("");
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

/** 마크다운 → DOCX Blob. */
export async function buildDocxBlob(text) {
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml(parseBlocks(text))}</w:body></w:document>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.folder("_rels").file(".rels", RELS);
  zip.folder("word").file("document.xml", doc);
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}
