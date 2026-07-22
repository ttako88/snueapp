// 학번 파서 회귀 테스트.
//
// 이 파서는 학과·학년 세그먼트(통계·맞춤광고)와 자동채움의 근거다. 규칙이 틀리면
// "국어과에 영어광고" 같은 사고가 난다. 그래서 (1) 13개 학과코드 매핑, (2) 학년
// 계산의 3월 경계(KST 기준), (3) 모르는 것을 지어내지 않음, (4) 개인번호를 밖으로
// 흘리지 않음 — 이 네 가지를 고정한다. 학번 예시는 전부 지어낸 값이다(실인물 아님).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHakbeon, DEPT_TABLE_VERIFIED_FROM } from "../app/lib/hakbeon.js";
import { normalizeStudentNo, VerifyInputError } from "../app/lib/server/verification/hmac.mjs";

// 기준 시각은 타임존에 흔들리지 않게 KST 오프셋(+09:00)을 박은 instant 로 준다.
// 파서는 이를 Asia/Seoul civil date 로 환산해 학년 경계를 판정한다.
const MAY_2026 = new Date("2026-05-01T12:00:00+09:00"); // 학기 중(학년도 2026)
const JAN_2026 = new Date("2026-01-15T12:00:00+09:00"); // 겨울방학(학년도 2025)
const MAR_1_2026 = new Date("2026-03-01T00:00:00+09:00"); // 3/1 00:00 KST — 학년도 2026 시작
const FEB_28_2026 = new Date("2026-02-28T23:00:00+09:00"); // 아직 직전 학년도

test("학과코드 13개가 모두 맞는 학과·군으로 매핑된다", () => {
  const expect = {
    "01": ["윤리교육과", "A"], "02": ["국어교육과", "A"], "04": ["사회과교육과", "A"],
    "06": ["수학교육과", "A"], "07": ["과학교육과", "A"], "09": ["체육교육과", "A"],
    "10": ["음악교육과", "B"], "11": ["미술교육과", "B"], "12": ["생활과학교육과", "B"],
    "13": ["초등교육과", "B"], "14": ["영어교육과", "B"], "15": ["정보교육과", "B"],
    "16": ["유아·특수교육과", "B"],
  };
  for (const [code, [dept, track]] of Object.entries(expect)) {
    const r = parseHakbeon(`2023${code}07`, { now: MAY_2026 });
    assert.equal(r.ok, true, code);
    assert.equal(r.department, dept, code);
    assert.equal(r.track, track, code);
    assert.equal(r.deptStatus, "known", code);
    assert.equal(r.deptCode, code, code);
  }
});

test("정상 파싱: 입학년도·학과·학년이 함께 나온다", () => {
  const r = parseHakbeon("20230201", { now: MAY_2026 });
  assert.deepEqual(r, {
    ok: true, entryYear: 2023, deptCode: "02", department: "국어교육과",
    track: "A", deptStatus: "known", expectedGrade: 4, expectedGradeStatus: "normal",
  });
});

test("학년 계산: 3월에 학년이 오른다(겨울방학은 직전 학년도, KST 기준)", () => {
  // 2023학번:
  assert.equal(parseHakbeon("20231407", { now: JAN_2026 }).expectedGrade, 3); // 학년도 2025 → 3학년
  assert.equal(parseHakbeon("20231407", { now: MAY_2026 }).expectedGrade, 4); // 학년도 2026 → 4학년
  assert.equal(parseHakbeon("20231407", { now: MAR_1_2026 }).expectedGrade, 4); // 3/1 경계
  assert.equal(parseHakbeon("20231407", { now: FEB_28_2026 }).expectedGrade, 3); // 2/28 은 직전
});

test("3월 경계는 UTC 가 아니라 KST civil date 로 판정한다", () => {
  // KST 3/1 00:30 = UTC 2/28 15:30. UTC 로 잘못 계산하면 2월(직전 학년도)로 새어
  // 2023학번이 3학년으로 나온다. KST 기준이면 4학년이어야 한다.
  const kstMar1_early = new Date("2026-03-01T00:30:00+09:00");
  assert.equal(parseHakbeon("20231407", { now: kstMar1_early }).expectedGrade, 4);
});

