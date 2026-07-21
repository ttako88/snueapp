// 강의평가 대상(subject) 키 생성기.
//
// 이 파일이 유일한 규칙 출처다. 적재 스크립트와 앱이 같은 함수를 쓴다.
// 011_course_review.sql 주석이 요구하는 바 그대로 — "key는 검증된 파서가
// 생성하고 DB는 그대로 저장한다. DB 함수가 dirty 원문을 임의로 정규화하면
// 규칙이 두 곳에 생겨 어긋난다."
//
// DB CHECK 제약 (011)
//   course_key    ~ '^[0-9a-z가-힣]{1,80}$'
//   professor_key ~ '^[0-9a-z가-힣]{1,40}$'
// 즉 키에는 공백·괄호·로마숫자 구분자·문장부호가 들어갈 수 없다.
//
// 학기는 키에 넣지 않는다 (011 설계 확정). 넣으면 표본이 학기별로 쪼개져
// 공개 임계값 k=10 에 영원히 못 미친다. "한 사람이 같은 과목을 학기마다
// 한 번씩" 은 course_reviews 의 (subject_id, actor_alias_id, semester)
// 유니크가 따로 보장한다.

const KEEP = /[^0-9a-z가-힣]/g;

/** 표시용 문자열 → 키. 규칙에 못 맞추면 null (호출부가 거른다). */
function toKey(text, maxLen) {
  if (typeof text !== "string") return null;
  // 전각 영숫자를 반각으로. 원본에 섞여 있으면 같은 과목이 두 키로 갈린다.
  const half = text.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const key = half.toLowerCase().replace(KEEP, "");
  if (!key || key.length > maxLen) return null;
  return key;
}

export function courseKeyOf(courseName) {
  return toKey(courseName, 80);
}

// 교수 필드는 지저분하다. 실측(4,916행)으로 확인한 오염 유형:
//   · 강의실이 이름 뒤에 붙는다 — "진현정 연강403", "김갑수 인공지능정보교육실"
//   · 주차 구간이 괄호로 붙는다 — "신주희(8-15)", "김주한(1~7)"
//   · 공동 담당 순서가 뒤바뀐다 — "신주영, 심재표" ↔ "심재표, 신주영"
//   · 미배정 자리표시자 — "신규강사A", "강사B", "미정"
//   · 영문 이름은 공백을 포함한다 — "Catherine Guilfoyle" (정상 값)
//
// 이걸 그대로 키에 넣으면 같은 교수가 강의실·주차별로 여러 과목이 된다.
const PROF_SPLIT = /[,·、/]|\s+및\s+|\s+and\s+/i;
// ⚠ 부분 문자열로 지우면 안 되는 것들이 있다. "미정" 을 통째로 치환했더니
//   실존 교수 "강미정" 이 "강" 으로 잘려 사라졌다. 사람 이름과 겹칠 수 있는
//   말은 여기 넣지 말고 아래 PLACEHOLDER 에서 토큰 단위로 거른다.
const PROF_NOISE = /외\s*\d+\s*명|담당\s*교수/gi;
// 자리표시자는 사람이 아니다. 여기에 강의평이 쌓이면 실제 담당자가 정해졌을 때
// 엉뚱한 사람의 평판이 된다. 토큰 전체가 일치할 때만 거른다.
const PLACEHOLDER = /^((신규|신임)?(강사|교수)[a-z가-힣]?|미정|미배정|폐강)$/i;

/** 한 사람분 표기에서 이름만 남긴다. 실패하면 null. */
function nameOnly(part) {
  // 괄호 안(주차 구간·비고)은 통째로 버린다.
  const s = part.replace(/[([{（][^)\]}）]*[)\]}）]?/g, " ").trim();
  if (!s) return null;
  if (PLACEHOLDER.test(s.replace(/\s+/g, ""))) return null;

  // 영문 이름은 공백이 정상이므로 통째로 둔다 ("Catherine Guilfoyle").
  // 단 "한글이 아니면 영문 이름" 으로 보면 안 된다 — "연강403, 406" 처럼
  // 강의실 번호만 남은 조각이 이름으로 둔갑한다. 로마자가 있고 숫자가
  // 없어야 사람 이름이다 ("E-311" 같은 강의실 코드는 여기서 걸린다).
  if (!/[가-힣]/.test(s)) {
    return /[a-zA-Z]/.test(s) && !/[0-9]/.test(s) ? s : null;
  }

  // 한글 쪽은 이름 앞뒤에 강의실·트랙명이 붙는다. 어느 쪽에 붙는지 일정하지
  // 않아서("융합204(체) 장보원" vs "진현정 연강403") 위치로는 못 고른다.
  // 대신 "사람 이름처럼 생긴" 토큰만 남긴다 — 2~4자 한글, 숫자·기호 없음.
  const nameish = s.split(/\s+/)
    .filter((t) => /^[가-힣]{2,4}$/.test(t) && !PLACEHOLDER.test(t));
  if (!nameish.length) return null;
  // 둘 이상 남으면 마지막을 고른다. 남는 경우는 강의실이 숫자 없이 앞에 붙은
  // 형태뿐이고("입체조형 이대철", "기초조형 고홍규") 한국어 표기 관행상
  // 수식어가 앞, 이름이 뒤다. 앞을 고르면 서로 다른 교수가 트랙명 하나로
  // 뭉뚱그려진다 — 실제로 그렇게 4명이 한 키로 합쳐졌었다.
  return nameish[nameish.length - 1];
}

/**
 * 교수 표기 → 키. 여러 명이면 각자 정규화한 뒤 **정렬해서** 잇는다.
 * 정렬하지 않으면 "진현정,남영민" 과 "남영민,진현정" 이 다른 과목이 된다
 * — 실제 데이터에 순서가 뒤바뀐 행이 있다.
 */
export function professorKeyOf(professor) {
  if (typeof professor !== "string") return null;
  const cleaned = professor.replace(PROF_NOISE, " ");
  const parts = cleaned
    .split(PROF_SPLIT)
    .map(nameOnly)
    .filter(Boolean)
    .map((p) => toKey(p, 40))
    .filter(Boolean);
  if (!parts.length) return null;
  // 중복 제거 후 정렬 — 같은 이름이 두 번 적힌 행도 있다.
  const key = [...new Set(parts)].sort().join("");
  return key.length <= 40 ? key : null;
}

/**
 * courses.json 한 행 → subject 후보. 키를 못 만들면 null.
 * 표시용은 원본을 그대로 쓴다 — 사용자에게는 원문이 보여야 한다.
 */
export function subjectOf(row) {
  const courseKey = courseKeyOf(row?.name);
  const professorKey = professorKeyOf(row?.professor);
  if (!courseKey || !professorKey) return null;
  return {
    courseKey,
    professorKey,
    courseNameDisplay: String(row.name).trim().slice(0, 100),
    professorDisplay: String(row.professor).trim().slice(0, 50),
  };
}
