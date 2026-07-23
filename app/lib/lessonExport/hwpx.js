// 지도안 마크다운 → 네이티브 한글(.hwpx). public/hwp/base.hwpx 를 검증된 서식으로
// 로드해 **본문(section0.xml)만 교체**하고 나머지(header·version·manifest…)는 그대로
// 재압축한다. 한글이 이미 여는 부분을 최대한 재사용해 유효성을 지킨다.
// 표는 서식에 들어 있던 셀 구조를 복제해 생성.
import JSZip from "jszip";
import { parseBlocks, parseInline } from "./parseBlocks.js";

const TEMPLATE_URL = "/hwp/base.hwpx";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// hwpx v1: 굵게·줄바꿈은 텍스트로 평탄화(한 줄). <br>→공백, **굵게**→일반.
const plain = (text) => parseInline(text).map((runs) => runs.map((r) => r.text).join("")).join(" ").trim();

// ⚠️ 생성 문단에는 linesegarray(줄 위치 캐시)를 넣지 않는다. 넣으면 vertpos 를
//    정확히 계산해야 하고, 틀리면 한글이 그 캐시대로 그려 글자가 겹친다(실측).
//    빼두면 한글이 열 때 스스로 배치한다. (서식의 첫 문단 캐시는 그대로 둔다.)

// 일반 문단
function paraXml(text) {
  const t = esc(plain(text));
  return `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${t}</hp:t></hp:run></hp:p>`;
}

// 표 — base.hwpx 셀 구조 복제. 머리행(ri=0) header="1".
const TBL_W = 41952;
function cellXml(text, ci, ri, cellW) {
  const t = esc(plain(text));
  const inner = `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${t}</hp:t></hp:run></hp:p>`;
  return `<hp:tc name="" header="${ri === 0 ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="3"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${inner}</hp:subList><hp:cellAddr colAddr="${ci}" rowAddr="${ri}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${cellW}" height="282"/><hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>`;
}
function tableXml(header, rows) {
  const all = [header, ...rows];
  const colCnt = Math.max(1, ...all.map((r) => r.length));
  const rowCnt = all.length;
  const cellW = Math.floor(TBL_W / colCnt);
  const trs = all.map((row, ri) => {
    let tcs = "";
    for (let ci = 0; ci < colCnt; ci++) tcs += cellXml(row[ci] ?? "", ci, ri, cellW);
    return `<hp:tr>${tcs}</hp:tr>`;
  }).join("");
  const tbl = `<hp:tbl id="1148708121" zOrder="1" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${rowCnt}" colCnt="${colCnt}" cellSpacing="0" borderFillIDRef="3" noAdjust="0"><hp:sz width="${TBL_W}" widthRelTo="ABSOLUTE" height="${282 * rowCnt}" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="283" right="283" top="283" bottom="283"/><hp:inMargin left="510" right="510" top="141" bottom="141"/>${trs}</hp:tbl>`;
  // 표는 문단의 run 안에 들어간다(base.hwpx 와 동일 구조).
  return `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${tbl}<hp:t/></hp:run></hp:p>`;
}

// 블록 → 본문 문단들
function blocksToBody(blocks) {
  const parts = [];
  for (const b of blocks) {
    if (b.type === "heading") parts.push(paraXml(b.text));
    else if (b.type === "hr") parts.push(paraXml("────────"));
    else if (b.type === "ul") for (const it of b.items) parts.push(paraXml("· " + it));
    else if (b.type === "table") parts.push(tableXml(b.header, b.rows));
    else if (b.type === "p") parts.push(paraXml(b.text));
  }
  return parts.join("");
}

/**
 * 서식 section0.xml 의 본문을 교체한다.
 * 첫 <hp:p>(secPr 포함)는 보존하되 제목 텍스트만 갈아끼우고, 그 뒤 전부를 생성 본문으로.
 */
export function fillSection(templateSection0, text) {
  const openM = templateSection0.match(/^([\s\S]*?<hs:sec[^>]*>)/);
  if (!openM) return templateSection0; // 구조가 예상과 다르면 원본 유지(빈 서식 다운로드)
  const open = openM[1];
  const afterOpen = templateSection0.slice(open.length);
  const endFirst = afterOpen.indexOf("</hp:p>");
  if (endFirst < 0) return templateSection0;
  let firstPara = afterOpen.slice(0, endFirst + "</hp:p>".length);

  // 제목: 첫 문단의 <hp:t>지도안</hp:t> 을 문서 제목으로 교체(있을 때만)
  const blocks = parseBlocks(text);
  const titleBlock = blocks.find((b) => b.type === "heading");
  const title = esc(plain(titleBlock?.text || "지도안"));
  firstPara = firstPara.replace(/(<hp:t>)[\s\S]*?(<\/hp:t>)/, `$1${title}$2`);

  const body = blocksToBody(blocks);
  return `${open}${firstPara}${body}</hs:sec>`;
}

/** 마크다운 → .hwpx Blob (public/hwp/base.hwpx 서식 필요). */
export async function buildHwpxBlob(text, fetchImpl = fetch) {
  const resp = await fetchImpl(TEMPLATE_URL);
  if (!resp.ok) throw new Error("hwpx template not found");
  const buf = await resp.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const tpl = await zip.file("Contents/section0.xml").async("string");
  zip.file("Contents/section0.xml", fillSection(tpl, text));
  // 나머지 엔트리(mimetype 포함)는 원 순서·무압축(STORE 기본) 그대로 재압축.
  return zip.generateAsync({ type: "blob", mimeType: "application/hwp+zip" });
}
