// 2022~2024 강의시간표 파서 (고학번·복학생 조회용)
// 실행: node scripts/data/parse-timetables-2022-2024.js [출력경로]
//   원본 xlsx: assets/nightwork/  ·  xlsx 모듈: npm i --no-save --ignore-scripts xlsx
//
// 원본 셀은 줄바꿈으로 구분된 항목들인데 **순서가 일정하지 않다.** 실측한 변형:
//   월12 한국의역사와문화 D 교양 연강104 오희은      (2022: 강의실→교수)
//   월34 삶과철학의이해   A 교양 변순용  연강104      (2023: 교수→강의실)
//   월1  피아노교육론     A 음201 전공 최영미 …       (강의실이 이수영역보다 앞)
//   수34 초등컴퓨팅교육교재연구 C 전산5 신승기        (이수영역 자체가 없음)
// 그래서 "몇 번째 토큰"이 아니라 **토큰의 생김새(마커)**로 판정한다.
//   - 분반  = 대문자 한 글자
//   - 이수영역 = 교양/교직/전공/심화
//   - 강의실 = 방 코드꼴(연강104·E-401·전산4·인문관305호·음202/302) 또는 시설어(체육관·에듀웰)
//   - 나머지 = 교수  (김주한(8~15)/신주희(1-7) 처럼 숫자가 섞여도 괄호·쉼표가 있으면 사람)
//   - 과목명 = 첫 마커 이전. 단 첫 토큰은 무조건 이름(21세기뉴미디어의평화학 같은 숫자 이름 보호)
//
// reqGroup(이수요건 택1)은 2022·2023 교육과정이 2026과 달라 null로 둔다.
const fs = require("fs");
const XLSX = require("C:/Users/조상호/Desktop/클로드/snue-app/node_modules/xlsx");

const DIR = "C:/Users/조상호/Desktop/클로드/assets/nightwork/";
const FILES = [
  ["2022-1", "2022-1.xlsx"], ["2022-2", "2022-2.xlsx"],
  ["2023-1", "2023-1.xlsx"], ["2023-2", "2023-2.xlsx"],
  ["2024-1", "2024-1.xlsx"], ["2024-2", "2024-2.xlsx"],
];
const DAY_RE = /^([월화수목금])([1-8]+)$/;
const TYPES = ["교양", "교직", "전공", "심화"];
const SHEET_RE = /^[1-4][AB]$/;
const FACILITY = /^(체육관|운동장|강당|대강당|에듀웰|무용실|수영장|주체육관)/;
// 교수명 칸에 섞여 들어오는 표시 마커 (사람 이름이 아님)
// ("강사"는 넣지 않는다 — 마커가 아니라 "담당 강사 미정"이라는 실제 정보다.
//  지우면 교수칸이 빈칸이 되어 정보가 오히려 줄어든다.)
const MARKERS = new Set(["심자", "심화자유선택", "가상", "원격", "비대면", "온라인"]);

// 방 코드 한 조각: (한글/영문 접두 0~6자)(-?)(숫자)(호|층)?  예) 연강104, E-401, 전산4, 인문관305호
const ROOM_PART = /^[A-Za-z가-힣]{0,6}-?\d+(호|층|관)?$/;
function looksRoom(t) {
  if (!t) return false;
  if (/[(),]/.test(t)) return false;            // 괄호·쉼표가 있으면 사람 이름 쪽
  if (FACILITY.test(t)) return true;
  if (/^[가-힣]{2,6}(관|실)$/.test(t)) return true; // 인문관, 전산실 …
  return t.split("/").every((p) => ROOM_PART.test(p)); // 음202/302 허용
}

function normDept(label) {
  if (!label) return "";
  if (/공통/.test(label)) return "공통";
  return label.replace(/^[0-9]+\s*[AB]?\s*[-·]?\s*/, "").replace(/\./g, "").trim();
}

// 건물명이 강의실 번호와 따로 떨어져 들어오는 경우가 있다 ("융합" + "세미나1").
// 그대로 두면 "융합"이 교수명으로 흘러가므로 뒤 토큰과 붙여 한 덩어리로 만든다.
const BUILDING = /^(융합|연강|인문|전산|사범|예술|과학|체육|에듀|음악|미술|복합|본관)$/;
function mergeBuildingTokens(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (BUILDING.test(tokens[i]) && i + 1 < tokens.length && /\d/.test(tokens[i + 1])) {
      out.push(tokens[i] + tokens[i + 1]);
      i++;
    } else out.push(tokens[i]);
  }
  return out;
}

