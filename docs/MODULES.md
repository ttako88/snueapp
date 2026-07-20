# 기능 모듈 창고 — "아침에 붙였다 뗐다"

> 2026-07-21 밤샘 자율작업으로 만들어지는 기능들의 규약.
> 목적: 조상호님이 **"이 기능 넣자 / 빼자"** 하면 **즉시** 붙이거나 뗄 수 있게 하는 것.

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

- **동결된 Gate 4a RC(001~009)는 수정 금지.** 추가는 `010` 번대부터 새 파일로만.
- **`pending/` 의 SQL은 운영에 적용하지 않는다.** dev(uiikgqeoxocpvphlmoqp)에서만 실측하고,
  운영 적용은 조상호님 승인 + Gate 4a 배포 이후.
- 기능 스위치는 **UX용**이다. 보안 최종 기준은 DB(RLS·definer 함수).
  `enabled: true` 로 화면을 열어도 DB 정책이 막으면 막히는 게 정상이다.
- 새 데이터를 수집하는 모듈은 `docs/DATA_AND_MODERATION_CHARTER.md` 8조 검사를 통과해야 한다
  (목적제한·최소수집·식별자분리·보존기한).

## 모듈 현황

| 모듈 | 상태 | DB | 선행조건 |
|---|---|---|---|
| 강의조회 `courseSearch` | ✅ 켜짐 | 불필요 | 없음 — 즉시 동작 (2022~2026 8개 학기) |
| 강의평가 `courseReview` | 🟡 DB 초안 | 필요 (`pending/010`) | Gate 4a 배포 + GPT 검수 + dev 리허설 |
| 게시판 공지 고정 `boardNotice` | 🔲 대기 | 필요 | Gate 4a 배포 |
| 추천/반대 `postVote` | 🔲 대기 | 필요 | Gate 4a 배포 |
| 스크랩 `bookmark` | 🔲 대기 | 필요 | Gate 4a 배포 |
| 신고 `report` | 🔲 대기 | 필요 | Gate 4a 배포 |
| 식권 마켓 `mealTicketMarket` | 🔲 대기 | 필요 | Gate 4a 배포 |
| 소셜 로그인 `socialLogin` | 🔲 대기 | 불필요 | Gate 4a 배포 + 키 발급 |

> "대기"는 **코드가 다 만들어져 있고 스위치만 꺼져 있다**는 뜻입니다.
