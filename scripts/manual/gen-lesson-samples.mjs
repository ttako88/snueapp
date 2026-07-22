// ============================================================
// gen-lesson-samples.mjs — 지도안 샘플을 뽑아 로컬 폴더에 저장
// ============================================================
// 왜 만들었나
//   소유자가 "결과물을 말로만 듣는 게 답답하다" 고 했다. 맞는 지적이다 —
//   품질 판단은 내가 요약해서 전할 게 아니라 직접 보고 해야 한다.
//   그래서 생성 결과를 바탕화면 폴더에 그대로 떨군다.
//
// 저장 위치
//   C:\Users\조상호\Desktop\클로드\지도안_출력물\YYYY-MM-DD\
//     001_국어_5학년_약안_직접교수.md
//     ...
//     _요약.md          ← 이번 회차 조건·원가·소요시간 표
//
// 사용
//   node scripts/manual/gen-lesson-samples.mjs            기본 세트
//   node scripts/manual/gen-lesson-samples.mjs --full     세안까지 (비쌈·느림)
//   node scripts/manual/gen-lesson-samples.mjs --one 3    3번만
//
// 비용은 매번 찍는다. 소유자 지갑에서 나가는 돈이라 숨기지 않는다.
// ============================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const OUT_ROOT = "C:\\Users\\조상호\\Desktop\\클로드\\지도안_출력물";

