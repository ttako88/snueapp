// 목표 평점 역산 — "졸업까지 남은 학점으로 목표 평점을 맞추려면 평균 몇 점이 필요한가"
// design.md §12.2. 순수 함수라 화면 없이 검증 가능.

export const MAX_GPA = 4.5;   // 서울교대 4.5 만점

/**
 * @param {object} p
 * @param {number} p.currentPoints    지금까지의 가중합 (Σ 학점×평점)
 * @param {number} p.gradedCredits    평점이 매겨진 학점 (P·NP 제외)
 * @param {number} p.targetGpa        목표 평점
 * @param {number} p.remainingCredits 앞으로 들을 학점
 * @returns {null | {required:number, status:'ok'|'already'|'impossible'}}
 *   null = 계산 불가(남은 학점이 0 이하)
 *   already   = 남은 과목을 0점 받아도 목표 달성 (required는 0으로 보고)
 *   impossible= 남은 과목을 전부 만점 받아도 목표 미달
 */
export function requiredAverage({ currentPoints, gradedCredits, targetGpa, remainingCredits }) {
  const rem = Number(remainingCredits) || 0;
  if (rem <= 0) return null;

  const cur = Number(currentPoints) || 0;
  const gc = Number(gradedCredits) || 0;
  const target = Number(targetGpa) || 0;

  // target = (cur + rem×x) / (gc + rem)  →  x = (target×(gc+rem) − cur) / rem
  const required = (target * (gc + rem) - cur) / rem;

  if (required <= 0) return { required: 0, status: "already" };
  if (required > MAX_GPA) return { required, status: "impossible" };
  return { required, status: "ok" };
}

/** 남은 학점을 전부 만점 받았을 때 도달 가능한 최대 평점 */
export function maxReachableGpa({ currentPoints, gradedCredits, remainingCredits }) {
  const rem = Number(remainingCredits) || 0;
  const cur = Number(currentPoints) || 0;
  const gc = Number(gradedCredits) || 0;
  if (gc + rem <= 0) return 0;
  return (cur + rem * MAX_GPA) / (gc + rem);
}
