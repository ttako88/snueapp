// 강의 관련 순수 상수·분류 로직 (데이터 파일에 의존하지 않음).
//
// timetable.js에서 분리한 이유: timetable.js는 courses.json을 import하는데,
// raw Node ESM(node --test)에서는 JSON import에 import attribute가 필요해
// 테스트에서 불러올 수 없다. 여기 있는 것들은 JSON과 무관한 순수 로직이라
// 분리해 두면 화면·테스트 양쪽에서 자유롭게 쓸 수 있다.
// timetable.js는 이 파일을 re-export하므로 기존 import 경로는 그대로 동작한다.

// 교시별 시각 (서울교대: 50분 수업+10분 쉬는시간, 4교시 후 점심 40분)
export const PERIOD_TIMES = [
  { p: 1, start: "09:00", end: "09:50" },
  { p: 2, start: "10:00", end: "10:50" },
  { p: 3, start: "11:00", end: "11:50" },
  { p: 4, start: "12:00", end: "12:50" },
  { p: 5, start: "13:30", end: "14:20" },
  { p: 6, start: "14:30", end: "15:20" },
  { p: 7, start: "15:30", end: "16:20" },
  { p: 8, start: "16:30", end: "17:20" },
];

export const COURSE_CATEGORY_ORDER = ["전공", "심화", "교직", "핵심교양", "중점교양", "자율교양", "교양"];

// 단독필수 교양 3종의 공식 성격 (2026 요람: 수업영어실습=핵심 교육영어,
// 한국의역사와문화=중점 역사와사회, 현대수학의기초=중점 수학의세계)
const GY_STANDALONE_CAT = {
  수업영어실습: "핵심교양",
  한국의역사와문화: "중점교양",
  현대수학의기초: "중점교양",
};

export function categoryOf(c) {
  if (c.type !== "교양") return c.type; // 전공/심화/교직
  if (c.groupLabel) return c.groupLabel.split(" · ")[0]; // "핵심교양/중점교양/자율교양"
  return GY_STANDALONE_CAT[c.name] || "교양";
}