function readEnv() {
  const map = {};
  for (const f of [".env.local"]) {
    if (!existsSync(f)) continue;
    for (const l of readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
      if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return map;
}
const env = { ...readEnv(), ...process.env };
if (!env.GEMINI_API_KEY) {
  console.error("[중단] GEMINI_API_KEY 가 없습니다. npm run setup 으로 등록하세요.");
  process.exit(1);
}

const { generate } = await import("../../app/lib/server/ai/provider.mjs");
const { costKrw, DEFAULT_MODEL } = await import("../../app/lib/server/ai/budget.mjs");
const { TEACHING_MODELS, PLAN_TYPES } = await import("../../app/lib/lessonPlan.js");
// 프롬프트는 앱과 **같은 모듈**에서 만든다. 예전엔 여기에 복사본이 있어서
// 샘플로 튜닝해도 앱에 반영되지 않았다.
const { buildLessonPrompt, PROMPT_VERSIONS, DEFAULT_PROMPT_VERSION } = await import("../../app/lib/server/ai/lessonPrompt.mjs");
const { loadAll } = await import("../../app/lib/server/ai/lessonData.mjs");

// 교과·학년·모형을 넓게 퍼뜨린다. 한 조건만 잘 나오는 것으로는
// 품질을 판단할 수 없다.
// ⚠️ 단원명은 **실제 교과서 단원**(app/data/lessonPrompt/단원구성.csv)에서
//    가져왔다. 그래야 근거(성취기준·차시)가 프롬프트에 실제로 주입된다.
//    가짜 단원명을 쓰면 근거 매칭이 안 돼 "데이터가 있어도 안 쓰는" 상태가 된다.
const CASES = [
  { grade: 5, subject: "국어", unit: "추론하며 읽어요", model: "direct", duration: 40 },
  { grade: 3, subject: "수학", unit: "나눗셈", model: "direct", duration: 40 },
  { grade: 6, subject: "과학", unit: "식물의 구조와 기능", model: "inquiry", duration: 40 },
  { grade: 4, subject: "사회", unit: "경제활동과 지역 간 교류", model: "cooperative", duration: 40 },
  { grade: 5, subject: "도덕", unit: "함께 사는 세상, 봉사하는 우리", model: "value", duration: 40 },
  { grade: 6, subject: "영어", unit: "I Have a Headache", model: "direct", duration: 40 },
  { grade: 5, subject: "실과", unit: "자립적인 가정생활", model: "problem", duration: 40 },
  { grade: 3, subject: "과학", unit: "식물의 생활", model: "inquiry", duration: 40 },
  { grade: 6, subject: "국어", unit: "절차를 지키며 토론해요", model: "response", duration: 40 },
  { grade: 5, subject: "음악", unit: "", model: "cooperative", duration: 40 },
];

// ── 실행 ────────────────────────────────────────────────────
const argv = process.argv;
const argOf = (flag, dflt = null) =>
  argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : dflt;

// ── 인자 방어 ───────────────────────────────────────────────
// 이 스크립트는 **실비(유료 API)** 를 쓴다. 그런데 예전엔 알 수 없는 플래그를
// 조용히 무시하고 전량(10~20건) 기본 배치를 그냥 돌렸다. `--help` 를 usage 인 줄
// 알고 넣었다가 실제 유료 배치가 돌 뻔했다(2026-07-22). 오타 한 번이 돈을 쓰면
// 안 된다 — 모르는 플래그는 **실행 전에** 거부한다.
const USAGE = `gen-lesson-samples — 지도안 샘플 생성 (⚠ 유료 API 실비 발생)

  플래그:
    --prompt v1|v2|v3   프롬프트 판 (기본 ${DEFAULT_PROMPT_VERSION}; v3=v2+오답/되돌리기 표기)
    --think <n>         생각 토큰 상한 (양수). 원가의 절반이 여기서 난다
    --full              약안+세안 둘 다 (기본은 약안만)
    --one <n>           CASES 중 n번째 1건만
    --help              이 도움말 (아무것도 생성하지 않음)

  예: node scripts/manual/gen-lesson-samples.mjs --prompt v3 --one 1`;

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const KNOWN = new Set(["--full", "--one", "--prompt", "--think"]);
const VALUED = new Set(["--one", "--prompt", "--think"]); // 뒤 토큰이 값
for (let i = 2; i < argv.length; i++) {
  const a = argv[i];
  if (KNOWN.has(a)) { if (VALUED.has(a)) i++; continue; } // 값 토큰 건너뜀
  console.error(`[중단] 알 수 없는 인자: ${a}\n        오타로 유료 배치가 도는 것을 막습니다.\n\n${USAGE}`);
  process.exit(2);
}

const wantFull = argv.includes("--full");
const oneIdx = argv.includes("--one") ? Number(argOf("--one")) : null;

// A/B 축 두 개. 어느 쪽이 나은지는 **돌려 봐야** 안다.
//   --prompt v1|v2|v3   프롬프트 판 (v3=v2 + 오답/되돌리기 표기 규약)
//   --think <n>      생각 토큰 상한 (약안 1건 원가의 절반이 여기서 나온다)
// 기본값은 앱과 같아야 한다. 여기만 v1 로 박아 두면 샘플과 실제 앱이
// 다른 프롬프트를 쓰게 되고, 그게 바로 이번에 없앤 문제다.
const promptVer = argOf("--prompt", DEFAULT_PROMPT_VERSION);
if (!PROMPT_VERSIONS.includes(promptVer)) {
  console.error(`[중단] --prompt 는 ${PROMPT_VERSIONS.join(" | ")} 중 하나여야 합니다.`);
  process.exit(1);
}
const thinkBudget = argv.includes("--think") ? Number(argOf("--think")) : null;
if (thinkBudget !== null && !(thinkBudget > 0)) {
  // 0 은 이 모델이 400 으로 거부한다(실측). 조용히 넘기면 전량 실패한다.
  console.error("[중단] --think 는 양수여야 합니다. 이 모델은 0(생각 끄기)을 거부합니다.");
  process.exit(1);
}

// 근거 CSV 가 있으면 프롬프트에 끼운다. 없으면 없는 대로 동작한다.
let evidence = null;
try {
  evidence = loadAll();
  if (evidence.empty) evidence = null;
} catch (e) {
  // 조용히 null 로 만들지 않는다 — "데이터 없음" 과 "읽기 실패" 는 다르다.
  console.log(`  근거 데이터 읽기 실패: ${e.message} (근거 없이 진행)`);
  evidence = null;
}

const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
// A/B 결과가 한 폴더에 섞이면 비교가 안 된다. 조건을 폴더 이름에 박는다.
// **기본 설정과 같으면** 접미사 없이 날짜 폴더에 바로 넣는다 — 평소 쓸 때
// 폴더가 깊어지지 않게. (기준을 "v1" 이 아니라 현재 기본값으로 잡는다.
//  기본판이 바뀌면 기준선도 따라 움직여야 하기 때문이다.)
const variant = [
  promptVer !== DEFAULT_PROMPT_VERSION ? `프롬프트${promptVer}` : null,
  thinkBudget ? `생각${thinkBudget}` : null,
].filter(Boolean).join("_");
const dir = join(OUT_ROOT, day, ...(variant ? [variant] : []));
mkdirSync(dir, { recursive: true });

const cases = oneIdx ? [CASES[oneIdx - 1]] : CASES;
const types = wantFull ? ["brief", "full"] : ["brief"];
const rows = [];
let totalKrw = 0;

console.log(`모델: ${DEFAULT_MODEL}`);
console.log(`프롬프트: ${promptVer}${thinkBudget ? ` · 생각토큰 상한 ${thinkBudget}` : ""}`);
console.log(`근거 데이터: ${evidence ? "있음" : "없음"}`);
console.log(`저장 위치: ${dir}\n`);

let n = 0;
for (const c of cases) {
  for (const pt of types) {
    n++;
    const type = PLAN_TYPES.find((t) => t.key === pt);
    const label = `${c.subject}_${c.grade}학년_${type.label}_${TEACHING_MODELS.find(m=>m.key===c.model).label}`;
    process.stdout.write(`  [${String(n).padStart(2)}] ${label} … `);

    const t0 = Date.now();
    let out;
    try {
      const built = buildLessonPrompt({ ...c, planType: pt },
        { version: promptVer, data: evidence });
      out = await generate({
        model: DEFAULT_MODEL, system: built.system, prompt: built.prompt,
        maxOutTokens: type.maxOutTokens, thinkBudget,
      }, env);
    } catch (e) {
      console.log(`실패 — ${e.message}`);
      rows.push({ label, ok: false, err: e.message });
      continue;
    }
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    const krw = costKrw(DEFAULT_MODEL, out.inTokens, out.outTokens);
    totalKrw += krw;
    // 잘림은 조용히 넘기지 않는다. 처음 10건이 전부 잘렸는데 글자 수만 보고
    // 정상인 줄 알았다 — 판정 근거는 finishReason 이지 길이가 아니다.
    console.log(`${sec}초 ₩${krw} (${out.text.length}자, 생각 ${out.thinkTokens}/본문 ${out.bodyTokens})${
      out.truncated ? "  ⚠ 잘림" : ""}`);

    const file = join(dir, `${String(n).padStart(3, "0")}_${label}.md`);
    writeFileSync(file, [
      `# ${label}`,
      "",
      "> ⚠️ AI 가 만든 **초안**입니다. 성취기준 코드와 차시 배당은 교과서·교육과정을",
      "> 직접 확인해 주세요. 그대로 제출하면 실습 평가에 불리할 수 있습니다.",
      "",
      "| 항목 | 값 |",
      "|---|---|",
      `| 학년·교과 | ${c.grade}학년 ${c.subject} |`,
      `| 단원·주제 | ${c.unit} |`,
      `| 수업모형 | ${TEACHING_MODELS.find(m=>m.key===c.model).label} |`,
      `| 수업 시간 | ${c.duration}분 |`,
      `| 종류 | ${type.label} |`,
      `| 모델 | ${out.resolvedModel ?? DEFAULT_MODEL} |`,
      `| 조건 | 프롬프트 ${promptVer}${thinkBudget ? ` · 생각상한 ${thinkBudget}` : ""}${evidence ? " · 근거데이터 사용" : ""} |`,
      `| 토큰 | 입력 ${out.inTokens} / 생각 ${out.thinkTokens} / 본문 ${out.bodyTokens} |`,
      `| 잘림 | ${out.truncated ? "⚠ 예 — 문장 중간에서 끊겼습니다" : "아니오"} |`,
      `| 원가 | ₩${krw} |`,
      `| 소요 | ${sec}초 |`,
      "",
      "---",
      "",
      out.text,
    ].join("\n"), "utf8");

    rows.push({ label, ok: true, sec, krw, chars: out.text.length,
                truncated: out.truncated, model: out.resolvedModel,
                file: `${String(n).padStart(3,"0")}_${label}.md` });
  }
}

// ── 요약 ────────────────────────────────────────────────────
writeFileSync(join(dir, "_요약.md"), [
  `# 지도안 생성 결과 — ${day}`,
  "",
  `모델: ${DEFAULT_MODEL}`,
  `총 ${rows.filter(r=>r.ok).length}건 생성 · **총 원가 ₩${totalKrw}**`,
  "",
  "| # | 조건 | 소요 | 원가 | 길이 | 파일 |",
  "|---|---|---|---|---|---|",
  ...rows.map((r, i) => r.ok
    ? `| ${i+1} | ${r.label}${r.truncated ? " ⚠잘림" : ""} | ${r.sec}초 | ₩${r.krw} | ${r.chars}자 | [${r.file}](${encodeURI(r.file)}) |`
    : `| ${i+1} | ${r.label} | — | — | — | ❌ ${r.err} |`),
  "",
  ...(rows.some((r) => r.truncated)
    ? [`> ⚠ **${rows.filter((r) => r.truncated).length}건이 문장 중간에서 잘렸습니다.**`,
       "> 출력 토큰 한도가 모자란 것이므로 품질 문제가 아닙니다. 한도를 올려 다시 뽑아야 합니다.", ""]
    : []),
  "## 보실 때",
  "",
  "- 발문이 **실제 교실에서 할 법한 말**인가",
  "- 활동이 주어진 시간 안에 **끝날 분량**인가",
  "- 없는 성취기준 코드를 **지어내지 않았는가**",
  "- 수업모형 단계를 **실제로 따라갔는가**",
  "- 교과별로 품질 차이가 큰가 (어떤 교과가 약한가)",
  "",
  "이 중 걸리는 게 있으면 알려주세요. 프롬프트를 고치면 됩니다.",
].join("\n"), "utf8");

console.log(`\n총 ${rows.filter(r=>r.ok).length}건 · 총 원가 ₩${totalKrw}`);
console.log(`요약: ${join(dir, "_요약.md")}`);
