// ============================================================
// lessonData.mjs — 지도안 근거 데이터 로더 (서버 전용)
// ============================================================
// docs/LESSON_DATA_CONTRACT.md 의 구현체다. 문서와 어긋나면 문서를 고친다.
//
// 설계 원칙 — 이 프로젝트에서 반복해 데인 것들이라 명시해 둔다
//   ① **파일이 없으면 조용히 건너뛴다.** 데이터가 없어도 지도안 생성은
//      동작해야 한다. 있으면 품질이 올라가는 구조지 전제조건이 아니다.
//   ② **파싱 실패를 빈 배열·기본값으로 덮지 않는다.** 탈락한 행은 이유와 함께
//      남긴다. 조용히 0건이 되면 "데이터가 없다" 와 "읽는 데 실패했다" 를
//      구분할 수 없다 — ACL 파싱 때 정확히 이걸로 틀렸다.
//   ③ **탈락률이 높으면 파일 전체를 버린다.** 형식이 어긋난 파일을 절반만
//      먹는 게 제일 위험하다. 맞는 줄만 골라 쓰면 결과가 그럴듯해 보여서
//      틀린 걸 눈치채지 못한다.
// ============================================================
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SUBJECTS, TEACHING_MODELS } from "../../lessonPlan.js";

if (typeof window !== "undefined") {
  throw new Error("lessonData.mjs 는 서버 전용입니다");
}

// ⚠️ 경로를 **정적으로** 잡는다. 여기를 env 로 자유롭게 바꾸게 두었더니
//    Turbopack 트레이서가 "이 모듈이 어디를 읽을지 알 수 없다" 고 판단해
//    **프로젝트 전체를 서버 번들에 넣었다**(빌드 경고 "whole project was
//    traced unintentionally"). Vercel 배포 크기·콜드스타트에 직접 영향이 있다.
//
//    그래서 운영에서는 고정 경로만 쓰고, 테스트 override 는 개발에서만 연다.
//    검증기를 검증하려면 픽스처 폴더가 필요한데, 그 편의 때문에 운영 번들을
//    부풀릴 수는 없다.
const FIXED_DIR = join(process.cwd(), "app", "data", "lessonPrompt");
export const DATA_DIR = process.env.NODE_ENV === "production"
  ? FIXED_DIR
  : (process.env.LESSON_DATA_DIR || FIXED_DIR);

// 파일 전체를 버리는 기준. **비율과 절대건수를 둘 다** 넘어야 버린다.
//
// 처음엔 비율만 봤는데, 3행 중 1행이 틀리면 33% 라서 멀쩡한 2행까지
// 날아갔다. 데이터는 조각조각 쌓이므로 초기엔 파일이 작다 — 비율만 보면
// 작은 파일일수록 가혹해진다. 반대로 절대건수만 보면 큰 파일에서
// 형식이 통째로 어긋난 걸 놓친다. 그래서 둘 다 넘을 때만 버린다.
const MAX_DROP_RATE = 0.10;
const MIN_DROP_COUNT = 5;

const MODEL_KEYS = new Set(TEACHING_MODELS.map((m) => m.key));
const SUBJECT_SET = new Set(SUBJECTS);
const GRADE_BANDS = new Set(["1-2학년군", "3-4학년군", "5-6학년군"]);
const CODE_RE = /^\[\d[가-힣]{1,3}\d{2}-\d{2}\]$/;

