// NEIS 급식 응답 파싱 — 순수 로직 (화면·네트워크 없음, 테스트 대상).
//
// NEIS mealServiceDietInfo 의 DDISH_NM 은 이렇게 생겼다:
//   "반미샌드위치 (2.5.6.10)<br/>우유2<br/>사과주스13"
// <br/> 로 줄을 나누고, 뒤에 알레르기 유발식품 번호가 붙는다. 그런데 번호를
// 붙이는 방식이 두 가지다:
//   · 괄호로:  "반미샌드위치 (2.5.6.10)"
//   · 붙여서:  "우유2"  "사과주스13"  "양지쌀국수-초5·6·13·15"
// 실측(2026-07-22, 개운초)에서 둘 다 나왔다.

// 알레르기 번호 구분자: 점 · 가운뎃점 · 쉼표 · 공백
const ALLERGEN_SEP = /[.·,\s]+/;

/** 알레르기 번호 문자열을 배열로. 1~19 범위만 유효 번호로 본다. */
function parseAllergens(s) {
  return String(s ?? "")
    .split(ALLERGEN_SEP)
    .map((x) => x.trim())
    .filter((x) => /^\d{1,2}$/.test(x) && Number(x) >= 1 && Number(x) <= 19);
}

/**
 * DDISH_NM 한 덩어리를 {name, allergens}[] 로.
 * 알레르기 번호가 괄호든 붙어 있든 이름에서 떼어 낸다.
 */
export function parseDishes(raw) {
  return String(raw ?? "")
    .split(/<br\s*\/?>/i)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((t) => {
      // ① 괄호형: "이름 (2.5.6)"
      const paren = /^(.*?)\s*\(([\d.·,\s]+)\)\s*$/.exec(t);
      if (paren) {
        return { name: paren[1].trim(), allergens: parseAllergens(paren[2]) };
      }
      // ② 접미형: 이름 뒤에 "-" 또는 공백 없이 번호가 붙은 경우.
      //    "양지쌀국수(주찬)-초5·6·13" 처럼 학교가 '-초' 를 넣기도 한다.
      //    끝에서부터 [구분자+숫자] 묶음을 걷어 낸다.
      const suffix = /^(.*?)[\s\-]*(?:초)?((?:\d{1,2}[.·,\s]*)+)$/.exec(t);
      if (suffix && suffix[1].trim()) {
        const allergens = parseAllergens(suffix[2]);
        // 숫자가 유효 알레르기 번호일 때만 뗀다. "우유2" 는 떼고,
        // "김치찌개" 처럼 숫자 없는 건 suffix 자체가 안 잡힌다.
        if (allergens.length) {
          // 이름 끝에 남은 구분 기호·'초' 를 다듬는다. "양지쌀국수(주찬)-초"
          // → "양지쌀국수(주찬)". 실측에서 '-초5·6' 형태가 나온다.
          const name = suffix[1].replace(/[\s\-·,]*초?$/, "").trim();
          return { name: name || suffix[1].trim(), allergens };
        }
      }
      // ③ 번호 없음. 다만 학교가 붙이는 "-초"(초등용) 접미는 뗀다.
      //    ⚠️ "식초"·"고추" 같은 실제 이름을 깨지 않도록 **하이픈이 앞에
      //    있을 때만** 뗀다. "수수친환경쌀밥-초" 는 떼고 "고추장" 은 안 뗀다.
      return { name: t.replace(/[\s]*-\s*초$/, "").trim() || t, allergens: [] };
    });
}
