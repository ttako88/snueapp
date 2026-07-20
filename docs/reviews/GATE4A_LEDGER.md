# Gate 4a Ledger — 마이그레이션 대응표 + 테스트 계약 75건 대응 (GPT 검수 요구)

> dev 리허설 실측 기록. 단계 B(산출물 동결) 전 clean replay로 최종 SHA 확정 예정.

## 1. 마이그레이션 파일명 대응 (구 → 신, 숫자 순번 정규화)

| 구 파일명 | 신 파일명 | 내용 |
|---|---|---|
| 001_schemas_roles.sql | 001_schemas_roles.sql | private/authz 스키마·권한·default privileges |
| 002_foundation.sql | 002_foundation.sql | 테이블 21종·인덱스·CHECK·RLS·컬럼권한·boards 시드 |
| 003_functions_triggers.sql | 003_functions_triggers.sql | authz 헬퍼·RLS 정책·트리거·회원/상호작용/신원/심사/미리보기 RPC |
| 003b_functions_part2.sql | **004_admin_batch_functions.sql** | 모더레이션·배치·lease·계정삭제 DB부 |
| 004_schedules.sql | **005_schedules.sql** | pg_cron 4종 |
| 005_storage_policies.sql | **006_storage_policies.sql** | Storage 정책(기본 0개) |
| 007_soft_delete_rpc.sql | 007_soft_delete_rpc.sql | soft_delete_post/comment definer RPC (dev 발견 결함 수정) |
| 006_harden_private_exec.sql | **008_harden_private_exec.sql** | private 함수 PUBLIC EXECUTE 최종 sweep |

- 적용 순서: 001→002→003→004→005 → provision-storage(버킷) → 006 → 007 → 008
- 008을 마지막에 두는 이유: 모든 함수 생성 후 잔여 PUBLIC EXECUTE를 잡는 최종 안전망 (GPT 4항)

## 2. dev 실측 발견 결함 3건 (전부 수정·재검증)

| # | 결함 | 심각도 | 수정 |
|---|---|---|---|
| 1 | private 내부 함수 PUBLIC EXECUTE 잔존 | 중(USAGE 차단이 주 방어선) | 008 일괄 revoke + 각 함수 생성직후 명시 revoke 유지 |
| 2 | claim_guest_read view_count 컬럼 모호성(42702) | 높음(미리보기 운영 실패) | 003 별칭 p.view_count |
| 3 | soft delete RLS↔SELECT 가시성 충돌 | **치명(자기 글 삭제 불가)** | 007 definer RPC 전환 + 클라 deleted_at 권한 제거 |

## 3. 테스트 계약 75건 대응 (PASS / 통합 / DEFERRED)

**DB 실측 PASS = 59건** (그룹 M/R/F/A/V/D/P/W/G/X-lease). 나머지 분류:

| 원 계약 그룹 | 상태 | 비고 |
|---|---|---|
| F/M/R/V/D/A/P/W/G 대부분 | **PASS (59)** | authenticated/anon/service_role 컨텍스트 DB 실측, postcondition 판정 |
| X-04/05 (lease) | PASS | acquire/release/재획득 DB 실측 |
| X-01/02/03/06~10 (maintenance Route·서버잡) | **DEFERRED** | Route/서버 잡 코드는 계약(README)만 존재, 구현 전 = Gate 4a 서버부/Gate 5~6. SQL 산출물 동결과 별개 |
| purge-verification-docs·delete-accounts·expire-uploads·stale-reviews (서버 잡) | **DEFERRED** | Vercel Cron Route 미구현. DB 함수(prepare/detach/purge_*)는 PASS |
| 미리보기 Route(HTTP) | DEFERRED (Gate 5) | claim_guest_read 함수 수준은 PASS |
| comment_count "공개 댓글 수"(hide/restore 반영) | **DEFERRED(개선)** | 현재 count=미삭제 댓글 수. GPT 규칙(hide -1/restore +1)은 moderate_content 개선 필요 — clean replay 후 반영 |

- **"전 그룹 완료"가 아니라 "DB 실측 59 PASS + 서버부 DEFERRED"**로 표기 (GPT 5항). SQL 산출물 동결 ≠ Gate 4a 전체 완료.

## 4. clean replay 계획 (단계 B 산출물 동결 직전 — GPT 6항)

1. 최종 파일명·내용 확정 ✅ (001~008)
2. dev 재기반 (운영 적용과 동일 방식으로 스키마 drop)
3. 001~005 적용 → 4) 버킷 provision·검증 → 5) 006~008 적용
6. fixture 재생성 → 7) 59건 재실행 → 8) 사후검증(PUBLIC EXECUTE·RLS·grant·cron·카운트)
9. 본 75건 대응표 갱신 → 10) 통과 커밋 SHA 동결
- SQL Editor 수동 적용을 공식 방식으로 유지 시: 파일별 SHA·적용시각·postcondition을 이 ledger에 기록
- ⚠️ dev 재기반은 파괴적 → 무인 강행보다 사용자 기상/확인 후 실행 권장 (현재 dev는 59 PASS 검증 상태이므로 보존)

## 5. 남은 문서 동기화
- GATE3_DESIGN.md v1.4: §4.1 학번 8자리 ✅, §5.2 soft delete RPC ✅
- comment_count 규칙(§5.5/§5.6)·moderate_content hide 반영: clean replay 후