// ── CSV 파서 ────────────────────────────────────────────────
// 따옴표 안의 쉼표를 살려야 하므로 split(",") 로는 안 된다.
// 셀 안 줄바꿈은 계약에서 금지했으므로 지원하지 않는다 — 지원하면
// 형식을 어긴 파일이 조용히 통과한다.
function parseCsv(text) {
  const rows = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const cells = [];
    let cur = "", inQ = false;
    for (let i = 0; i < rawLine.length; i++) {
      const c = rawLine[i];
      if (inQ) {
        if (c === '"') {
          if (rawLine[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { cells.push(cur); cur = ""; }
      else cur += c;
    }
    cells.push(cur);
    rows.push(cells.map((s) => s.trim()));
  }
  return rows;
}

/**
 * 헤더가 있는 CSV 를 객체 배열로. 검증은 호출부가 한다.
 * @returns {{ ok: boolean, rows?: object[], reason?: string }}
 */
function readTable(file, required) {
  const path = join(DATA_DIR, file);
  if (!existsSync(path)) return { ok: false, reason: "없음" };

  let text;
  try { text = readFileSync(path, "utf8"); }
  catch (e) { return { ok: false, reason: `읽기 실패 — ${e.message}` }; }

  // BOM 은 첫 열 이름을 오염시킨다. 계약상 금지지만 흔한 실수라 걷어낸다.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const grid = parseCsv(text);
  if (grid.length < 2) return { ok: false, reason: "헤더뿐이거나 비어 있음" };

  const header = grid[0];
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length) {
    // 열 이름이 틀리면 행을 아무리 잘 만들어도 못 쓴다. 여기서 끊는 게
    // 반쯤 읽어서 이상한 결과를 내는 것보다 낫다.
    return { ok: false, reason: `열 이름 불일치 — 없는 열: ${missing.join(", ")}` };
  }

  const rows = grid.slice(1).map((cells, i) => {
    const o = { __line: i + 2 };
    header.forEach((h, j) => { o[h] = cells[j] ?? ""; });
    return o;
  });
  return { ok: true, rows };
}

/**
 * 행 단위 검증 공통 처리.
 * 탈락률이 임계치를 넘으면 **파일 전체를 버린다** (원칙 ③).
 */
function validateRows(rows, check) {
  const kept = [], dropped = [];
  for (const r of rows) {
    const why = check(r);
    if (why) dropped.push({ line: r.__line, why });
    else kept.push(r);
  }
  const rate = rows.length ? dropped.length / rows.length : 0;
  if (rate > MAX_DROP_RATE && dropped.length >= MIN_DROP_COUNT) {
    return {
      ok: false,
      reason: `탈락률 ${(rate * 100).toFixed(1)}% (${dropped.length}/${rows.length}) — 형식이 어긋난 것으로 보고 파일 전체를 쓰지 않습니다`,
      dropped,
    };
  }
  return { ok: true, rows: kept, dropped };
}

// ── 1. 성취기준 ─────────────────────────────────────────────
const STD_COLS = ["교과", "학년군", "영역", "성취기준코드", "성취기준"];

export function loadStandards() {
  if (!existsSync(DATA_DIR)) return { files: [], byCode: new Map(), issues: [] };

  const files = readdirSync(DATA_DIR).filter((f) => /^성취기준_.+\.csv$/.test(f));
  const byCode = new Map();
  const issues = [];
  const dupes = new Set();

  for (const f of files) {
    const t = readTable(f, STD_COLS);
    if (!t.ok) { issues.push({ file: f, reason: t.reason }); continue; }

    const v = validateRows(t.rows, (r) => {
      if (!SUBJECT_SET.has(r.교과)) return `모르는 교과 "${r.교과}"`;
      if (!GRADE_BANDS.has(r.학년군)) return `학년군 형식 "${r.학년군}"`;
      if (!CODE_RE.test(r.성취기준코드)) return `코드 형식 "${r.성취기준코드}"`;
      // 코드 앞자리(2/4/6)와 학년군이 어긋나면 옮기다 섞인 것이다.
      const band = r.성취기준코드[1];
      const want = { "1-2학년군": "2", "3-4학년군": "4", "5-6학년군": "6" }[r.학년군];
      if (band !== want) return `코드(${band})와 학년군(${r.학년군}) 불일치`;
      if (!r.영역) return "영역 비어 있음";
      if (r.성취기준.length < 5) return "성취기준이 너무 짧음(잘림 의심)";
      return null;
    });
    if (!v.ok) { issues.push({ file: f, reason: v.reason, dropped: v.dropped }); continue; }
    if (v.dropped.length) issues.push({ file: f, reason: `${v.dropped.length}행 탈락`, dropped: v.dropped });

    for (const r of v.rows) {
      if (byCode.has(r.성취기준코드)) {
        // 어느 쪽이 맞는지 알 수 없으므로 **둘 다** 버린다.
        dupes.add(r.성취기준코드);
        continue;
      }
      byCode.set(r.성취기준코드, {
        code: r.성취기준코드, subject: r.교과, band: r.학년군,
        area: r.영역, text: r.성취기준,
      });
    }
  }
  for (const c of dupes) {
    byCode.delete(c);
    issues.push({ file: "(여러 파일)", reason: `중복 코드 ${c} — 양쪽 다 제외` });
  }
  return { files, byCode, issues };
}

// ── 2. 단원 구성 ────────────────────────────────────────────
// v2는 교과서ID 열을 권장하지만, 이미 배포된 v1 CSV는 이 열 없이도 읽는다.
// 새 열이 없는 기존 행은 빈 ID로 해석해 과거 데이터와 자유 입력 흐름을 보존한다.
const UNIT_COLS = ["교과", "학년", "학기", "단원번호", "단원명",
                   "총차시", "차시번호", "차시명", "출판사"];

// 교과서 ID 는 원문 발행 식별자 기반의 선택 키다. 기존 v1 행은 빈 값이
// 허용된다. 다만 값이 있다면 URL·발행 식별자에서 만든 안정적인 slug 여야
// 한다. 자유 입력을 이 키로 오인하면 다른 책의 차시를 섞을 수 있으므로
// 길이와 문자 집합을 여기서 최소한으로 고정한다.
const TEXTBOOK_ID_RE = /^[a-z0-9][a-z0-9-]{2,119}$/;

export function loadUnits(knownCodes) {
  const t = readTable("단원구성.csv", UNIT_COLS);
  if (!t.ok) return { rows: [], issues: [{ file: "단원구성.csv", reason: t.reason }] };

  const seen = new Set();
  const issues = [];
  const v = validateRows(t.rows, (r) => {
    if (!SUBJECT_SET.has(r.교과)) return `모르는 교과 "${r.교과}"`;
    const g = Number(r.학년), s = Number(r.학기);
    if (!(g >= 1 && g <= 6)) return `학년 "${r.학년}"`;
    if (s !== 1 && s !== 2) return `학기 "${r.학기}"`;
    const total = Number(r.총차시), no = Number(r.차시번호);
    if (!(total > 0)) return `총차시 "${r.총차시}"`;
    if (!(no > 0)) return `차시번호 "${r.차시번호}"`;
    if (no > total) return `차시번호(${no}) > 총차시(${total})`;
    if (r.단원명.length < 2 || r.단원명.length > 40) return "단원명 길이";
    if (/^\d+\s*단원/.test(r.단원명)) return `단원명에 번호 포함 "${r.단원명}"`;
    if (r.차시명.length < 2 || r.차시명.length > 40) return "차시명 길이";
    if (!r.출판사) return "출판사 비어 있음";
    if (r.교과서ID && !TEXTBOOK_ID_RE.test(r.교과서ID)) return `교과서ID 형식 "${r.교과서ID}"`;
    const key = `${r.교과}/${g}/${s}/${r.단원번호}/${no}/${r.출판사}/${r.교과서ID}`;
    if (seen.has(key)) return "중복 (교과·학년·학기·단원·차시·출판사·교과서ID)";
    seen.add(key);
    return null;
  });
  if (!v.ok) return { rows: [], issues: [{ file: "단원구성.csv", reason: v.reason, dropped: v.dropped }] };
  if (v.dropped.length) issues.push({ file: "단원구성.csv", reason: `${v.dropped.length}행 탈락`, dropped: v.dropped });

  let unknownCodes = 0;
  const rows = v.rows.map((r) => {
    // 코드가 성취기준 표에 없으면 **코드만 비우고 행은 살린다.**
    // 단원·차시 정보 자체는 코드 없이도 쓸모가 있다.
    const codes = (r.성취기준코드 ?? "").split(";").map((c) => c.trim()).filter(Boolean);
    const valid = knownCodes ? codes.filter((c) => knownCodes.has(c)) : codes;
    unknownCodes += codes.length - valid.length;
    return {
      subject: r.교과, grade: Number(r.학년), term: Number(r.학기),
      unitNo: Number(r.단원번호), unit: r.단원명, totalPeriods: Number(r.총차시),
      periodNo: Number(r.차시번호), period: r.차시명,
      codes: valid, publisher: r.출판사, textbookId: r.교과서ID || "",
    };
  });
  if (unknownCodes) {
    issues.push({ file: "단원구성.csv",
      reason: `성취기준 표에 없는 코드 ${unknownCodes}건 — 코드만 비우고 행은 유지` });
  }
  return { rows, issues };
}

// ── 3. 평가 기준 ────────────────────────────────────────────
const EVAL_COLS = ["교과", "학년군", "성취기준코드", "평가요소", "상", "중", "하"];

export function loadRubrics(knownCodes) {
  const t = readTable("평가기준.csv", EVAL_COLS);
  if (!t.ok) return { byCode: new Map(), issues: [{ file: "평가기준.csv", reason: t.reason }] };

  const issues = [];
  const v = validateRows(t.rows, (r) => {
    if (!CODE_RE.test(r.성취기준코드)) return `코드 형식 "${r.성취기준코드}"`;
    if (knownCodes && !knownCodes.has(r.성취기준코드)) return `성취기준 표에 없는 코드 ${r.성취기준코드}`;
    if (r.평가요소.length < 2) return "평가요소 너무 짧음";
    for (const k of ["상", "중", "하"]) {
      if (r[k].length < 5) return `${k} 기준이 너무 짧음`;
    }
    return null;
  });
  if (!v.ok) return { byCode: new Map(), issues: [{ file: "평가기준.csv", reason: v.reason, dropped: v.dropped }] };
  if (v.dropped.length) issues.push({ file: "평가기준.csv", reason: `${v.dropped.length}행 탈락`, dropped: v.dropped });

  const byCode = new Map();
  for (const r of v.rows) {
    if (!byCode.has(r.성취기준코드)) byCode.set(r.성취기준코드, []);
    byCode.get(r.성취기준코드).push({
      element: r.평가요소, high: r.상, mid: r.중, low: r.하,
    });
  }
  return { byCode, issues };
}

// ── 4. 수업모형 전개 ────────────────────────────────────────
const STEP_COLS = ["모형키", "모형명", "단계번호", "단계명", "교사발화예시"];

export function loadModelSteps() {
  const t = readTable("모형전개.csv", STEP_COLS);
  if (!t.ok) return { byModel: new Map(), issues: [{ file: "모형전개.csv", reason: t.reason }] };

  const issues = [];
  const v = validateRows(t.rows, (r) => {
    if (!MODEL_KEYS.has(r.모형키)) return `모르는 모형키 "${r.모형키}"`;
    if (!(Number(r.단계번호) > 0)) return `단계번호 "${r.단계번호}"`;
    if (r.단계명.length < 2) return "단계명 너무 짧음";
    if (r.교사발화예시.length < 5) return "교사발화예시 너무 짧음";
    return null;
  });
  if (!v.ok) return { byModel: new Map(), issues: [{ file: "모형전개.csv", reason: v.reason, dropped: v.dropped }] };
  if (v.dropped.length) issues.push({ file: "모형전개.csv", reason: `${v.dropped.length}행 탈락`, dropped: v.dropped });

  const byModel = new Map();
  for (const r of v.rows) {
    if (!byModel.has(r.모형키)) byModel.set(r.모형키, []);
    byModel.get(r.모형키).push({
      no: Number(r.단계번호), name: r.단계명, utterance: r.교사발화예시,
      ratio: Number(r.권장시간비율) || null,
    });
  }
  for (const arr of byModel.values()) arr.sort((a, b) => a.no - b.no);
  return { byModel, issues };
}

// ── 전체 ────────────────────────────────────────────────────
/**
 * 있는 것만 읽어 온다. 하나도 없어도 정상 — 지도안 생성은 데이터 없이도 된다.
 * issues 는 **비어 있지 않은 것이 기본**이라고 보고, 호출부가 판단한다.
 */
export function loadAll() {
  const std = loadStandards();
  const units = loadUnits(std.byCode.size ? new Set(std.byCode.keys()) : null);
  const rubrics = loadRubrics(std.byCode.size ? new Set(std.byCode.keys()) : null);
  const steps = loadModelSteps();
  return {
    standards: std.byCode,
    units: units.rows,
    rubrics: rubrics.byCode,
    modelSteps: steps.byModel,
    issues: [...std.issues, ...units.issues, ...rubrics.issues, ...steps.issues],
    empty: std.byCode.size === 0 && units.rows.length === 0
        && rubrics.byCode.size === 0 && steps.byModel.size === 0,
  };
}
