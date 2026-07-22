// ============================================================
// lesson-check.mjs — 지도안 근거 데이터 형식 점검
// ============================================================
//   npm run lesson:check
//
// 로컬 GPT 가 만든 CSV 를 app/data/lessonPrompt/ 에 넣고 이걸 돌린다.
// 몇 행이 통과·탈락했는지, 왜 탈락했는지 줄번호까지 찍는다.
//
// 읽기만 한다. 파일을 고치지 않는다.
// ============================================================
import { existsSync, readdirSync } from "node:fs";
import { loadAll, DATA_DIR } from "../../app/lib/server/ai/lessonData.mjs";

const NEEDED = ["단원구성.csv", "평가기준.csv", "모형전개.csv"];

console.log(`\n지도안 근거 데이터 점검`);
console.log(`규격: docs/LESSON_DATA_CONTRACT.md`);
console.log(`위치: ${DATA_DIR}\n`);

if (!existsSync(DATA_DIR)) {
  console.log("폴더가 아직 없습니다. 만들고 CSV 를 넣으면 여기서 점검합니다.");
  console.log("데이터가 없어도 지도안 생성 자체는 동작합니다.\n");
  process.exit(0);
}

const present = readdirSync(DATA_DIR).filter((f) => f.endsWith(".csv"));
if (!present.length) {
  console.log("CSV 가 아직 없습니다.\n");
  process.exit(0);
}
console.log(`발견한 파일 ${present.length}개: ${present.join(", ")}\n`);

const d = loadAll();

// ── 통과한 것 ────────────────────────────────────────────────
console.log("── 읽어들인 데이터 ──────────────────────────────");
console.log(`  성취기준      ${String(d.standards.size).padStart(5)} 건`);
console.log(`  단원·차시     ${String(d.units.length).padStart(5)} 건`);
console.log(`  평가기준      ${String(d.rubrics.size).padStart(5)} 개 코드`);
console.log(`  모형 전개     ${String(d.modelSteps.size).padStart(5)} 개 모형`);

// 단원 데이터는 교과·학년별 진도가 중요하다 — 어디가 비었는지 보여준다.
if (d.units.length) {
  const grid = new Map();
  for (const u of d.units) {
    const k = `${u.subject} ${u.grade}학년`;
    grid.set(k, (grid.get(k) ?? 0) + 1);
  }
  console.log("\n  단원 데이터가 있는 교과·학년");
  for (const [k, n] of [...grid].sort()) console.log(`    ${k.padEnd(14)} ${n}차시`);
}

// ── 문제 ─────────────────────────────────────────────────────
const missing = NEEDED.filter((f) => !present.includes(f));
const real = d.issues.filter((i) => i.reason !== "없음");

if (real.length) {
  console.log("\n── 고쳐야 할 것 ─────────────────────────────────");
  for (const i of real) {
    console.log(`\n  [${i.file}] ${i.reason}`);
    for (const dr of (i.dropped ?? []).slice(0, 15)) {
      console.log(`      ${String(dr.line).padStart(5)}행: ${dr.why}`);
    }
    const rest = (i.dropped?.length ?? 0) - 15;
    if (rest > 0) console.log(`      … 그 외 ${rest}행`);
  }
}

if (missing.length) {
  console.log(`\n── 아직 없는 파일 ───────────────────────────────`);
  for (const f of missing) console.log(`  ${f}`);
  console.log("  (없어도 동작합니다. 있으면 지도안 품질이 올라갑니다)");
}

console.log("\n─────────────────────────────────────────────────");
if (!real.length) {
  console.log("형식 문제 없음.\n");
} else {
  // 여기서 종료코드를 1 로 주지 않는다 — 데이터 수집은 점진적이라
  // "아직 덜 됐다" 가 정상 상태다. 실패가 아니라 진행 상황이다.
  console.log(`형식 문제 ${real.length}건. 위 줄번호를 고치고 다시 돌려주세요.\n`);
}
