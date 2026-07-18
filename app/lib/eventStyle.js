// 캘린더 "일정 성격"별 색을 한 곳에서 관리.
// 지금은 학교 학사일정(파랑)만 실제로 들어오고,
// 초록·주황·빨강은 나중에 e-Class(과제/영상강의/시험) 연동 때 저절로 채워짐.
//
// 색은 전부 톤다운(파스텔 계열)으로, 우리 앱 파란 톤과 어울리게.
//   main = 점/막대 강조색, bg = 연한 배경, text = 배경 위 글자색

export const EVENT_STYLES = {
  학사일정: { main: "#4b86c7", bg: "#e7f0fa", text: "#2f6aad" }, // 💙 파랑
  과제: { main: "#4a9d6a", bg: "#e4f3e9", text: "#34784f" }, // 💚 초록 (e-Class)
  영상강의: { main: "#d98a3d", bg: "#fbf1e0", text: "#a6691f" }, // 🧡 주황 (e-Class)
  시험: { main: "#d05b6a", bg: "#fbe6e9", text: "#b03c4c" }, // ❤️ 빨강 (e-Class)
};

const DEFAULT_STYLE = { main: "#4b86c7", bg: "#e7f0fa", text: "#2f6aad" };

export function eventStyle(category) {
  return EVENT_STYLES[category] || DEFAULT_STYLE;
}