function parseCell(text) {
  const tokens = mergeBuildingTokens(String(text).replace(/\s+/g, " ").trim().split(" "));
  const m = DAY_RE.exec(tokens[0]);
  if (!m) return null;
  const rest = tokens.slice(1).filter(Boolean);
  if (!rest.length) return null;

  // 첫 마커 위치 — index 0은 항상 이름으로 본다
  let mi = rest.length;
  for (let i = 1; i < rest.length; i++) {
    const t = rest[i];
    if (/^[A-Z]$/.test(t) || TYPES.includes(t) || looksRoom(t)) { mi = i; break; }
  }
  const name = rest.slice(0, mi).join(" ").replace(/\s+/g, "");
  if (!name) return null;

  let section = "", type = "", room = "";
  const profs = [];
  for (const t of rest.slice(mi)) {
    if (!section && /^[A-Z]$/.test(t)) { section = t; continue; }
    if (!type && TYPES.includes(t)) { type = t; continue; }
    if (looksRoom(t)) { if (!room) room = t; continue; }   // 첫 강의실만 채택(중복 기재 잔재 무시)
    profs.push(t);
  }
  // 교수명 정리
  //  ① 강의실 문자열이 들러붙은 잔재 제거 ("음201최영미" — 원본이 같은 정보를 두 번 적은 셀)
  //  ② 같은 이름 중복 제거 ("이보림 이보림")
  //  ③ 잔여 쉼표 정리 ("이도흥," + "이문진" → "이도흥, 이문진")
  //  ④ 교수명이 아닌 표시 마커 제거 ("심자"=심화자유선택, "가상"=가상강의 등)
  const cleaned = [...new Set(
    profs.filter((t) => !room || !t.includes(room)).filter((t) => !MARKERS.has(t)),
  )];
  let professor = cleaned.join(" ").replace(/\s*,\s*/g, ", ").replace(/[,\s]+$/, "").trim();

  // 구분자가 아예 없이 뭉친 셀 구제: "통섭의방법으로동화읽기(A)김도남",
  // "대중문화속의춤(A)이정연융합-무용실" 처럼 이름·분반·교수·강의실이 한 덩어리인 경우.
  // 괄호 안이 **대문자 한 글자**일 때만 분반으로 본다 —
  // "동화읽는노마드(nomad)독자되기", "체육실기지도I(육상.체조)" 같은 정상 괄호를 보호.
  let outName = name;
  const jam = /^(.+?)\(([A-Z])\)(.*)$/.exec(name);
  if (jam) {
    outName = jam[1];
    if (!section) section = jam[2];
    const tail = jam[3];
    if (tail) {
      // 교수명 뒤에 강의실이 붙은 경우 분리 (융합-무용실, 연강, 전산5 …)
      const cut = tail.search(/(융합|연강|전산|인문|체육|복합|에듀|음\d|미\d|과학|[A-Z]-?\d)/);
      if (cut > 0) {
        if (!professor) professor = tail.slice(0, cut);
        if (!room) room = tail.slice(cut);
      } else if (!professor) professor = tail;
    }
  }
  // "성영실"처럼 사람 이름이 실/관으로 끝나 강의실로 오판되는 경우 되돌린다.
  // 교수가 비어 있고 강의실이 한글 3글자뿐이면 사람일 가능성이 훨씬 높다.
  if (!professor && /^[가-힣]{3}$/.test(room)) { professor = room; room = ""; }

  return { name: outName, section, type, room, professor, day: m[1], periods: m[2].split("").map(Number) };
}

function parseWorkbook(buf, semester, stats) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const out = [];
  for (const sheet of wb.SheetNames) {
    if (!SHEET_RE.test(sheet)) { stats.skippedSheets.add(`${semester}:${sheet}`); continue; }
    const ws = wb.Sheets[sheet];
    if (!ws["!ref"]) continue;
    const range = XLSX.utils.decode_range(ws["!ref"]);
    const grade = Number(sheet[0]);
    const group = sheet[1];

    const deptByRow = {};
    let curDept = "";
    for (let R = range.s.r; R <= range.e.r; R++) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: 1 })];
      const v = cell && cell.v != null ? String(cell.v).replace(/\s+/g, " ").trim() : "";
      if (v) curDept = v;
      deptByRow[R] = normDept(curDept);
    }

    for (let R = range.s.r; R <= range.e.r; R++) {
      for (let C = range.s.c; C <= range.e.c; C++) {
        const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
        if (!cell || cell.v == null) continue;
        const p = parseCell(cell.v);
        if (!p) continue;
        out.push({ ...p, grade, group, dept: deptByRow[R], semester, reqGroup: null, groupLabel: null });
      }
    }
  }
  return out;
}

const OUT = process.argv[2] || "C:/Users/조상호/AppData/Local/Temp/claude/C--Users-----Desktop----/9e2188aa-1ff7-4316-bcb0-55bbd54c8a8f/scratchpad/parsed_legacy.json";
const stats = { skippedSheets: new Set() };
let all = [];
for (const [sem, fname] of FILES) {
  const rows = parseWorkbook(fs.readFileSync(DIR + fname), sem, stats);
  console.log(`${sem}: ${rows.length}행`);
  all = all.concat(rows);
}

