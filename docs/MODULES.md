# 기능 모듈 창고 — "아침에 붙였다 뗐다"

> 목적: 조상호님이 **"이 기능 넣자 / 빼자"** 하면 **즉시** 붙이거나 뗄 수 있게 하는 것.
> 현황표는 2026-07-22 야간에 `features.js` 실측으로 갱신 (이전 표는 pending 번호가
> 어긋나 있었다). 원본은 항상 `app/lib/features.js` — 이 문서와 다르면 코드가 맞다.

## 붙이는 법 (3단계)

1. `app/lib/features.js` 에서 해당 모듈 `enabled: true`
2. 그 모듈이 `needsDb: true` 면 → `supabase/migrations/pending/` 의 SQL을 적용
3. `requires` 에 적힌 선행 조건이 끝나 있는지 확인 (안 지키면 사고 나는 것만 적어둠)

**떼는 법**: `enabled: false` 한 줄. (DB 테이블은 남지만 화면에서 사라짐 — 데이터 손실 없음)

## 모듈 1개의 구성

```
app/lib/features.js          ← 스위치 한 줄
app/<기능>/…                  ← 화면 (라우트)
app/components/<기능>/…       ← 부품
app/lib/<기능>.js             ← 순수 로직 (테스트 대상)
supabase/migrations/pending/  ← DB 필요 시 SQL (★운영 미적용 상태로 대기)
tests/<기능>.test.mjs         ← node --test
```

## 절대 규칙

- **동결된 001~009 는 수정 금지.** 추가는 새 번호 파일로만 (현재 023 까지).
- **`pending/` 의 SQL은 운영에 소유자 승인 없이 적용하지 않는다.**
  검증은 `npm` 없이 `node scripts/manual/prod-dryrun-pending.mjs`
  (운영 스키마에 누적 적용 후 **ROLLBACK** — 잔여물 0).
- 기능 스위치는 **UX용**이다. 보안 최종 기준은 DB(RLS·definer 함수).
  `enabled: true` 로 화면을 열어도 DB 정책이 막으면 막히는 게 정상이다.
- 새 데이터를 수집하는 모듈은 `docs/DATA_AND_MODERATION_CHARTER.md` 8조 검사를 통과해야 한다
  (목적제한·최소수집·식별자분리·보존기한).

## 모듈 현황 (features.js 실측 2026-07-22)

`✅` = flag ON / `⏸️` = flag OFF (코드는 있음) / `[적용]` = 운영 DB 반영 / `[pending]` = 미적용

| 모듈 | flag | DB | 비고 |
|---|---|---|---|
| 강의조회 `courseSearch` | ✅ | 불필요 | 2022~2026 8학기. **한글 초성검색 지원**(ㄱㅇ→국어) |
| 게시판 공지 고정 `boardNotice` | ✅ | `012` [적용] | |
| 추천/반대 `postVote` | ✅ | `013` [적용] | |
| 스크랩 `bookmark` | ✅ | `013` [적용] | |
| 신고 `report` | ✅ | `013` [적용] | ⚠️ 운영자 큐 화면 없음 → `docs/MODERATION_QUEUE_DESIGN.md` |
| 버그제보 `bugReport` | ✅ | `014` [적용] | |
| 강의평가 `courseReview` | ⏸️ | `011` [적용] + `016` [pending] | 과목 마스터 동결. 016 에 통계 결함 수정 포함 |
| 식권 마켓 `mealTicketMarket` | ⏸️ | 미작성 | **매칭 전용**으로 재설계(에스크로 불가·사업자 없음) |
| 소셜 로그인 `socialLogin` | ⏸️ | 불필요 | 키 발급 필요 |
| 지도안 SR 차감 `aiCreditCharge` | ⏸️ | `022`→`023` [pending] | OFF 면 개인별 제한 없음 → `docs/POINT_ECONOMY.md` |
| 학기별 실습학교 `practicumPlacement` | ⏸️ | `019` [pending] | 화면 `app/practicum/placement` 있음 |

### flag 없이 동작하는 기능 (스위치 대상 아님)
- 실습모드 `app/practicum` — 급식(NEIS, **오프라인 캐시**)·연락처·준비물·타임라인
- 수업지도안 `app/practicum/lesson-plan` — 제미나이. 프롬프트 v2 기본.
  근거 데이터는 `app/data/lessonPrompt/`(있으면 품질↑, 없어도 동작).
  `docs/LESSON_DATA_CONTRACT.md` · SR 차감은 위 `aiCreditCharge`
- 학사일정 `app/calendar`(e-Class 연동) — `/schedule` 은 구 프로토타입(도달 불가)

### pending 마이그레이션 (승인 대기, 누적 dry-run PASS)
`016`(강의평가+통계수정) · `019`(실습배정) · `020`(finalize 동시성) ·
`021`(고아탐지) · `022`(화폐분리) · `023`(AI 과금).
**`020` 은 라우트가 이미 의존 → 적용 전 배포 시 인증 장애. 마이그레이션→배포 순서.**
상세: `docs/COLLAB_STATE.md`, 검수요청 `docs/reviews/REVIEW_REQUEST_2026-07-22_NIGHT.md`

> `⏸️` 는 **코드가 다 있고 스위치만 꺼져 있다**는 뜻입니다.
