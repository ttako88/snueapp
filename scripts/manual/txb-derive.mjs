// ============================================================
// txb-derive.mjs — OPTION_E: 사전봉인 트랜잭션 중립 파생본 생성 (dev 전용)
// ============================================================
// GPT 판정 P-20260721-DEFECT1_EMPIRICAL_PROOF_DISPOSITION_01
//   DEFECT_1_VERDICT = CONFIRMED_FATAL_BY_EMPIRICAL_PROOF
//   TX_B_REDESIGN    = OPTION_E / PRESEALED_TRANSACTION_NEUTRAL_DERIVATIVE
//
// 문제:
//   001~005 는 각각 최상단 `begin;` 최하단 `commit;` 을 갖는 자기완결 트랜잭션이다.
//   하나의 outer transaction 안에서 실행하면 첫 `commit;` 이 outer 를 조기 종료시킨다.
//   (dev 실측 증명: SET LOCAL 소실 + "there is no transaction in progress")
//
// OPTION_E 원칙:
//   · 동결된 001~005 원본은 **그대로 보존**한다. 수정하지 않는다.
//   · dev 에서 wrapper 두 문장만 제거한 별도 파생본(TXB_BODY_RC1)을 만든다.
//   · 어휘 분석기가 주석·문자열·dollar-quoted 본문을 제외하고
//     "첫 최상위 BEGIN; / 마지막 최상위 COMMIT; / 그 밖의 최상위 트랜잭션 제어 0개"를 증명한다.
//   · 원본 SHA/blob, 제거한 exact byte span, 파생본 SHA 를 manifest 로 봉인한다.
//   · **운영에서는 변환하지 않는다.** 봉인된 파생 bytes 를 hash 검증 후 그대로 실행한다.
//
// 실행: node scripts/manual/txb-derive.mjs
// 종료: 0 = 파생 성공, 3 = 검증 실패(파생 안 함), 1 = 실행 실패
// ============================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const OUT = join(homedir(), "prod-runs", "TXB_BODY_RC1");
const MIGRATIONS = ["001_schemas_roles", "002_foundation", "003_functions_triggers",
                    "004_admin_batch_functions", "005_schedules"];

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const gitBlob = (buf) => createHash("sha1")
  .update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest("hex");
const line = (k, v) => console.log(`  ${String(k).padEnd(42)} ${v}`);
const head = (t) => console.log(`\n=== ${t} ===`);

