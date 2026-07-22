// 단원구성 v2 마이그레이션: 기존 행은 교과서ID를 빈 값으로 보존하고,
// 원문 통합교과 550행만 masterSeq 기반 ID와 함께 합친다.
//
// 실행 전후의 필드별 보존·중복·인코딩 검증 영수증은 수집로그에 남긴다.
// 원문에 없는 성취기준코드는 절대 유추하지 않는다.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const corpus = "C:/Users/조상호/Desktop/수업지도안 AI 학습자료";
const canonical = join(corpus, "02_성취기준_구조화", "변환_csv", "단원구성.csv");
const raw = join(corpus, "08_교과서_단원구성", "통합교과_책별단원차시_구조보류.csv");
const app = "C:/Users/조상호/Desktop/클로드/snue-app/app/data/lessonPrompt/단원구성.csv";
const logDir = join(corpus, "00_수집로그");
const receipt = join(logDir, "통합교과_교과서ID_v2_마이그레이션_영수증.csv");
const report = join(logDir, "통합교과_교과서ID_v2_마이그레이션_검증.md");

const v1Header = ["교과", "학년", "학기", "단원번호", "단원명", "총차시", "차시번호", "차시명", "성취기준코드", "출판사"];
const v2Header = [...v1Header, "교과서ID"];
const rawHeader = ["교과", "학년", "학기", "책명", "책내단원번호", "단원명", "책내총차시", "차시번호", "차시명", "출판사", "원본URL"];

function parseCsv(text) {
  const rows = [];
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line) continue;
    const cells = []; let cur = "", quote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') quote = false;
        else cur += c;
      } else if (c === '"') quote = true;
      else if (c === ",") { cells.push(cur); cur = ""; }
      else cur += c;
    }
    if (quote) throw new Error("닫히지 않은 따옴표");
    cells.push(cur); rows.push(cells);
  }
  return rows;
}

function csv(rows) {
  return rows.map((row) => row.map((v) => {
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  }).join(",")).join("\n") + "\n";
}
function sha(path) { return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase(); }
function assertHeader(rows, expected, source) {
  if (!rows.length || rows[0].join("\u0000") !== expected.join("\u0000")) {
    throw new Error(`${source}: 헤더 불일치`);
  }
}
function asObjects(rows) {
  const [header, ...body] = rows;
  return body.map((cells, i) => Object.fromEntries(header.map((h, j) => [h, cells[j] ?? ""]), { __line: i + 2 }));
}
function key(r) { return v2Header.map((h) => r[h] ?? "").join("\u0001"); }

if (!existsSync(canonical) || !existsSync(raw) || !existsSync(app)) throw new Error("입력 CSV가 없습니다");
const canonicalBefore = parseCsv(readFileSync(canonical, "utf8"));
const appBefore = parseCsv(readFileSync(app, "utf8"));
assertHeader(canonicalBefore, v1Header, "canonical");
assertHeader(appBefore, v1Header, "app");
const canonicalRows = asObjects(canonicalBefore);
const appRows = asObjects(appBefore);
if (JSON.stringify(canonicalRows) !== JSON.stringify(appRows)) throw new Error("canonical/app v1 행이 서로 다릅니다");
if (canonicalRows.length !== 4746) throw new Error(`기존 행 수 예상과 다름: ${canonicalRows.length}`);

const rawRows = parseCsv(readFileSync(raw, "utf8"));
assertHeader(rawRows, rawHeader, "통합 원문");
const integrated = asObjects(rawRows).map((r) => {
  const seq = /[?&]masterSeq=(\d+)/.exec(r.원본URL)?.[1];
  if (!seq) throw new Error(`원문 ${r.__line}행 masterSeq 없음`);
  return {
    "교과": r.교과, "학년": r.학년, "학기": r.학기,
    "단원번호": r.책내단원번호, "단원명": r.단원명,
    "총차시": r.책내총차시, "차시번호": r.차시번호, "차시명": r.차시명,
    // 원문에는 단원·차시별 성취기준 근거가 없으므로 빈 값으로 유지한다.
    "성취기준코드": "", "출판사": r.출판사,
    "교과서ID": `mirae-2022-integrated-${r.학년}-${r.학기}-${seq}`,
  };
});
if (integrated.length !== 550) throw new Error(`통합 원문 행 수 예상과 다름: ${integrated.length}`);
const ids = new Set(integrated.map((r) => r.교과서ID));
if (ids.size !== 16) throw new Error(`통합 교과서ID 수 예상과 다름: ${ids.size}`);
if (integrated.some((r) => r.성취기준코드)) throw new Error("통합 원문에 코드가 채워졌습니다");

const migrated = [
  ...canonicalRows.map((r) => Object.fromEntries(v2Header.map((h) => [h, r[h] ?? ""]))),
  ...integrated,
];
if (migrated.length !== 5296) throw new Error(`최종 행 수 예상과 다름: ${migrated.length}`);
const unique = new Set(migrated.map(key));
if (unique.size !== migrated.length) throw new Error(`v2 중복 ${migrated.length - unique.size}행`);
if (migrated.slice(0, 4746).some((r) => r.교과서ID !== "")) throw new Error("기존 행 교과서ID가 비어 있지 않습니다");

const output = csv([v2Header, ...migrated.map((r) => v2Header.map((h) => r[h] ?? ""))]);
if (output.charCodeAt(0) === 0xfeff) throw new Error("BOM 생성");
writeFileSync(canonical, output, "utf8");
writeFileSync(app, output, "utf8");
if (sha(canonical) !== sha(app)) throw new Error("마이그레이션 후 canonical/app 해시 불일치");
mkdirSync(logDir, { recursive: true });
writeFileSync(receipt, csv([
  ["항목", "값", "비고"],
  ["기존_v1_행", 4746, "교과서ID 빈값 유지"],
  ["통합_원문_행", integrated.length, "성취기준코드 빈값 유지"],
  ["통합_교과서ID", ids.size, "원본URL masterSeq 기반"],
  ["최종_v2_행", migrated.length, "canonical/app 동일"],
  ["v2_중복", migrated.length - unique.size, "0이어야 함"],
  ["canonical_sha256", sha(canonical), "UTF-8 BOM 없음"],
  ["app_sha256", sha(app), "canonical과 동일"],
]));
writeFileSync(report, `# 통합교과 교과서ID v2 마이그레이션 검증\n\n- 기존 v1 행: **4,746행**, 교과서ID는 모두 빈 값으로 보존\n- 통합 원문: **550행**, 원본 URL의 \`masterSeq\`으로 만든 교과서ID **16종**\n- 최종 v2: **5,296행**, v2 식별키 중복 **0행**\n- 통합 원문의 성취기준코드는 단원·차시별 직접 근거가 없어 **전부 빈 값**으로 유지\n- canonical/app 단원구성 CSV SHA-256: \`${sha(canonical)}\` (동일)\n- 인코딩: UTF-8, BOM 없음\n\n원문: \`08_교과서_단원구성/통합교과_책별단원차시_구조보류.csv\`\n`);
console.log(JSON.stringify({ rows: migrated.length, integrated: integrated.length, ids: ids.size, sha256: sha(canonical) }, null, 2));
