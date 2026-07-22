// ============================================================
// test-lesson-data.mjs — 지도안 데이터 로더 검증기의 검증
// ============================================================
//   node scripts/manual/test-lesson-data.mjs
//
// "거른다고 문서에 적어 뒀다" 와 "실제로 걸러진다" 는 다른 증거다.
// 각 규칙마다 **통과해야 할 것**과 **걸러져야 할 것**을 같이 넣는다.
// 걸러져야 할 게 통과하면 실패다 — 통과 건수만 세면 이걸 못 잡는다.
// ============================================================
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "lessondata-"));
process.env.LESSON_DATA_DIR = dir;
const { loadStandards, loadUnits, loadRubrics, loadModelSteps } =
  await import("../../app/lib/server/ai/lessonData.mjs");

const put = (f, s) => writeFileSync(join(dir, f), s, "utf8");
const clear = () => { for (const f of ["성취기준_국어.csv","단원구성.csv","평가기준.csv","모형전개.csv"])
  { try { rmSync(join(dir, f)); } catch {} } };

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── 성취기준 ────────────────────────────────────────────────
console.log("\n성취기준");
clear();
put("성취기준_국어.csv", [
  "교과,학년군,영역,성취기준코드,성취기준",
  "국어,5-6학년군,읽기,[6국02-03],글을 읽고 글쓴이의 주장을 파악한다.",   // 통과
  "국어,5-6학년군,쓰기,[6국03-01],목적에 맞게 글을 쓴다.",              // 통과
  "국어,3-4학년군,읽기,[6국02-05],학년군과 코드가 어긋난 행이다.",       // 탈락(불일치)
].join("\n"));
let s = loadStandards();
check("올바른 행은 통과", s.byCode.size === 2, `size=${s.byCode.size}`);
check("코드·학년군 불일치는 탈락", !s.byCode.has("[6국02-05]"));

// 파일 폐기는 **비율과 절대건수를 둘 다** 넘을 때만.
// 작은 파일에서 한두 행 틀렸다고 멀쩡한 행까지 날리면 안 된다.
clear();
put("성취기준_국어.csv", [
  "교과,학년군,영역,성취기준코드,성취기준",
  "국어,5-6학년군,읽기,[6국02-03],정상 행입니다 하나.",
  "국어,5-6학년군,읽기,[6국02-04],정상 행입니다 둘.",
  "국어,5-6학년군,읽기,6국02-05,대괄호가 없다.",
  "국어,5-6학년군,읽기,[6국02-06],",
].join("\n"));
s = loadStandards();
check("작은 파일은 탈락률 50%여도 살린다", s.byCode.size === 2, `size=${s.byCode.size}`);
check("탈락 행은 보고한다", s.issues.some((i) => /2행 탈락/.test(i.reason)));

// 큰 파일에서 형식이 통째로 어긋나면 전체를 버린다 (6행 탈락 ≥ 5)
clear();
put("성취기준_국어.csv", [
  "교과,학년군,영역,성취기준코드,성취기준",
  ...Array.from({ length: 20 }, (_, i) =>
    `국어,5-6학년군,읽기,[6국02-${String(i + 10)}],정상 행입니다 ${i}.`),
  ...Array.from({ length: 6 }, (_, i) =>
    `국어,5-6학년군,읽기,6국02-${String(i + 50)},대괄호가 없는 행 ${i}.`),
].join("\n"));
s = loadStandards();
check("큰 파일에서 6행 탈락(23%)이면 전체 폐기", s.byCode.size === 0, `size=${s.byCode.size}`);
check("폐기 사유가 남는다", s.issues.some((i) => /탈락률/.test(i.reason)));

// 큰 파일이라도 탈락률이 낮으면 그 행만 버린다
clear();
put("성취기준_국어.csv", [
  "교과,학년군,영역,성취기준코드,성취기준",
  ...Array.from({ length: 100 }, (_, i) =>
    `국어,5-6학년군,읽기,[6국02-${String(i).padStart(2, "0")}],정상 행 ${i}.`),
  ...Array.from({ length: 6 }, (_, i) =>
    `국어,5-6학년군,읽기,6국99-${i},깨진 행 ${i}.`),
].join("\n"));
s = loadStandards();
check("탈락률 5.7%면 그 행만 버린다", s.byCode.size === 100, `size=${s.byCode.size}`);

// 열 이름이 틀리면 행이 아무리 멀쩡해도 못 쓴다
clear();
put("성취기준_국어.csv", [
  "교과,학년군,영역,코드,성취기준",   // '성취기준코드' 가 '코드'
  "국어,5-6학년군,읽기,[6국02-03],문장.",
].join("\n"));
s = loadStandards();
check("열 이름 불일치는 파일 거부", s.byCode.size === 0);
check("어느 열이 없는지 알려준다", s.issues.some((i) => /열 이름 불일치/.test(i.reason)));

// 중복 코드는 어느 쪽이 맞는지 모르므로 양쪽 다 버린다
clear();
put("성취기준_국어.csv", [
  "교과,학년군,영역,성취기준코드,성취기준",
  "국어,5-6학년군,읽기,[6국02-03],첫 번째 서술입니다.",
  "국어,5-6학년군,읽기,[6국02-03],다른 서술입니다.",
  "국어,5-6학년군,쓰기,[6국03-01],멀쩡한 행입니다.",
].join("\n"));
s = loadStandards();
check("중복 코드는 양쪽 다 제외", !s.byCode.has("[6국02-03]"));
check("무관한 행은 살아남는다", s.byCode.has("[6국03-01]"));

// BOM 이 있어도 첫 열을 인식해야 한다 (흔한 실수)
clear();
put("성취기준_국어.csv", "﻿" + [
  "교과,학년군,영역,성취기준코드,성취기준",
  "국어,5-6학년군,읽기,[6국02-03],문장입니다.",
].join("\n"));
check("BOM 이 있어도 읽는다", loadStandards().byCode.size === 1);

