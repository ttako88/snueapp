# Gate 4a 착수 계획서 — DB 재기반 (dev 리허설 순서표)

- 작성: 2026-07-20 야간, Claude / **v0.2 — GPT 검수 6건 반영, "4a 계획 승인 · 실행 승인 대기" 상태**
- 설계 기준: [GATE3_DESIGN.md](GATE3_DESIGN.md) v1.3 (승인·커밋 dacd7a8). 이 문서는 "무엇을 어떤 순서로 실행하고 무엇이 통과 조건인지"만 다룬다
- ⚠️ **이 문서 작성 자체는 실행이 아니다.** 실제 SQL 실행·Storage·Cron·env 작업은 사용자의 착수 승인 후에만 시작한다

## 0. 전제 조건과 승인 지점 (GPT 검수 반영: 승인 2단계 분리)

| # | 조건 | 상태 |
|---|---|---|
| P1 | GATE3_DESIGN.md v1.3 GPT 승인 + 커밋 | ✅ 완료 (dacd7a8) |
| P2 | **사용자의 dev 리허설 착수 승인** — dev 프로젝트 한정, 운영 무접촉 | ✅ 승인 (2026-07-20) |
| P3 | SNUE 학번 형식 | ✅ 확인 (2026-07-20): **8자리 = 입학년도4+학과코드2+개인번호2**, `^\d{8}$` |
| P4 | dev 프로젝트(snueapp-dev) 접속 확인 + 운영/dev 프로젝트 ID 구분표 작성 | 착수 시 |

- **운영 초기화 승인은 P2와 별개** — 단계 B-8에서 ①대상 운영 프로젝트 ID ②삭제 범위(대상/비대상 구분) ③백업 결과를 제시한 뒤 **별도의 실행 승인**을 받는다. (과거의 "초기화 원칙 승인"은 정책 결정이고, B-8은 파괴 작업 직전의 실행 승인)
- **dev에는 실제 학생증·재학증명서·실제 학번을 절대 사용하지 않는다** — 합성 fixture만 사용

## 1. 산출물 목록

```
supabase/migrations/
  001_schemas_roles.sql      — private 스키마, 스키마 권한 revoke, default privileges 제한
  002_foundation.sql         — 테이블 전체·인덱스·CHECK·RLS·컬럼 권한·boards 시드 9행
  003_functions_triggers.sql — §2 트랙 A/B 템플릿 준수 함수·트리거 (+revoke/grant 동일 트랜잭션)
  004_schedules.sql          — pg_cron 4종 (DB 내부만: sanction 만료/soft delete 30일/hold 파기/guest TTL)
  005_storage_policies.sql   — Storage 정책 전용 (r3 신설. 적용 순서: 001~004 → provision-storage → 005.
                               객체 조작 SQL 없음, anon/authenticated 직접 정책은 기본 0개)
scripts/
  provision-storage.mjs      — 버킷 생성 (private, 10MB, MIME 제한) — dev·운영 동일 스크립트
  gate4a-tests/              — §10 보안 테스트 (node --test, dev 대상, 합성 fixture만)
app/api/maintenance/        — 서버 Cron 실행부 (GPT 검수 반영 — vercel.json만으로는 실행되지 않음)
  route 1개(maintenance) 또는 작업별 분리 — 구현 시 단순한 쪽 선택
  작업 모듈 4종: 인증원본 파기 / 계정 삭제(§13 14단계) / 업로드 미완 정리 / 장기 미처리
  공용 Storage API 삭제 모듈 (파기·계정삭제 공유)
  배치 실행 기록·재시도 상태 (마지막 성공 시각·attempts·last_error)
vercel.json                  — Cron 스케줄 선언 (CRON_SECRET 검증, 아래 안전장치)
env 목록 문서                — 필요한 env 전체 목록 + dev/prod 분리 규칙 (값은 문서에 미기재)
archive/002_snue_email_restriction.sql — 기존 도메인 제한 마이그레이션 폐기·보관
```

- **Cron 안전장치**: DB 준비+smoke 통과 전까지 실행되지 않도록 비활성 기본값(또는 동등 장치 — 예: env 플래그 없으면 즉시 no-op). CRON_SECRET 인증 실패 시 아무 작업도 하지 않음

## 2. 실행 순서 (dev 리허설 → 동결·보고 → 운영)

### 단계 A — dev 리허설 (운영 무접촉)
1. ✅ dev 프로젝트 ID 재확인 (snueapp-dev / uiikgqeoxocpvphlmoqp — SQL Editor 헤더로 확인)
2. ✅ **001→002→003→003b→004 dev 적용 완료** (2026-07-20, 내부 브라우저 SQL Editor 경유. 검증: private 테이블 18·authz 함수 5·private 함수 24·public 정책 17·boards 시드 9·cron job 4종)
   - ⚠️ 절차 기록: SQL Editor의 "destructive operation" 확인 모달이 일부 실행을 조용히 막아 003b·004가 1차에서 미적용됐었음 — 카운트 검증으로 발견해 재적용. **모든 적용은 반드시 사후 카운트 검증 필수** (운영 적용 시 체크리스트에 포함)