test("입학 전(수시 합격)·초과학기는 학년을 단정하지 않는다", () => {
  const pre = parseHakbeon("20271407", { now: MAY_2026 }); // 올해+1 입학 → 아직 입학 전
  assert.equal(pre.ok, true);
  assert.equal(pre.expectedGrade, null);
  assert.equal(pre.expectedGradeStatus, "pre_enrollment");

  const over = parseHakbeon("20201407", { now: MAY_2026 }); // 7년차 → 4학년 초과
  assert.equal(over.expectedGrade, null);
  assert.equal(over.expectedGradeStatus, "beyond_fourth");
});

test("모르는 학과코드(03·05·08 등)는 지어내지 않고 null + 사유", () => {
  for (const code of ["03", "05", "08", "00", "17", "99"]) {
    const r = parseHakbeon(`2023${code}07`, { now: MAY_2026 });
    assert.equal(r.ok, true, code);
    assert.equal(r.department, null, code);
    assert.equal(r.track, null, code);
    assert.equal(r.deptStatus, "unknown_code", code);
  }
});

test("유효범위 밖 입학년도는 학과를 단정하지 않는다", () => {
  const r = parseHakbeon(`${DEPT_TABLE_VERIFIED_FROM - 1}1407`, { now: MAY_2026 });
  assert.equal(r.ok, true);
  assert.equal(r.department, null); // 14 코드라도 범위 밖엔 단정 금지
  assert.equal(r.deptStatus, "entry_year_outside_table");
  // 유효범위 하한(2000)은 매핑된다
  const inRange = parseHakbeon(`${DEPT_TABLE_VERIFIED_FROM}1407`, { now: MAY_2026 });
  assert.equal(inRange.department, "영어교육과");
  assert.equal(inRange.deptStatus, "known");
});

test("형식 오류는 reason=format 으로 거부", () => {
  for (const bad of ["2025142", "202514230", "abcd1234", "2025-14-2", "", "1234abcd"]) {
    const r = parseHakbeon(bad, { now: MAY_2026 });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.reason, "format", JSON.stringify(bad));
  }
  assert.equal(parseHakbeon(null).ok, false);
  assert.equal(parseHakbeon(20230201).ok, false); // 숫자는 문자열 아님 → 거부
});

test("입학년도 범위 밖은 reason=year_range", () => {
  assert.equal(parseHakbeon("17001401", { now: MAY_2026 }).reason, "year_range"); // 1980 미만
  assert.equal(parseHakbeon("99991401", { now: MAY_2026 }).reason, "year_range"); // 올해+1 초과
});

test("공백·하이픈은 정규화하되 다른 문자는 거부", () => {
  const r = parseHakbeon(" 2023-02-01 ", { now: MAY_2026 });
  assert.equal(r.ok, true);
  assert.equal(r.entryYear, 2023);
  assert.equal(r.department, "국어교육과");
});

test("반환값에 8자리 전체·개인번호(뒤 2자리)를 담지 않는다", () => {
  // 개인번호 42 가 결과 어디에도 새지 않아야 한다.
  const r = parseHakbeon("20231442", { now: MAY_2026 });
  const dumped = JSON.stringify(r);
  assert.equal(r.deptCode, "14");
  assert.ok(!("seq" in r), "seq 필드가 없어야 한다");
  assert.ok(!dumped.includes("20231442"), "전체 학번이 없어야 한다");
  assert.ok(!dumped.includes("42"), "개인번호가 없어야 한다");
});

test("정규화 규약이 서버 hmac.mjs 와 일치한다(형식·연도 수용/거부)", () => {
  // 두 파일이 학번 형식·연도 규칙에서 어긋나면 클라 통과분이 서버에서 튕긴다.
  const cases = ["20230201", " 2023-02-01 ", "2025142", "abcd1234", "17001401", "99991401", "20271407"];
  for (const c of cases) {
    const parsed = parseHakbeon(c, { now: MAY_2026 });
    let serverAccepts = true;
    try {
      normalizeStudentNo(c, MAY_2026);
    } catch (e) {
      assert.ok(e instanceof VerifyInputError, `예상된 입력오류여야: ${c}`);
      serverAccepts = false;
    }
    assert.equal(parsed.ok, serverAccepts, `수용/거부 불일치: ${JSON.stringify(c)}`);
  }
});