// ── 단원구성 ────────────────────────────────────────────────
console.log("\n단원구성");
clear();
const known = new Set(["[6국02-03]"]);
put("단원구성.csv", [
  "교과,학년,학기,단원번호,단원명,총차시,차시번호,차시명,성취기준코드,출판사",
  "국어,5,1,4,글쓴이의 주장,8,1,주장하는 글 살펴보기,[6국02-03],국정",
  "국어,5,1,4,글쓴이의 주장,8,2,주장과 근거 파악하기,[6국99-99],국정",  // 모르는 코드
  "국어,5,1,4,글쓴이의 주장,8,3,\"쉼표, 들어간 차시명\",,국정",         // 따옴표
].join("\n"));
let u = loadUnits(known);
check("3행 모두 살아남는다", u.rows.length === 3, `rows=${u.rows.length}`);
check("모르는 코드는 코드만 비운다", u.rows[1].codes.length === 0);
check("따옴표 안 쉼표를 살린다", u.rows[2].period === "쉼표, 들어간 차시명",
  `period=${u.rows[2]?.period}`);
check("모르는 코드를 보고한다", u.issues.some((i) => /없는 코드/.test(i.reason)));

clear();
put("단원구성.csv", [
  "교과,학년,학기,단원번호,단원명,총차시,차시번호,차시명,성취기준코드,출판사",
  "국어,5,1,4,4단원 글쓴이의 주장,8,1,차시명입니다,,국정",   // 단원명에 번호
  "국어,5,1,4,글쓴이의 주장,8,99,차시번호가 총차시 초과,,국정",
  "국어,5,1,4,글쓴이의 주장,8,1,정상 차시,,국정",
  "국어,5,1,4,글쓴이의 주장,8,1,중복된 차시,,국정",          // 중복
].join("\n"));
u = loadUnits(null);
check("단원명 번호·차시초과·중복이 걸러진다", u.rows.length === 1,
  `rows=${u.rows.length} (정상 1행만 남아야 한다)`);
check("살아남은 건 정상 행", u.rows[0]?.period === "정상 차시", `period=${u.rows[0]?.period}`);

// v2 교과서ID는 같은 단원·차시라도 서로 다른 책이면 함께 허용한다.
clear();
put("단원구성.csv", [
  "교과,학년,학기,단원번호,단원명,총차시,차시번호,차시명,성취기준코드,출판사,교과서ID",
  "통합,1,1,2,함께 준비해요,12,1,학교 책 차시,,미래엔,mirae-2022-integrated-1-1-1386",
  "통합,1,1,2,함께 준비해요,20,1,봄 책 차시,,미래엔,mirae-2022-integrated-1-1-1380",
].join("\n"));
u = loadUnits(null);
check("서로 다른 교과서ID의 같은 차시는 함께 읽는다", u.rows.length === 2, `rows=${u.rows.length}`);
check("교과서ID가 객체에 보존된다", u.rows[0]?.textbookId === "mirae-2022-integrated-1-1-1386");

// 기존 v1 헤더도 하위 호환으로 읽는다. ID는 빈 문자열이어야 한다.
clear();
put("단원구성.csv", [
  "교과,학년,학기,단원번호,단원명,총차시,차시번호,차시명,성취기준코드,출판사",
  "국어,5,1,4,글쓴이의 주장,8,1,주장하는 글 살펴보기,,국정",
].join("\n"));
u = loadUnits(null);
check("v1 헤더도 계속 읽는다", u.rows.length === 1 && u.rows[0].textbookId === "");

// ── 평가기준 ────────────────────────────────────────────────
console.log("\n평가기준");
clear();
put("평가기준.csv", [
  "교과,학년군,성취기준코드,평가요소,상,중,하",
  "국어,5-6학년군,[6국02-03],주장 파악,주장과 근거를 모두 찾는다,주장을 찾는다,도움받아 찾는다",
].join("\n"));
let rb = loadRubrics(known);
check("정상 루브릭을 읽는다", rb.byCode.get("[6국02-03]")?.[0]?.element === "주장 파악");

// ── 모형전개 ────────────────────────────────────────────────
console.log("\n모형전개");
clear();
put("모형전개.csv", [
  "모형키,모형명,단계번호,단계명,교사발화예시,권장시간비율",
  "direct,직접교수,2,시범보이기,선생님이 먼저 해 볼게요. 잘 보세요.,18",
  "direct,직접교수,1,설명하기,오늘은 이렇게 하는 방법을 배울 거예요.,20",
  "project,프로젝트,1,주제 정하기,무엇을 알아보고 싶은지 이야기해 봅시다.,15",
].join("\n"));
let ms = loadModelSteps();
check("모형별로 묶인다", ms.byModel.size === 2, `size=${ms.byModel.size}`);
check("단계번호 순으로 정렬된다", ms.byModel.get("direct")?.[0]?.name === "설명하기");
check("새로 추가한 project 키를 받는다", ms.byModel.has("project"));

clear();
put("모형전개.csv", [
  "모형키,모형명,단계번호,단계명,교사발화예시,권장시간비율",
  "없는모형,이상함,1,단계,발화 예시입니다 길게,20",
].join("\n"));
check("모르는 모형키는 거부", loadModelSteps().byModel.size === 0);

// ── 없는 파일 ───────────────────────────────────────────────
console.log("\n파일 없음");
clear();
check("파일이 없어도 터지지 않는다", loadUnits(null).rows.length === 0);
check("'없음' 은 오류로 취급하지 않는다",
  loadUnits(null).issues.every((i) => i.reason === "없음"));

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} PASS / ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