3. ✅ 005 적용 (storage.objects RLS 활성 확인·정책 0개 기본값). ⏳ verification-docs 버킷 생성은 미실행 — provision-storage에 dev service_role 키 필요 (사용자와 env 준비 시) 또는 대시보드 UI로 생성
4. 시드·트리거 동작 확인: auth 가입 → members 자동 생성 → set_initial_nickname
5. §10 보안 테스트 전 항목 실행 (함수 권한/RLS/신원(합성 fixture)/2단계 제출/모더레이션/익명·차단/claim_guest_read 함수 수준/파기/탈퇴 13종)
   — 미리보기 **Route**는 Gate 5 범위. 4a에서는 **claim_guest_read 함수 수준 테스트**까지만
6. 실패 항목 → 마이그레이션 수정 → **dev 재초기화 후 처음부터 재적용** (누더기 패치 금지)
7. **초기화 절차 자체 리허설 (GPT 검수 반영)**: dev에 기존 구조·테스트 계정·테스트 글이 있는 상태를 만들어 놓고, 단계 C의 초기화→재적용 절차를 dev에서 1회 예행

### 단계 B — 동결·통과 보고 (운영 진입 게이트)
8. **산출물 동결·커밋** — dev 전 항목 통과 시점의 마이그레이션·스크립트를 커밋하고 **커밋 SHA 확정**
9. 테스트 결과표(항목별 pass/fail)+커밋 SHA를 사용자+GPT에 보고 — **전 항목 통과 없이 운영 진행 금지**
10. **운영 초기화 실행 승인 (별도)**: 대상 운영 프로젝트 ID·삭제 범위·백업 결과 제시 → 사용자 명시적 승인

### 단계 C — 운영 적용 (검증된 동일 SHA만)
11. 운영 백업 체크리스트 (전부 성공 확인 후 진행):
    - DB 스키마·데이터 덤프 성공 확인 (저장 위치 기록)
    - auth 사용자 목록 백업
    - Storage 버킷·객체 목록 백업
    - 적용 대상 프로젝트 ID·env 대상 재확인
12. 초기화 대상/비대상 구분 명시 후 초기화:
    - 대상: public의 기존 커뮤니티 테이블(posts·comments 등)·구 함수·구 정책
    - 비대상 여부 명시 결정: auth.users(기존 가입자)·기존 Storage·프로젝트 설정 — **B-10 승인 문서에 각각 삭제/유지를 명기**
13. **dev에서 검증된 동일 커밋 SHA의 파일만 적용** — 운영에서 즉석 수정 금지, 미검증 로컬 파일 실행 금지. 001~004 → provision-storage --apply(운영, TARGET_ENV=prod) → 005
14. Vercel Cron 4종 + CRON_SECRET env 설정 (운영 env는 사용자 입회 권장). Cron은 비활성 기본값 유지
15. **owner 부트스트랩 6단계** (감사 12.7 — 사용자 본인 계정. smoke보다 먼저 — verified 계정 없이는 smoke 불가)
16. 운영 smoke (최소 범위): 로그인→온보딩→최소 CRUD(글·댓글·추천 1회씩)→권한 경계 1~2건 확인. 파괴적·광범위 테스트는 dev에서 종료된 상태
17. smoke 통과 후 Cron 활성화
18. 완료 보고 + **결과 기록·CURRENT_STATE.md 갱신만 별도 커밋** (산출물 커밋은 단계 8에서 이미 동결)

## 3. 명시적 비포함 (Gate 4b 이후로)
- OAuth(카카오/Google/네이버 feasibility) = 4b / 인증 심사 UI·미리보기 Route = 5 / 신고·제재 콘솔 = 6
- 이번 게이트는 "DB 기반+테스트+스케줄 뼈대"까지. 클라이언트 화면 변경 최소 (기존 기능 유지 확인만)

## 4. 리스크·롤백 (GPT 검수 반영 — destructive reset 이후 단순 rollback 불가)
- **초기화 전 실패**: 변경 중단 (운영은 아직 무손상)
- **초기화 후 실패**: ①백업 기반 복구 또는 ②검증된 동일 SHA로 forward rebuild — 두 경로 중 상황에 맞는 쪽. 운영에서 즉석 수정 금지, 실패 지점 기록 → dev 재현·수정 → 재시도
- dev 전 항목 통과 전 운영 무접촉이 최대 방어선
- 기존 로컬 기능(시간표·수강신청 마법사)은 DB 무관 — 초기화 영향 없음 확인 항목에 포함
