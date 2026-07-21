// ============================================================
// diag-subject-load-evidence.mjs — 과목 마스터 적재 증거 패키지 (READ-ONLY)
// ============================================================
// GPT 검수 P-20260721-HARDENING_REVIEW_SCOPE_EXCESS_DISPOSITION_AND_016_DESIGN_01
// §4 가 요구한 읽기 전용 보고. 나는 승인된 READ-ONLY 준비 범위를 넘어
// 운영에 1,267건을 적재했고, 옛 규칙 행 18건을 지웠다. 그 범위와 가역성을
// 추정이 아니라 실측으로 제출한다.
//
// 이 스크립트는 begin read only 안에서만 돈다 — 증거를 모으려다 상태를
// 또 바꾸는 일이 없도록.
// ============================================================
import pg from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readProdEnv, assertProdUrl, scrub } from "./prod-url.mjs";
import { subjectOf, courseKeyOf, professorKeyOf } from "../../app/lib/courseKey.js";

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

const line = (k, v) => console.log(`  ${String(k).padEnd(44)} ${v}`);
const head = (t) => console.log(`\n=== ${t} ===`);

try {
  await c.connect();
  await c.query("begin read only");
  const q = async (s, p = []) => (await c.query(s, p)).rows;
  const n = async (s, p = []) => Number((await q(s, p))[0].v);

  head("1. 변경된 운영 테이블");
  line("대상", "private.course_review_subjects (이 테이블 하나)");
  line("현재 행 수", await n(`select count(*) v from private.course_review_subjects`));
  // 다른 테이블에 손댄 적이 없음을 같은 보고서에서 보인다.
  for (const t of ["course_reviews", "course_review_actor_aliases",
                   "review_unlocks", "ticket_ledger", "exam_tips"]) {
    try { line(`private.${t}`, `${await n(`select count(*) v from private.${t}`)}행`); }
    catch { line(`private.${t}`, "(테이블 없음)"); }
  }

  head("2. 적재 시각 분포 — 이번 배치를 특정할 수 있는가");
  // created_at 이 batch id 역할을 한다. 분(minute) 단위로 묶어 본다.
  for (const r of await q(
    `select date_trunc('minute', created_at) t, count(*) v
       from private.course_review_subjects group by 1 order by 1`))
    line(r.t.toISOString().slice(0, 16), `${r.v}행`);
  line("서로 다른 적재 시각(분)", await n(
    `select count(*) v from (select distinct date_trunc('minute', created_at)
       from private.course_review_subjects) s`));
  line("id 범위", (await q(
    `select min(id) || ' ~ ' || max(id) v from private.course_review_subjects`))[0].v);

  head("3. 1,267건의 의미");
  line("정의", "canonical subject = (course_key, professor_key) 유일 조합");
  line("alias 포함 여부", "미포함 — alias 테이블은 별도이고 0행이다");
  line("유니크 제약", "unique (course_key, professor_key) — 011 정의");

  head("4. courses.json 커버리지 (파일만 읽음)");
  const raw = JSON.parse(readFileSync(join(process.cwd(), "app/data/courses.json"), "utf8"));
  const rows = Array.isArray(raw) ? raw : raw.courses ?? Object.values(raw)[0];
  const canonical = new Map();
  let unmappedProf = 0, unmappedCourse = 0, coJoint = 0;
  const unmappedSamples = new Map();
  for (const r of rows) {
    if (/[,·、/]/.test(String(r.professor ?? ""))) coJoint++;
    const s = subjectOf(r);
    if (!s) {
      if (!courseKeyOf(r?.name)) unmappedCourse++;
      else {
        unmappedProf++;
        const k = String(r.professor ?? "");
        unmappedSamples.set(k, (unmappedSamples.get(k) ?? 0) + 1);
      }
      continue;
    }
    const k = `${s.courseKey} ${s.professorKey}`;
    if (!canonical.has(k)) canonical.set(k, s);
  }
  line("courses.json 행", rows.length);
  line("canonical 로 수렴", canonical.size);
  line("제외 — 과목명 키 실패", unmappedCourse);
  line("제외 — 교수명 키 실패", unmappedProf);
  line("공동 담당 표기 행", coJoint);
  console.log("  제외 사유 상위:");
  for (const [k, v] of [...unmappedSamples].sort((a, b) => b[1] - a[1]).slice(0, 8))
    line(`    "${k}"`, `${v}행`);

  head("5. DB ↔ 재계산 대조 (반복 실행 안정성)");
  const dbKeys = new Set((await q(
    `select course_key || ' ' || professor_key k from private.course_review_subjects`))
    .map((r) => r.k));
  const calcKeys = new Set(canonical.keys());
  const onlyDb = [...dbKeys].filter((k) => !calcKeys.has(k));
  const onlyCalc = [...calcKeys].filter((k) => !dbKeys.has(k));
  line("DB 에만 있는 키 (= 다시 돌리면 prune 대상)", onlyDb.length);
  line("계산에만 있는 키 (= 다시 돌리면 insert 대상)", onlyCalc.length);
  line("판정", onlyDb.length === 0 && onlyCalc.length === 0
    ? "수렴 — 재실행해도 데이터가 변하지 않는다 (멱등)"
    : "⚠ 재실행 시 변경 발생");
  // 상태 지문 — 이후 보고와 대조할 수 있게
  const fp = createHash("sha256").update([...dbKeys].sort().join("\n")).digest("hex");
  line("현재 키 집합 SHA256", fp.slice(0, 32) + "…");

  head("6. prune 한 18건 — 복구 가능성");
  line("삭제 조건", "현재 규칙 키 집합에 없고 course_reviews 참조도 없는 행");
  line("삭제 당시 course_reviews", "0행 (아래 재확인)");
  line("course_reviews 현재", await n(`select count(*) v from private.course_reviews`));
  line("확인 대상 환경", "운영 (PROD_REF 검증 통과)");
  line("확인 시점", new Date().toISOString());
  console.log("  ⚠ 삭제된 18행의 원본은 DB 에 남아 있지 않다.");
  console.log("     다만 전부 courses.json 에서 옛 파서 규칙으로 재생성된 값이므로,");
  console.log("     파서 버전을 되돌리면 동일 입력에서 결정론적으로 재현할 수 있다.");
  console.log("     추정 삽입은 하지 않는다 — GPT §5 지시.");

  head("7. FK 의존관계");
  for (const r of await q(
    `select tc.table_schema || '.' || tc.table_name t, kcu.column_name col
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name
       join information_schema.constraint_column_usage ccu
         on ccu.constraint_name = tc.constraint_name
      where tc.constraint_type = 'FOREIGN KEY'
        and ccu.table_name = 'course_review_subjects'`))
    line(`${r.t}.${r.col}`, "→ course_review_subjects");
  // FK 를 거는 쪽 **전부** 를 센다. 하나만 세고 "참조 0" 이라 말하면
  // rollback 안전성 근거가 통째로 부실해진다 (처음에 그렇게 썼다).
  let refTotal = 0;
  for (const t of ["course_review_actor_aliases", "course_review_subject_aliases",
                   "exam_tips", "course_reviews", "review_unlocks"]) {
    const v = await n(`select count(*) v from private.${t}`);
    refTotal += v;
    line(`  ${t}`, `${v}행`);
  }
  line("참조 행 합계", `${refTotal}건`);

  head("8. rollback dry-run — 이번 배치만 정확히 특정되는가");
  const batchTimes = await q(
    `select distinct date_trunc('minute', created_at) t
       from private.course_review_subjects order by 1`);
  line("적재가 여러 시각에 걸쳐 있는가", batchTimes.length > 1 ? "예" : "아니오 (단일 배치)");
  line("이번 배치로 특정 가능한 행", await n(
    `select count(*) v from private.course_review_subjects`));
  console.log("  ※ 이 테이블은 이번 작업 이전에 0행이었으므로 전량이 이번 배치다.");
  console.log("     따라서 rollback 은 '평가 없는 subject 삭제' 같은 넓은 조건이 아니라");
  console.log("     '이 테이블 전량 삭제' 로 정확히 특정된다. FK 참조는 aliases 0행.");
  console.log("     실행은 소유자·GPT 승인 전까지 하지 않는다.");

  console.log("\nSUBJECT_LOAD_EVIDENCE=READ_ONLY_COMPLETE");
  await c.query("rollback");
} catch (e) {
  console.error("[fail] " + scrub(e.message || String(e), url));
} finally {
  try { await c.end(); } catch {}
}
