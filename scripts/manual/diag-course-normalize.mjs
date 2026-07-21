// ============================================================
// diag-course-normalize.mjs — 과목 마스터 적재를 위한 데이터 실측 (READ-ONLY)
// ============================================================
// "과목을 어떻게 묶을 것인가" 는 추측으로 정할 문제가 아니다. 실제
// courses.json 4,916행이 어떻게 생겼는지 세어 보고 판단 근거를 만든다.
//
// 답해야 하는 질문
//   · 과목명만으로 유일한가, 아니면 같은 이름의 다른 과목이 있는가
//   · 공동 담당 교수는 얼마나 흔한가
//   · 학기가 바뀌면 같은 과목인가
//   · 분반은 어떻게 표현되는가
//
// 파일만 읽는다. DB 접속 없음.
// ============================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";

const raw = JSON.parse(readFileSync(join(process.cwd(), "app/data/courses.json"), "utf8"));
const rows = Array.isArray(raw) ? raw : raw.courses ?? Object.values(raw)[0];
const line = (k, v) => console.log(`  ${String(k).padEnd(46)} ${v}`);

console.log(`=== 원본 ===`);
line("행 수", rows.length);
line("키", Object.keys(rows[0]).join(", "));

// 학기 분포
const bySem = {};
for (const r of rows) bySem[r.semester] = (bySem[r.semester] || 0) + 1;
console.log(`\n=== 학기별 ===`);
for (const [k, v] of Object.entries(bySem).sort()) line(k, v);

// 과목명 단독 유일성
const byName = new Map();
for (const r of rows) {
  if (!byName.has(r.name)) byName.set(r.name, new Set());
  byName.get(r.name).add(r.dept ?? "");
}
const nameMulti = [...byName].filter(([, d]) => d.size > 1);
console.log(`\n=== 과목명 ===`);
line("고유 과목명", byName.size);
line("여러 학과에 걸친 이름", nameMulti.length);
for (const [n, d] of nameMulti.slice(0, 5)) line(`  ${n}`, [...d].join(", "));

// 교수 표기
let multiProf = 0, emptyProf = 0;
const profSample = new Set();
for (const r of rows) {
  const p = (r.professor ?? "").trim();
  if (!p) { emptyProf++; continue; }
  if (/[,·]/.test(p) || /외 \d+명/.test(p)) { multiProf++; if (profSample.size < 5) profSample.add(p); }
}
console.log(`\n=== 교수 표기 ===`);
line("공동 담당(쉼표·'외 N명')", multiProf);
line("교수 미기재", emptyProf);
for (const p of profSample) line("  예", p);

// (과목명, 교수) 조합 — aliases 가 이 단위다
const pairs = new Map();
for (const r of rows) {
  const key = `${r.name}||${(r.professor ?? "").trim()}`;
  pairs.set(key, (pairs.get(key) || 0) + 1);
}
console.log(`\n=== (과목명, 교수) 조합 ===`);
line("고유 조합", pairs.size);
line("조합당 평균 행", (rows.length / pairs.size).toFixed(1));
const topPairs = [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 5);
for (const [k, v] of topPairs) line(`  ${k.split("||")[0]}`, `${v}행 (분반·학기 중복)`);

// 학기를 무시하면 얼마나 줄어드나 — 같은 과목을 학기 넘어 묶을지 판단용
const acrossSem = new Map();
for (const r of rows) {
  const key = `${r.name}||${(r.professor ?? "").trim()}`;
  if (!acrossSem.has(key)) acrossSem.set(key, new Set());
  acrossSem.get(key).add(r.semester);
}
const spanning = [...acrossSem].filter(([, s]) => s.size > 1);
console.log(`\n=== 학기를 넘나드는 조합 ===`);
line("여러 학기에 등장", spanning.length);
line("전체 조합 대비", `${((spanning.length / pairs.size) * 100).toFixed(1)}%`);

console.log(`\n=== 적재 규모 추정 ===`);
line("과목 단위로 subjects 를 만들면", `${pairs.size}건 내외`);
line("학기까지 나누면", `${new Set(rows.map((r) => `${r.name}||${r.professor}||${r.semester}`)).size}건`);
console.log(`
  판단이 필요한 지점
    · 학기를 넘어 같은 과목으로 볼 것인가. 넘나드는 조합이 위 비율이다.
      묶으면 평가가 쌓이고, 나누면 "그 학기 그 교수" 정확도가 올라간다.
    · 공동 담당 교수 문자열을 그대로 키로 쓸 것인가.
      "진현정, 남영민, 권성옥" 과 "남영민, 진현정" 이 다른 키가 된다.
    · 분반은 subjects 가 아니라 alias 로 흡수하면 된다.`);
