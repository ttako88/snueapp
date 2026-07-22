# GPT 검수 요청 — 2026-07-22 야간 산출물

> **소유자께**: 아래를 **한 번에 하나씩** GPT 에 넘겨 주세요.
> COLLAB_PROTOCOL §5-2 에 "한 packet 에는 하나의 mutation 경계만" 이라고
> 적혀 있습니다. 섞어 보내면 GPT 가 일부만 검토하고 전체를 통과시킵니다
> (실제로 6A 에서 그렇게 됐습니다).
>
> 순서: **① 020 → ② 016 → ③ 022/023 → ④ 019/021**
> ①이 제일 급합니다(보안 + 배포 순서 위험).

---

# PACKET ① — 020 동시 finalize 선점

## 대상
`supabase/migrations/pending/020_finalize_claim.sql` (신규)
`app/api/verification/finalize/route.js` (수정)

## 무엇을 고쳤다고 주장하는가

COLLAB_STATE "미해결 결함: 동시 finalize 시 claim 전이·DB 락 부재".

**결함 경로 (코드 분석):**
1. 라우트가 `status='uploading'` 을 **읽어서** 확인
2. staging 객체를 내려받아 바이트 검증 (수백 ms ~ 수 초)
3. `verified/<request_id>/document` 에 `upsert:true` 로 업로드
4. 되읽어 digest 대조
5. `svc_set_verification_storage_path` → `finalize_verification`

1과 5 사이에 잠금이 없다. 같은 요청으로 finalize 가 동시에 둘 들어오면 둘 다
1을 통과하고 각자 2를 수행한다. staging 의 signed upload token 은 아직 유효하므로
사용자가 두 번의 2 사이에 파일을 바꿔칠 수 있다. 순서가
`A업로드 → A되읽기(통과) → B업로드` 로 엮이면 **정본에 A 가 검증한 적 없는
바이트가 남고 A 는 성공을 응답한다.** 4의 digest 대조는 자기 업로드 직후만
보므로 이 창을 닫지 못한다.

**수정:** 파일을 건드리기 **전에** 선점한다.

## 근거 종류 (중요)
- 결함 존재: **코드 분석만. 재현 실증 없음(`NOT_REPRODUCED`).**
  재현하려면 운영 DB 에 인증 신청을 만들어야 하는데 야간 금지 범위였다.
- SQL 정합성: `MEASURED` — 누적 dry-run PASS, 롤백 후 스키마 동일
- 라우트 동작: `NOT_VERIFIED` — 020 미적용이라 실행해 보지 못했다

## 특히 봐 주었으면 하는 것

1. **선점 조건이 충분한가.**
   `where id=? and member_id=? and status='uploading'
    and (finalize_claimed_at is null or finalize_claimed_at < now() - interval '2 minutes')`
   동시 UPDATE 가 같은 행에서 직렬화되므로 하나만 `row_count=1` 을 받는다고
   판단했다. READ COMMITTED 에서 이 판단이 맞는가?

2. **TTL 2분이 적절한가.** 라우트 `maxDuration` 이 60초다. 2분이면 정상 처리
   중인 요청을 가로챌 수 없다고 봤는데, Storage 왕복이 느린 최악을 놓쳤는가?

3. **새 status 값 대신 nullable 컬럼을 쓴 판단.** status 7종이 여러 CHECK·
   부분 유니크 인덱스에 얽혀 있어 값 추가 비용이 크다고 봤다. 동의하는가?

4. **해제 경로 누락.** 선점 후 실패로 끝나는 return 을 12곳 찾아 `fail()`
   하나로 모았다. 놓친 경로가 있는가? (특히 예외로 빠지는 경로)

5. **배포 순서 위험.** 라우트가 미적용 RPC 를 호출한다. 마이그레이션 → 배포
   순서를 어기면 인증 제출이 전부 실패한다. 이걸 문서 경고 말고 **기계적으로**
   막을 방법이 있는가? (지금은 보고서 최상단 경고뿐)

## 롤백
- 마이그레이션: 컬럼·함수 추가만. `alter table ... drop column finalize_claimed_at`
  + `drop function` 으로 되돌아간다. 기존 데이터 변경 없음.
- 라우트: git revert.

## 미충족 항목
- 동시성 재현 테스트 (`test-018-concurrency.mjs` 방식) — 운영 데이터 필요
- 실제 finalize 왕복 시간 실측 (TTL 근거)

---

# PACKET ② — 016 통계 항목별 분모

## 대상
`supabase/migrations/pending/016_course_review_write_read.sql` §5 (추가분)

## 무엇을 고쳤다고 주장하는가

COLLAB_STATE "미해결 결함: 011 이 항목별 denominator 가 아니라 전체 k 로만 게이트".

011 의 공개 게이트는 `서로 다른 작성자 >= 10` 하나뿐이다. 그런데 이 배치의
`submit_course_review` 는 **5개 항목 중 2개만** 답해도 통과시킨다.
따라서 작성자가 10명이어도 특정 항목은 3명만 답한 상태가 가능하다.

그 상태에서 011 의 `min(c) >= 3` 은 통과한다. 3명이 같은 값을 골랐다면 출력이
`{"보통": 3}` 이고, 이는 **분모 10이 아니라 분모 3인 통계**다.
k=10 게이트가 그 항목에는 한 번도 적용되지 않았다.

`early`(5~9명) 분기도 최빈값 비율을 `v_top_cnt / v_reviewers` 로 계산한다.
분모가 **그 항목 응답자 수가 아니라 전체 작성자 수**다.