// ── 원본 셀에 이수영역이 아예 없는 과목들의 정답표 ──
// 근거: "입학년도별 교육과정.pdf" (2013~2023) 텍스트 대조.
//  · 교양 = 2022/2023 교육과정 교양 표의 "창의융합교육 (택1)" 묶음 (PDF 1726·1898~1902행)
//  · 심화 = 심화자유선택 목록(PDF 9992~10012행) 및 학과별 심화 표(윤리 6019~6022, 영상예술실습 8180)
//  · PDF에 없는 4과목(영화와AI윤리·동화읽는노마드·디지털사회에서의AI작곡그리고윤리·디지털과교사교육)은
//    시간표상 전부 dept=공통·2학년으로 창의융합 묶음과 동일 → 교양. 초등도덕과교육방법론/평가연구는
//    dept=윤리·3학년 → 심화.
const MANUAL_TYPE = new Map();
for (const n of ["통섭의방법으로동화읽기", "의사소통을위한비주얼씽킹", "예비교사를위한뮤지엄여행",
  "영화창작워크샵(영상으로글짓기)", "세계시민으로지구적상상하기", "대중문화속의춤", "스키의과학과공동체문화",
  "위대한교사", "창의성발견과개발", "복잡계이론으로아동문학작품읽기", "분단문학의평화학",
  "교육연극연극놀이워크숍", "인공지능과미래교육", "영화와AI윤리", "동화읽는노마드(nomad)독자되기",
  "디지털사회에서의AI작곡그리고윤리", "디지털과교사교육",
  // 2024-2 추가분 (2026 교양표의 자율교양·창의융합 묶음과 동일 계열)
  "「논어」와인성교육", "생성형AI로영화만들기", "심리기술훈련과배드민턴"]) MANUAL_TYPE.set(n, "교양");
for (const n of ["영상예술실습", "초등도덕과교육방법론", "초등도덕과평가연구", "통일과민주주의",
  "창의적인성교육의실제", "수학게임.퍼즐", "미술의이해", "인공지능과SW의미래",
  "아동정서.행동장애의이해와교육", "창작무용", "초등과학교육현장지도", "뇌와교육",
  "AI기반다문화리터러시", "고급음악실기지도", "한자교육론", "가족과주거생활",
  "사회과현장학습",
  // 심화자유선택 목록(PDF 9992~10012행)에 있음. 원본 셀이 "심자"로 표기하던 과목.
  "초등교사를위한한국어학입문"]) MANUAL_TYPE.set(n, "심화");
for (const c of all) if (!c.type && MANUAL_TYPE.has(c.name)) c.type = MANUAL_TYPE.get(c.name);

// 이수영역이 비어 있는 행 → 같은 학기·같은 과목명의 다른 행에서 추론
const typeByName = new Map();
for (const c of all) if (c.type) typeByName.set(`${c.semester}|${c.name}`, c.type);
let inferred = 0, stillEmpty = 0;
for (const c of all) {
  if (c.type) continue;
  const t = typeByName.get(`${c.semester}|${c.name}`) || typeByName.get(`|${c.name}`);
  if (t) { c.type = t; inferred++; } else stillEmpty++;
}
// 교양은 전 학과 공용 풀 — forward-fill 잔재를 공통으로 정규화 (v6.1과 동일 규칙)
for (const c of all) if (c.type === "교양") c.dept = "공통";

const seen = new Set();
const dedup = [];
for (const c of all) {
  const key = [c.semester, c.grade, c.group, c.dept, c.name, c.section, c.day, c.periods.join(""), c.professor].join("|");
  if (seen.has(key)) continue;
  seen.add(key);
  dedup.push(c);
}

console.log(`\n합계 ${all.length} → 중복제거 ${dedup.length}`);
console.log("건너뛴 시트:", [...stats.skippedSheets].join(", ") || "(없음)");
console.log(`이수영역 추론 보완: ${inferred}행 / 여전히 빈칸: ${stillEmpty}행`);
console.log("학기별:", JSON.stringify(dedup.reduce((a, c) => (a[c.semester] = (a[c.semester] || 0) + 1, a), {})));
console.log("유형별:", JSON.stringify(dedup.reduce((a, c) => (a[c.type || "(빈칸)"] = (a[c.type || "(빈칸)"] || 0) + 1, a), {})));

// 품질 점검
const nameWithDigit = [...new Set(dedup.filter((c) => /\d/.test(c.name)).map((c) => c.name))];
const noProf = dedup.filter((c) => !c.professor);
const noRoom = dedup.filter((c) => !c.room);
console.log(`\n과목명에 숫자 포함(정상일 수도 있음): ${nameWithDigit.length} → ${JSON.stringify(nameWithDigit.slice(0, 8))}`);
console.log(`교수 없음: ${noProf.length}, 강의실 없음: ${noRoom.length}`);
noProf.slice(0, 5).forEach((c) => console.log(`   교수없음: ${c.semester} ${c.name} room="${c.room}"`));

fs.writeFileSync(OUT, JSON.stringify(dedup));
console.log("\n저장:", OUT);
