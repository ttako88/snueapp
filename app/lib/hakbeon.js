// ============================================================
// hakbeon.js — 학번 파싱 (클라이언트·서버 공용 순수 함수)
// ============================================================
// 설계 근거: docs/ANALYTICS_DESIGN_DRAFT_2026-07-22.md "데이터 수집",
//            메모리 snue-hakbeon-structure, GPT 검수 P-20260722-PACKET_S1.
//
// 이 파일이 하는 일: 서울교대 8자리 학번을 → { 입학년도, 학과, 군, 예상학년 }
// 으로 푼다. "학번만 넣으면 학년·학과가 나온다" 편의 기능(hakbeonAutofill)과
// 학과·학년 세그먼트(productAnalytics / targetedAds)의 공통 파생 근거다.
//
// 지키는 것 (검수 MUST):
//   1. 비밀이 없다. HMAC·env·crypto 를 쓰지 않는다 → 클라이언트 번들에 실려도
//      안전하다. 학번 원문 HMAC(중복가입 대조)은 서버 전용 hmac.mjs 가 따로
//      한다. 이 파일은 그 파일을 import 하지 않는다(hmac.mjs 는 window 있으면 throw).
//   2. 임의추정 금지. 표에 없는 학과코드, 표의 유효범위 밖 입학년도는
//      학과를 지어내지 않고 null + 사유코드로 돌려준다. "국어과에 영어광고"
//      같은 사고는 잘못된 추정에서 나온다 — 모르면 모른다고 한다.
//   3. 개인 식별 최소화. 개인번호(뒤 2자리)를 추출·사용·반환하지 않는다. 반환값에
//      8자리 전체도 담지 않는다. 파생엔 학과코드(2자리)와 입학년도만 쓴다.
//   4. expected_grade 는 "제안값"이다. 휴학·초과학기 때문에 학번만으론 실제
//      학년을 알 수 없다. 사용자가 확정(current_grade)하기 전엔 기본값일 뿐이다.
//
// ⚠️ 클라이언트 결과를 신뢰하지 않는다 (GPT MUST). 이 파일이 클라에서 낸
//    department·track·entryYear·expectedGrade 를 그대로 저장하거나 권한·광고동의·
//    인증 판정에 쓰면 안 된다. 저장 확정은 서버가 정규화된 학번에서 이 함수로
//    독립 재계산한 값으로 한다. 클라 계산은 자동채움·설명용이다.
//
// 정규화 규약(형식·입학년도 상한)은 서버 hmac.mjs 의 normalizeStudentNo 와
//   **같아야 한다**. 어긋나면 클라에서 통과한 학번이 서버에서 튕긴다.
//   tests/hakbeon.test.mjs 가 두 파일의 수용/거부가 일치하는지 대조한다.
// ============================================================

// 학과코드 표 — 학번 5~6번째 2자리가 심화전공(학과) 코드다. A군/B군은 교양 수강군.
//
// ⚠️ 비어 있는 03·05·08 은 과거 한 과목이 2개 반(예: 국어A/국어B)이던 시절의
//    두 번째 반 번호였다. 현재 13개과 체계엔 없다 → 들어오면 unknown_code.
//
// 유효 입학년도 범위 (GPT MUST: 단일 하한 임의추정 금지 → 버전별 유효범위):
//   - 코드 표기 관찰: 에브리타임 심화전공 안내(2025-02, 25학번 대상).
//   - 소급 유효범위: 소유자 확인 — 현재 13개 코드 체계가 2000년대 초반 입학까지
//     동일하게 적용된다("2000년대 초반까지 싹 다 커버"). 기관 사정을 아는 당사자
//     확인이므로 근거로 채택하되, 문서 인용이 아니라 소유자 증언임을 명시한다.
//   - 범위 밖(2000 미만) 입학년도는 학과를 단정하지 않고 null + 상태를 돌려준다.
//     더 이른 코드표가 확인되면 아래에 버전을 추가해 범위만 넓히면 된다.
export const DEPT_CODE_TABLE_SOURCE =
  "에브리타임 심화전공 안내(2025) + 소급범위 소유자 확인";

// 검증된 유효 입학년도 하한(포함). UI·저장 계층이 "이 학번은 학과 자동판별
// 대상 밖" 을 안내할 때 참조한다.
export const DEPT_TABLE_VERIFIED_FROM = 2000;

// 연도별 표 구조. 각 버전은 유효 입학년도 [from, to] 를 가진다(to=null=현재까지).
// 지금은 확인된 버전이 하나. 더 이른/다른 코드표가 확인되면 항목을 추가한다.
const DEPT_CODE_TABLES = [
  {
    tableVersion: "snue-13dept-current",
    source: DEPT_CODE_TABLE_SOURCE,
    validEntryYearFrom: DEPT_TABLE_VERIFIED_FROM,
    validEntryYearTo: null, // 현재까지 유효
    codes: {
      "01": { department: "윤리교육과", track: "A" },
      "02": { department: "국어교육과", track: "A" },
      "04": { department: "사회과교육과", track: "A" },
      "06": { department: "수학교육과", track: "A" },
      "07": { department: "과학교육과", track: "A" },
      "09": { department: "체육교육과", track: "A" },
      "10": { department: "음악교육과", track: "B" },
      "11": { department: "미술교육과", track: "B" },
      "12": { department: "생활과학교육과", track: "B" },
      "13": { department: "초등교육과", track: "B" },
      "14": { department: "영어교육과", track: "B" },
      "15": { department: "정보교육과", track: "B" },
      "16": { department: "유아·특수교육과", track: "B" },
    },
  },
];