**수정:** 항목마다 `n_item`(그 항목 응답자 수)을 세고,
`n_item >= 10 AND min_cell >= 3` 일 때만 분포를 공개. early 는 `n_grading` 을 분모로.

## 특히 봐 주었으면 하는 것

1. **`n_item >= 10` 이 맞는 임계인가.** 전체 k 와 같은 값을 썼는데, 항목별로는
   더 높아야 하는가 낮아도 되는가?
2. **`n` 을 함께 공개하기로 한 판단.** 분모를 숨기면 사용자가 3명짜리를
   10명짜리로 오해한다고 봤다. 그런데 `n` 자체가 정보를 새게 하는가?
   (예: 특정 항목만 응답자가 적다는 사실이 누군가를 지목하는가)
3. **`hidden_reason` 노출.** `too_few_answers` / `sparse_cell` 을 구분해서
   준다. 이게 역산 단서가 되는가?
4. **응답 모양 변경.** 분포가 최상위에서 `items` 아래로 내려갔다.
   flag 가 OFF 라 지금 깨질 곳은 없지만, 켜기 전 화면 수정이 필요하다.
   호환 유지가 더 나은가?

## 근거 종류
- SQL 정합성: `MEASURED` (dry-run PASS, 함수 +4 — stats 는 교체라 증가분 아님)
- 프라이버시 판정: **설계 판단. 실데이터 검증 없음** (평가 데이터가 0건)

## 롤백
`create or replace` 로 011 원본 정의를 다시 실행하면 된다.

---

# PACKET ③ — 022/023 화폐 분리와 SR 차감

## 대상
`docs/CURRENCY_SPLIT_DESIGN.md`
`supabase/migrations/pending/022_currency_split.sql`
`supabase/migrations/pending/023_ai_credit_charge.sql`
`app/api/lesson-plan/route.js` (수정, `aiCreditCharge` flag 뒤)

## 주장

1. **지금 지도안이 SR 을 안 깎는다.** 018 예산 상한은 "지갑 총액" 만 정하므로
   한 계정이 하루치(약안 ₩22 × 5,000원 ≈ 227건)를 통째로 소진할 수 있다.
2. **화폐를 지금 나눠야 한다.** 유료 기능이 0개라 기존 원장이 전부 무료
   보상이고 소급 분류가 정확하다. 유료가 한 건이라도 섞이면 append-only 라
   영영 못 나눈다.
3. 사업자등록이 없으므로 **유료 판매·에스크로는 열지 않는다.** 식권 마켓은
   매칭만.

## 특히 봐 주었으면 하는 것

1. **차감을 생성 전에 하고 실패 시 환불하는 순서**가 맞는가?
   (018 예산은 예약→정산 방식인데 SR 은 차감→환불이다. 두 방식이 한 요청에
   섞여 있는데 상호작용에 구멍이 있는가?)
2. **`FOR UPDATE` 로 회원 행을 잠가 잔액 경합을 막는 것**이 충분한가?
   018 rev2 에서 쓴 방식과 같은데, 여기선 guard row 가 아니라 members 행이다.
3. **환불을 부르는 3경로**(예산거부·생성실패·빈결과)가 맞는가?
   빈 결과일 때 환불하는 판단 — 돈은 나갔는데 SR 은 돌려준다. 옳은가?
4. **법적 판단 검증.** 사업자등록 없이 유료 크레딧·에스크로가 불가하다는
   제 판단이 과한가 부족한가? (저는 법률 자문을 할 수 없어 방어적으로 썼다)
5. `marketplace` 값을 일부러 안 만든 판단.

## 근거 종류
- SQL: `MEASURED` (dry-run PASS)
- 라우트: `NOT_VERIFIED` (flag OFF, 023 미적용)
- 법적 제약: **미검증 판단.** 확인 필요

---

# PACKET ④ — 019/021 (낮은 우선순위)

## 대상
`pending/019_practicum_placement.sql` (기존, 재검수)
`pending/021_orphan_detection.sql` (신규)
`app/practicum/placement/page.js` · `app/lib/practicum/placement.js`
`scripts/manual/diag-orphan-storage.mjs`

## 봐 주었으면 하는 것

1. **019**: 학기별 배정이 "학교 인증" 으로 오인되지 않게 화면 문구를 썼다.
   충분한가? 잠긴 뒤 무료 변경 정책에 악용 경로가 있는가?
2. **021**: 읽기 전용으로만 만들고 삭제 함수를 아예 안 넣었다.
   반환값(`exists`/`purged`/`has_path`/`status`)이 필요 이상인가?
3. **탐지 도구**: "모르겠으면 고아가 아니다" 원칙으로 UNKNOWN 을 분리했다.
   판정 로직에 오탐 경로가 있는가? (오탐이 나중에 삭제 대상이 되면 학생
   재학증명서가 날아간다)

## 근거 종류
- SQL: `MEASURED` (dry-run PASS)
- 탐지 도구: `NOT_VERIFIED` — 021 미적용이라 실행 못 함

---

## 공통 — 제가 이번에 저지른 실수 3건

검수자가 알면 도움이 될 것 같아 적습니다. 전부 `node --check` 는 통과했습니다.

1. `package.json` 을 정규식으로 편집 → 후행 쉼표 → dev 서버 500
2. 이미 있는 `PRACTICUM_STAGES` 를 못 보고 `PRACTICUM_TERMS` 중복 작성
3. 동적 경로 `fs` 읽기 → Turbopack 이 프로젝트 전체를 서버 번들에 포함
   (빌드 경고가 잡아 줌)

**같은 유형이 검수 대상 코드에도 있는지 봐 주시면 좋겠습니다.**
