// ============================================================
// parse-hwp-schools.mjs — 교육실습 협력학교 배정현황표(hwp)에서 학교명 추출
// ============================================================
// HWP 5.0 은 OLE 복합문서(CFB)이고 BodyText/Section* 스트림이 raw-deflate 로
// 압축돼 있다. 전용 라이브러리 없이 최소 파서로 텍스트만 긁어낸다.
//
// 완전한 HWP 파서가 아니다 — 표 구조·서식은 버리고 **한글 문자열만** 모은다.
// 학교 목록처럼 "이름만 필요한" 용도에는 이 정도로 충분하고,
// 결과는 사람이 눈으로 검수해야 한다 (자동 신뢰 금지).
// ============================================================
import { readFileSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";
import { resolve } from "node:path";

const SRC = process.argv[2];
if (!SRC) {
  console.error("사용법: node parse-hwp-schools.mjs <hwp 경로> [출력.json]");
  process.exit(1);
}
const OUT = process.argv[3] || null;

const b = readFileSync(resolve(SRC));
if (b.subarray(0, 4).toString("hex") !== "d0cf11e0") {
  console.error("[중단] HWP 5.0(OLE) 파일이 아닙니다.");
  process.exit(1);
}

// ── 최소 CFB 파서 ───────────────────────────────────────────
const SEC = 1 << b.readUInt16LE(0x1e);
const dirStart = b.readUInt32LE(0x30);
const fatCount = b.readUInt32LE(0x2c);

const fat = [];
for (let i = 0; i < Math.min(fatCount, 109); i++) {
  const s = b.readUInt32LE(0x4c + i * 4);
  if (s > 0xfffffffa) continue;
  const off = (s + 1) * SEC;
  for (let j = 0; j < SEC / 4 && off + j * 4 + 4 <= b.length; j++) {
    fat.push(b.readUInt32LE(off + j * 4));
  }
}

function chain(start) {
  const out = [];
  let s = start, guard = 0;
  while (s < 0xfffffffe && guard++ < 200000) {
    out.push(s);
    s = fat[s] ?? 0xfffffffe;
  }
  return out;
}
const sectorBuf = (s) => b.subarray((s + 1) * SEC, (s + 2) * SEC);
const readStream = (start, size) =>
  Buffer.concat(chain(start).map(sectorBuf)).subarray(0, size);

// ── 디렉터리 엔트리 ─────────────────────────────────────────
const dirBuf = Buffer.concat(chain(dirStart).map(sectorBuf));
const entries = [];
for (let o = 0; o + 128 <= dirBuf.length; o += 128) {
  const nameLen = dirBuf.readUInt16LE(o + 64);
  if (nameLen < 2) continue;
  entries.push({
    name: dirBuf.subarray(o, o + nameLen - 2).toString("utf16le"),
    type: dirBuf[o + 66],
    start: dirBuf.readUInt32LE(o + 116),
    size: dirBuf.readUInt32LE(o + 120),
  });
}

const sections = entries.filter((e) => /^Section\d+$/.test(e.name));
console.log(`섹션 ${sections.length}개 발견`);

// ── 텍스트 추출 ─────────────────────────────────────────────
// 한글·영숫자·공백만 남기고 나머지는 구분자로 바꾼다.
const SEP = "";
let chunks = [];
for (const s of sections) {
  const raw = readStream(s.start, s.size);
  let inf = null;
  for (const fn of [zlib.inflateRawSync, zlib.inflateSync]) {
    try { inf = fn(raw); break; } catch { /* 다음 방식 시도 */ }
  }
  if (!inf) { console.log(`  ${s.name}: 압축 해제 실패 — 건너뜀`); continue; }

  let buf = "";
  for (let i = 0; i + 1 < inf.length; i += 2) {
    const c = inf.readUInt16LE(i);
    const keep =
      (c >= 0xac00 && c <= 0xd7a3) ||   // 한글 음절
      (c >= 0x3131 && c <= 0x318e) ||   // 자모
      (c >= 0x30 && c <= 0x39) ||       // 숫자
      (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) ||
      c === 0x20 || c === 0x28 || c === 0x29;  // 공백·괄호
    buf += keep ? String.fromCharCode(c) : SEP;
  }
  chunks.push(buf);
  console.log(`  ${s.name}: ${inf.length}바이트 해제`);
}

const tokens = [...new Set(
  chunks.join(SEP).split(SEP).map((t) => t.trim()).filter((t) => t.length >= 2)
)];

// 학교로 보이는 토큰 — 초등학교 이름 규칙
const schools = tokens.filter((t) => /초등학교$/.test(t) && t.length <= 20);
const maybe = tokens.filter((t) => /초$/.test(t) && !/초등학교$/.test(t) && t.length <= 12);

// --dump 를 주면 전체 토큰을 그대로 보여 준다 (표 구조 파악용)
if (process.argv.includes("--dump")) {
  console.log(`\n[전체 토큰 ${tokens.length}개]`);
  tokens.forEach((t, i) => console.log(`  ${String(i).padStart(3)} | ${t}`));
}

console.log(`\n토큰 ${tokens.length}개 / 초등학교 ${schools.length}개 / 축약형 후보 ${maybe.length}개\n`);
for (const s of schools.sort()) console.log("  " + s);
if (maybe.length) {
  console.log("\n[축약형 후보 — 눈으로 확인 필요]");
  for (const s of maybe.sort().slice(0, 30)) console.log("  " + s);
}

if (OUT) {
  writeFileSync(OUT, JSON.stringify({
    source: SRC,
    parsedAt: new Date().toISOString(),
    note: "최소 HWP 파서로 추출. 사람이 검수해야 함 — 자동 신뢰 금지.",
    schools: schools.sort(),
    maybeAbbrev: maybe.sort(),
  }, null, 2), "utf8");
  console.log(`\n저장: ${OUT}`);
}