const blocks = [];
const rec = (n, ok, d) => { if (!ok) blocks.push(n); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

// ── 어휘 분석기 ──────────────────────────────────────────────
// PostgreSQL 어휘 규칙을 지켜 최상위 문장 경계를 찾는다.
// 제외 대상: -- 줄주석 / 중첩 가능한 블록주석 / '문자열'(''이스케이프) /
//            E'...' (백슬래시 이스케이프) / "식별자" / $tag$ ... $tag$
function topLevelStatements(src) {
  const stmts = [];
  let i = 0, stmtStart = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i], c2 = src[i + 1];

    // 줄 주석
    if (c === "-" && c2 === "-") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    // 블록 주석 (중첩 가능)
    if (c === "/" && c2 === "*") {
      let depth = 1; i += 2;
      while (i < n && depth > 0) {
        if (src[i] === "/" && src[i + 1] === "*") { depth++; i += 2; }
        else if (src[i] === "*" && src[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    // dollar-quoted:  $$ ... $$  또는  $tag$ ... $tag$
    if (c === "$") {
      const m = /^\$[A-Za-z_-￿][A-Za-z0-9_-￿]*\$|^\$\$/.exec(src.slice(i));
      if (m) {
        const tag = m[0];
        const end = src.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        continue;
      }
    }
    // E'...' (백슬래시 이스케이프 허용)
    if ((c === "E" || c === "e") && c2 === "'") {
      i += 2;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    // '문자열' — '' 는 이스케이프된 작은따옴표
    if (c === "'") {
      i++;
      while (i < n) {
        if (src[i] === "'") {
          if (src[i + 1] === "'") { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      continue;
    }
    // "식별자" — "" 는 이스케이프
    if (c === '"') {
      i++;
      while (i < n) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      continue;
    }
    // 문장 종결
    if (c === ";") {
      const raw = src.slice(stmtStart, i + 1);
      if (raw.trim()) stmts.push({ start: stmtStart, end: i + 1, raw });
      stmtStart = i + 1;
      i++;
      continue;
    }
    i++;
  }
  const tail = src.slice(stmtStart);
  if (tail.trim()) stmts.push({ start: stmtStart, end: n, raw: tail });
  return stmts;
}

/** 문장에서 주석을 걷어낸 첫 키워드를 얻는다 */
function firstKeyword(raw) {
  const noComment = raw
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
  const m = /^\s*([A-Za-z_]+)/.exec(noComment);
  return m ? m[1].toUpperCase() : "";
}

/**
 * 문장 raw 안에서 **실제 키워드 토큰이 시작하는 위치**를 찾는다.
 *
 * 문장 span 은 직전 `;` 다음부터 시작하므로 앞선 주석·공백을 전부 포함한다.
 * 그대로 제거하면 "wrapper 두 문장만 제거"가 아니라 섹션 헤더 주석까지 지워진다.
 * 따라서 주석·공백을 건너뛴 첫 알파벳 위치를 반환해 그 지점부터만 제거한다.
 */
function keywordStartInRaw(raw) {
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const c = raw[i], c2 = raw[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "-" && c2 === "-") { const nl = raw.indexOf("\n", i); i = nl === -1 ? n : nl + 1; continue; }
    if (c === "/" && c2 === "*") {
      let depth = 1; i += 2;
      while (i < n && depth > 0) {
        if (raw[i] === "/" && raw[i + 1] === "*") { depth++; i += 2; }
        else if (raw[i] === "*" && raw[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    return i;   // 주석·공백이 아닌 첫 문자 = 키워드 시작
  }
  return -1;
}

const TX_CONTROL = new Set([
  "BEGIN", "COMMIT", "ROLLBACK", "START", "SAVEPOINT", "RELEASE", "END", "PREPARE", "ABORT",
]);

function analyze(name, src) {
  const stmts = topLevelStatements(src);
  const ctrl = stmts
    .map((s, idx) => ({ idx, kw: firstKeyword(s.raw), ...s }))
    .filter((s) => TX_CONTROL.has(s.kw));

  return { stmts, ctrl };
}

// ── 본체 ─────────────────────────────────────────────────────
head("OPTION_E — 파생본 생성 전 어휘 검증");
console.log("  대상: 001~005 (동결 원본은 수정하지 않는다)\n");

const manifest = {
  derivation: "OPTION_E / PRESEALED_TRANSACTION_NEUTRAL_DERIVATIVE",
  candidate: "TXB_BODY_RC1",
  created_at_utc: new Date().toISOString(),
  rc_base: "e9d1c75",
  note: "운영에서는 변환하지 않는다. 이 manifest 의 derivative_sha256 을 검증한 뒤 봉인된 bytes 를 그대로 실행한다.",
  files: {},
};

for (const m of MIGRATIONS) {
  const path = join(process.cwd(), `supabase/migrations/${m}.sql`);
  const buf = readFileSync(path);
  const src = buf.toString("utf8");
  const { stmts, ctrl } = analyze(m, src);

  console.log(`── ${m}`);
  line("최상위 문장 수", stmts.length);
  line("최상위 트랜잭션 제어문", ctrl.length ? ctrl.map((c) => `${c.kw}@stmt${c.idx}`).join(", ") : "0개");

  // 검증 1: 트랜잭션 제어문이 정확히 2개
  const ok2 = ctrl.length === 2;
  rec(`${m}: 최상위 트랜잭션 제어문 정확히 2개`, ok2, `${ctrl.length}개`);
  if (!ok2) { console.log(""); continue; }

  // 검증 2: 첫 번째가 최초 문장인 BEGIN
  const okFirst = ctrl[0].kw === "BEGIN" && ctrl[0].idx === 0;
  rec(`${m}: 첫 문장이 최상위 BEGIN`, okFirst, `stmt${ctrl[0].idx} = ${ctrl[0].kw}`);

  // 검증 3: 두 번째가 마지막 문장인 COMMIT
  const okLast = ctrl[1].kw === "COMMIT" && ctrl[1].idx === stmts.length - 1;
  rec(`${m}: 마지막 문장이 최상위 COMMIT`, okLast, `stmt${ctrl[1].idx}/${stmts.length - 1} = ${ctrl[1].kw}`);

  if (!okFirst || !okLast) { console.log(""); continue; }

  // 검증 4: BEGIN 문장에 다른 내용이 섞여 있지 않은가
  const beginBare = /^\s*begin\s*;\s*$/i.test(ctrl[0].raw.replace(/--[^\n]*/g, ""));
  const commitBare = /^\s*commit\s*;\s*$/i.test(ctrl[1].raw.replace(/--[^\n]*/g, ""));
  rec(`${m}: BEGIN 문장이 단독`, beginBare, JSON.stringify(ctrl[0].raw.trim()).slice(0, 40));
  rec(`${m}: COMMIT 문장이 단독`, commitBare, JSON.stringify(ctrl[1].raw.trim()).slice(0, 40));
  if (!beginBare || !commitBare) { console.log(""); continue; }

  // ── 파생: 키워드 토큰 span 만 제거 (앞선 주석은 보존) ──
  const bKw = keywordStartInRaw(ctrl[0].raw);
  const cKw = keywordStartInRaw(ctrl[1].raw);
  const beginSpan = { start: ctrl[0].start + bKw, end: ctrl[0].end };
  const commitSpan = { start: ctrl[1].start + cKw, end: ctrl[1].end };
  const beginText = src.slice(beginSpan.start, beginSpan.end);
  const commitText = src.slice(commitSpan.start, commitSpan.end);
  rec(`${m}: 제거 대상이 begin; 만`, /^begin\s*;$/i.test(beginText.trim()), JSON.stringify(beginText.trim()));
  rec(`${m}: 제거 대상이 commit; 만`, /^commit\s*;$/i.test(commitText.trim()), JSON.stringify(commitText.trim()));
  if (!/^begin\s*;$/i.test(beginText.trim()) || !/^commit\s*;$/i.test(commitText.trim())) { console.log(""); continue; }
  const derived = src.slice(0, beginSpan.start) + src.slice(beginSpan.end, commitSpan.start) + src.slice(commitSpan.end);
  const dbuf = Buffer.from(derived, "utf8");

  // 검증 5: 파생본에 최상위 트랜잭션 제어문이 0개
  const after = analyze(m + "(derived)", derived);
  rec(`${m}: 파생본의 최상위 트랜잭션 제어문 0개`, after.ctrl.length === 0,
    after.ctrl.length ? after.ctrl.map((c) => c.kw).join(",") : "0개");

  // 검증 6: 제거된 바이트가 두 토큰의 바이트 합계와 정확히 일치
  // (span 은 JS 문자열 인덱스=UTF-16 단위이고 파일 길이는 UTF-8 바이트다.
  //  한글이 섞이면 두 값이 어긋나므로 반드시 byteLength 로 비교한다.)
  const removedBytes = Buffer.byteLength(beginText, "utf8") + Buffer.byteLength(commitText, "utf8");
  rec(`${m}: 제거 바이트 == 토큰 바이트 합계`, buf.length - dbuf.length === removedBytes,
    `${buf.length - dbuf.length} vs ${removedBytes}`);

  // 검증 7: 제거분을 원위치에 재삽입하면 원본이 정확히 복원되는가
  const rebuilt = src.slice(0, beginSpan.start) + beginText
    + src.slice(beginSpan.end, commitSpan.start) + commitText + src.slice(commitSpan.end);
  rec(`${m}: 제거분 재삽입 시 원본 복원`, rebuilt === src);

  manifest.files[m] = {
    original: { bytes: buf.length, sha256: sha256(buf), git_blob: gitBlob(buf) },
    removed_spans: [
      { role: "outer_begin", start: beginSpan.start, end: beginSpan.end,
        utf16_length: beginSpan.end - beginSpan.start,
        utf8_bytes: Buffer.byteLength(beginText, "utf8"), text: beginText },
      { role: "outer_commit", start: commitSpan.start, end: commitSpan.end,
        utf16_length: commitSpan.end - commitSpan.start,
        utf8_bytes: Buffer.byteLength(commitText, "utf8"), text: commitText },
    ],
    derivative: { bytes: dbuf.length, sha256: sha256(dbuf), file: `${m}.body.sql` },
    top_level_statements: { original: stmts.length, derivative: after.stmts.length },
  };
  console.log("");
}

head("판정");
if (blocks.length) {
  console.log("TXB_DERIVATION=BLOCKED");
  console.log("파생본을 생성하지 않았다.");
  for (const b of blocks) console.log(`  · ${b}`);
  process.exit(3);
}

// ── 봉인 ─────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
try {
  execFileSync("icacls", [OUT, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:(OI)(CI)F`], { stdio: "ignore" });
} catch {}

for (const m of MIGRATIONS) {
  const f = manifest.files[m];
  const src = readFileSync(join(process.cwd(), `supabase/migrations/${m}.sql`), "utf8");
  const [b, c] = f.removed_spans;
  const derived = src.slice(0, b.start) + src.slice(b.end, c.start) + src.slice(c.end);
  writeFileSync(join(OUT, f.derivative.file), derived, "utf8");
}
const mj = JSON.stringify(manifest, null, 2);
writeFileSync(join(OUT, "DERIVATION_MANIFEST.json"), mj, "utf8");
const sums = [...MIGRATIONS.map((m) => `${manifest.files[m].derivative.sha256}  ${manifest.files[m].derivative.file}`),
               `${sha256(Buffer.from(mj, "utf8"))}  DERIVATION_MANIFEST.json`].join("\n") + "\n";
writeFileSync(join(OUT, "SHA256SUMS.txt"), sums, "utf8");

console.log("TXB_DERIVATION=PASS");
console.log(`OUTPUT_DIR=${OUT}`);
console.log("");
for (const m of MIGRATIONS) {
  const f = manifest.files[m];
  console.log(`${m}`);
  console.log(`  original   ${f.original.bytes}B / sha256 ${f.original.sha256}`);
  console.log(`  derivative ${f.derivative.bytes}B / sha256 ${f.derivative.sha256}`);
  console.log(`  removed    ${f.removed_spans.map((s) => `${s.role}[${s.start}..${s.end})`).join(" ")}`);
}
console.log(`\nMANIFEST_SHA256=${sha256(Buffer.from(mj, "utf8"))}`);
console.log("\n동결 원본은 수정하지 않았다. 운영 실행 시에는 변환하지 않고 위 파생 bytes 를 hash 검증 후 사용한다.");
