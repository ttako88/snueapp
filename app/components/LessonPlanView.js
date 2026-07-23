"use client";
import { useState } from "react";
// ============================================================
// LessonPlanView — AI 지도안(마크다운)을 약안·세안 폼으로 렌더 (S/지도안 #1)
// ============================================================
// AI 는 마크다운을 낸다: `## 제목`, 표(`| a | b |` + `|---|`), `**굵게**`,
// `<br>`(칸 안 줄바꿈), `---`(구분선), `- 목록`. 이걸 <pre> 로 그대로 뿌리면
// 표 기호·<br> 가 글자로 보여 가독성이 바닥이다. 여기서 진짜 표·제목·구분선으로
// 그려 "캡처해서 바로 제출 폼처럼" 쓸 수 있게 한다. 외부 마크다운 라이브러리를
// 쓰지 않는다(번들·CSP 최소화) — 지도안이 쓰는 문법만 좁게 처리한다.

// **굵게** 와 <br> 만 인라인 처리(그 외 텍스트는 그대로). 안전을 위해 dangerous
// HTML 은 만들지 않고 React 노드로 만든다.
function inline(text, keyBase) {
  // <br> 로 먼저 나눈다(칸 안 줄바꿈).
  const lines = String(text).split(/<br\s*\/?>/i);
  return lines.map((line, li) => {
    // **굵게** 처리
    const parts = line.split(/(\*\*[^*]+\*\*)/g).filter((s) => s !== "");
    const nodes = parts.map((p, pi) => {
      const m = /^\*\*([^*]+)\*\*$/.exec(p);
      if (m) return <strong key={`${keyBase}-${li}-${pi}`}>{m[1]}</strong>;
      return <span key={`${keyBase}-${li}-${pi}`}>{p}</span>;
    });
    return (
      <span key={`${keyBase}-${li}`}>
        {li > 0 && <br />}
        {nodes}
      </span>
    );
  });
}

function splitRow(line) {
  // | a | b | c | → [a,b,c] (양끝 파이프 제거, 셀 트림)
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}
const isTableSep = (line) => /^\s*\|?[\s:-]*\|[\s:|-]*$/.test(line) && line.includes("-");
const isTableRow = (line) => line.trim().startsWith("|");

export default function LessonPlanView({ text }) {
  if (!text) return null;
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 표: 헤더행 + 구분행 + 데이터행들
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]) && !isTableSep(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
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

  return (
    <div className="flex flex-col gap-2">
      <ExportBar text={text} />
      <div className="lp-view flex flex-col gap-2 text-[13px] leading-relaxed text-[#0c4470]">
      {blocks.map((b, bi) => {
        if (b.type === "heading") {
          const size = b.level <= 1 ? "text-base" : b.level === 2 ? "text-sm" : "text-[13px]";
          return (
            <p key={bi} className={`mt-2 font-bold text-[#0c4470] ${size}`}>
              {inline(b.text, `h${bi}`)}
            </p>
          );
        }
        if (b.type === "hr") return <hr key={bi} className="my-1 border-black/10" />;
        if (b.type === "ul") {
          return (
            <ul key={bi} className="ml-4 list-disc space-y-0.5">
              {b.items.map((it, ii) => <li key={ii}>{inline(it, `li${bi}-${ii}`)}</li>)}
            </ul>
          );
        }
        if (b.type === "table") {
          return (
            <div key={bi} className="overflow-x-auto">
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr>
                    {b.header.map((c, ci) => (
                      <th key={ci} className="border border-black/10 bg-[#f2f6fa] px-2 py-1.5 text-left font-bold text-[#0c4470]">
                        {inline(c, `th${bi}-${ci}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, ri) => (
                    <tr key={ri}>
                      {r.map((c, ci) => (
                        <td key={ci} className="border border-black/10 px-2 py-1.5 align-top">
                          {inline(c, `td${bi}-${ri}-${ci}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return <p key={bi}>{inline(b.text, `p${bi}`)}</p>;
      })}
      </div>
    </div>
  );
}

// 내보내기 바 — 지금 보고 있는 지도안을 파일로 저장. 클라이언트에서 바로
// 생성·다운로드(서버 부하 0). jszip 은 동적 import 로 코드분할한다.
function ExportBar({ text }) {
  const [busy, setBusy] = useState(null); // 'docx' | 'hwpx' | null
  const [err, setErr] = useState(null);
  if (!text) return null;

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function save(fmt) {
    setErr(null); setBusy(fmt);
    try {
      const { titleFromText } = await import("../lib/lessonExport/parseBlocks");
      const title = titleFromText(text);
      if (fmt === "docx") {
        const { buildDocxBlob } = await import("../lib/lessonExport/docx");
        download(await buildDocxBlob(text), `${title}.docx`);
      } else {
        const { buildHwpxBlob } = await import("../lib/lessonExport/hwpx");
        download(await buildHwpxBlob(text), `${title}.hwpx`);
      }
    } catch {
      setErr(fmt === "hwpx"
        ? "한글 파일 생성에 실패했어요. Word(.docx)로 저장해 주세요."
        : "저장에 실패했어요. 잠시 뒤 다시 시도해 주세요.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button onClick={() => save("docx")} disabled={!!busy}
        className="rounded-lg bg-[#0095da] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">
        {busy === "docx" ? "저장 중…" : "📄 Word(.docx)"}
      </button>
      <button onClick={() => save("hwpx")} disabled={!!busy}
        className="rounded-lg border border-[#0095da]/40 bg-white px-3 py-1.5 text-xs font-bold text-[#0095da] disabled:opacity-50">
        {busy === "hwpx" ? "저장 중…" : "📝 한글(.hwpx) 베타"}
      </button>
      <span className="text-[11px] text-[#0c4470]/45">Word는 한글에서도 열려요</span>
      {err && <span className="text-[11px] font-bold text-red-500">{err}</span>}
    </div>
  );
}