// KST(Asia/Seoul, UTC+9, DST 없음) 기준 civil date 로 환산한다 (GPT SHOULD).
// 기기·서버 로컬 타임존에 학년 경계가 흔들리지 않게, 시각(instant)을 KST 로 옮겨
// 연/월(0-based)만 읽는다.
function kstCivil(now) {
  const k = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return { year: k.getUTCFullYear(), month: k.getUTCMonth() };
}

// 정규 학기(3월) 시작 기준으로 학년을 센다. 겨울방학(1~2월)은 직전 학년도에
// 속한다. month 는 0-based → 2 = 3월.
function academicYearOf(now) {
  const { year, month } = kstCivil(now);
  return month >= 2 ? year : year - 1;
}

/**
 * 학번을 판다. 예외 대신 상태 필드로 결과를 준다(courseKey 파서와 같은 방침 —
 * 실패를 조용히 삼키지 않되, 흐름을 예외로 끊지도 않는다).
 *
 * @param {string} input 사용자가 입력한 학번(공백·하이픈 허용)
 * @param {{ now?: Date }} [opts]
 * @returns {{
 *   ok: boolean,
 *   reason?: "format" | "year_range",         // ok=false 일 때만
 *   entryYear?: number,                        // 입학년도 (앞 4자리)
 *   deptCode?: string,                         // 학과코드 2자리 (예 "14")
 *   department?: string | null,                // 학과명 또는 null(모르면 null)
 *   track?: "A" | "B" | null,                  // 교양 수강군
 *   deptStatus?: "known" | "unknown_code" | "entry_year_outside_table",
 *   expectedGrade?: number | null,             // 1~4 제안값, 아니면 null
 *   expectedGradeStatus?: "normal" | "pre_enrollment" | "beyond_fourth",
 * }}
 *   ⚠️ 반환값에 8자리 전체·개인번호(뒤 2자리)는 담지 않는다.
 */
export function parseHakbeon(input, { now = new Date() } = {}) {
  // 정규화: 공백·하이픈만 제거. 다른 문자를 지우면 잘못된 입력을 "정규화"로
  // 통과시키게 된다 — 지우지 말고 거부한다(hmac.mjs 와 동일 규칙).
  if (typeof input !== "string") return { ok: false, reason: "format" };
  const s = input.trim().replace(/[\s-]/g, "");
  if (!/^\d{8}$/.test(s)) return { ok: false, reason: "format" };

  const entryYear = Number(s.slice(0, 4));
  // 상한을 올해+1 로: 수시 합격자가 입학 전 해에 가입할 수 있다(hmac.mjs 와 동일).
  // 상한 판정은 hmac.mjs 와 같은 로컬 now.getFullYear() 를 쓴다(수용/거부 일치용).
  if (entryYear < 1980 || entryYear > now.getFullYear() + 1) {
    return { ok: false, reason: "year_range" };
  }

  const deptCode = s.slice(4, 6);
  // 개인번호(s.slice(6,8))는 추출하지 않는다 — 어떤 파생에도 안 쓰인다.

  const table = resolveDeptTable(entryYear);
  let department = null;
  let track = null;
  let deptStatus;
  if (!table) {
    // 표 유효범위 밖 입학년도 → 학과를 단정하지 않는다.
    deptStatus = "entry_year_outside_table";
  } else {
    const hit = table.codes[deptCode];
    if (hit) {
      department = hit.department;
      track = hit.track;
      deptStatus = "known";
    } else {
      deptStatus = "unknown_code";
    }
  }

  const { expectedGrade, expectedGradeStatus } = suggestGrade(entryYear, now);

  return { ok: true, entryYear, deptCode, department, track, deptStatus, expectedGrade, expectedGradeStatus };
}

/**
 * 입학년도가 유효범위 [from, to] 안에 드는 코드표를 고른다. to=null 이면 현재까지.
 * 겹치는 버전이 있으면 from 이 가장 큰(가장 최근) 것을 택한다. 없으면 null.
 */
function resolveDeptTable(entryYear) {
  let best = null;
  for (const t of DEPT_CODE_TABLES) {
    const inRange = entryYear >= t.validEntryYearFrom &&
      (t.validEntryYearTo == null || entryYear <= t.validEntryYearTo);
    if (inRange && (!best || t.validEntryYearFrom > best.validEntryYearFrom)) {
      best = t;
    }
  }
  return best;
}

/**
 * 학번만으로 낸 "예상 학년" 제안값. 휴학·초과학기를 모르므로 확정이 아니다.
 * 1~4 이면 그 값, 입학 전이면 pre_enrollment, 4 초과면 beyond_fourth 로 알린다.
 */
function suggestGrade(entryYear, now) {
  const g = academicYearOf(now) - entryYear + 1;
  if (g < 1) return { expectedGrade: null, expectedGradeStatus: "pre_enrollment" };
  if (g > 4) return { expectedGrade: null, expectedGradeStatus: "beyond_fourth" };
  return { expectedGrade: g, expectedGradeStatus: "normal" };
}
