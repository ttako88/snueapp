# [UI 구현 스펙] 지도안 생성기 — '출판사' 상위 선택 단계 추가 (단원 중복 해소)

작성: Claude (2026-07-23). **담당: Claude(또는 브라우저 협업 GPT) — page.js UI 코드.**
※ 로컬 GPT(자료 수집·가공 전용) 대상 아님. 데이터 쪽 지시는
`PACKET_local_GPT_data_improvements.md` 참고.

## 배경 / 문제
- 지도안 생성기에서 학년·교과를 고르면 같은 단원이 2~3개씩 중복으로 뜬다.
  예) 5학년 사회 → 한 단원이 세 벌. 서로 **다른 출판사의 같은 단원명**이라서다.
- 사용자가 무엇을 고르는지 혼란스럽다. 네가 붙인 `textbookLabel`로 구분은 되지만,
  **애초에 출판사를 먼저 고르게 해서 목록을 한 벌로 좁히는** 편이 낫다(소유자 지시).

## 목표 UX
학년 → 교과 다음에 **단원 목록 위에 '출판사' 칩 선택**을 둔다. 출판사를 고르면
그 출판사의 단원만 표시. 출판사가 1곳뿐이면 칩을 숨기고 그대로 전부 표시.

## 구현 위치
`app/practicum/lesson-plan/page.js` (네가 지금 편집 중인 파일). 데이터는 이미 있다:
`buildUnitList`(unitList.mjs)가 각 unit에 `publisher`를 넣어준다. `textbookLabel`도 활용.

## 배선 (구체)
1. 상태: `const [publisher, setPublisher] = useState("");`
2. grade/subject 바뀌는 useEffect(단원 초기화 자리)에 `setPublisher("")` 추가.
3. 파생값(렌더 계산):
   ```js
   const publishers = [...new Set(unitList.map((u) => u.publisher).filter(Boolean))];
   const shownUnits = publisher
     ? unitList.filter((u) => u.publisher === publisher)
     : (publishers.length <= 1 ? unitList : []);
   ```
4. 교과 칩 아래·단원 헤딩 위에 **출판사 칩 섹션**을 렌더 — `unitList.length > 0 && publishers.length > 1`일 때만. 각 칩=출판사명, 클릭 토글, 기존 `chip()` 스타일 재사용.
5. 단원 목록 `.map` 소스를 `unitList` → **`shownUnits`** 로 변경.
6. `publishers.length > 1 && !publisher`이면 단원 목록 대신 "출판사를 먼저 골라주세요" 힌트(shownUnits가 빈 배열이라 자연히 비어 있음).
7. 출판사를 바꾸면 선택 단원 초기화: `setUnit(""); setTextbookId("");` (다른 출판사 단원이 선택에 남지 않게).

## ⚠️ 지켜야 할 것 (내 커밋과 충돌 방지)
- **먼저 `git pull`** 해서 내 커밋 `4ac4839` 위에서 작업할 것. 그 커밋 내용은
  **되돌리지 말 것**:
  · `canUse`에 `access?.allowed` 추가(= 생성권 보유자에게 노출). **canUse는 `access`
    선언 뒤에 있어야 한다**(앞에 두면 TDZ로 렌더가 깨진다).
  · SYSTEM v1/v2/v3의 이모지 금지 규칙(lessonPrompt.mjs).
- 네 기존 WIP(`textbookLabel`/`isSelected`/`buildEvidence`/CSV 데이터)는 그대로 유지하고
  그 위에 얹기.
- 단원 버튼 `key`에 이미 publisher·textbookId가 들어 있어 중복 key 문제 없음.
- 서버 근거(buildEvidence)는 `textbookId`로 이미 책을 특정하므로, 출판사 UI 필터를
  더해도 grounding은 그대로 정확하다.

## 검증
5학년 사회에서 출판사 하나를 고르면 단원이 **한 벌만** 뜨는지. 출판사 1곳뿐인
학년·교과는 지금과 동일하게 바로 단원이 뜨는지.
