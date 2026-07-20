# Batch 0 — 서버 잡 ↔ DB RPC 경계 대조표 (GPT 지시)

> 목적: 서버 잡 4종의 모든 DB 단계가 **기존 public service_role RPC**로 가능한지 대조.
> 결론: **대부분 누락** → 우회(직접 private 접근) 금지, `009_server_job_rpcs.sql` 초안으로 보충(원격 미적용).
> 동결본 001~008(SHA 6746127)은 불변. 009는 GPT 배치 검수 → dev 리허설 → 재동결 대상.

## 기존(001~008) service_role 전용 public RPC
- `begin_verification`, `finalize_verification` (신원 2단계 — 클라 아님, 서버 트랙 B)
- `claim_guest_read` (미리보기)
- `acquire_maintenance_lease`, `release_maintenance_lease` (중복 실행 방지)
- `prepare_account_deletion(uuid)`, `detach_member_content(uuid)` (계정삭제 ①~⑧)
- (참고) private 배치: `expire_sanctions`, `purge_soft_deleted_content`, `purge_expired_holds`,
  `purge_expired_guest_reads` → pg_cron이 직접 호출(Storage 무관). **서버 잡과 별개.**

## 잡별 대조 (○=기존 충족 / ●=009 신규 / —=DB 불필요)

### purge-verification-docs
| DB 단계 | 상태 | RPC |
|---|---|---|
| 파기 대상 claim(purge_after 경과)+purge_started/attempts | ● 009 | `claim_verification_docs_to_purge(limit)` |
| Storage 삭제 성공 후 path·real_name null·purged_at | ● 009 | `mark_verification_doc_purged(id)` |
| 실패 기록(비식별) | ● 009 | `record_verification_purge_failure(id, code)` |
| Storage 원본 삭제 | — | 서버(Storage API) |

### expire-uploads
| DB 단계 | 상태 | RPC |
|---|---|---|
| uploading+24h → upload_expired 전이 + 정리 대상 반환 | ● 009 | `claim_expired_uploads(limit)` |
| Storage 완료/실패 처리 | ● 009 | A-2/A-3 재사용 |

### stale-reviews
| DB 단계 | 상태 | RPC |
|---|---|---|
| 3/7일 owner 경고 + 사용자 지연 안내(중복 방지 시각 컬럼) | ● 009 | `run_stale_review_notifications(limit)` |
| 30일 → expired_unreviewed+pending 복귀+사과+purge_after(한 트랜잭션) | ● 009 | `expire_unreviewed_submissions(limit)` |

### delete-accounts (§13)
| DB 단계 | 상태 | RPC |
|---|---|---|
| 대상 조회(기한경과 미인증 + deleting 재개) | ● 009 | `claim_accounts_for_deletion(limit)` |
| ①~④ deleting 전이·hold·snapshot | ○ 기존 | `prepare_account_deletion(uuid)` |
| ⑤~⑧ 표시 대체·연결 제거 | ○ 기존 | `detach_member_content(uuid)` |
| Storage 경로 반환 | ● 009 | `get_member_verification_paths(uuid)` |
| Storage 원본 삭제 → Auth Admin 삭제 | — | 서버(Storage API·Auth Admin) |
| 삭제 수렴 확인(members cascade) | ● 009 | `account_deletion_converged(uuid)` |

### 공통
| 단계 | 상태 | RPC |
|---|---|---|
| batch_runs 기록 | ● 009 | `record_maintenance_run(job, ok, processed, error_code)` (private.record_batch_run 래핑) |

## 신규 public service_role RPC = **10종** (GPT B-1 집계 정정 — 이전 "12종"은 오기)
- 공통 1 / purge 3 / expire 1 / stale 2 / delete 3 = 10.
- (+ `private.prepare_account_deletion` 멱등 보강은 기존 함수 CREATE OR REPLACE — 신규 public 아님.)

## path·member UUID 반환 경계 (GPT B-3 정정)
- **허용**: service_role RPC가 서버 모듈로 storage_path·member UUID 반환(= Storage remove·Auth Admin delete에 필수).
- **금지**: HTTP 응답 / 일반 앱 로그 / batch_runs·audit 평문 target / 클라이언트 반환.

## GPT 판정 반영 (Q1~Q5)
- Q1. `verification_doc_retention_days` **추가 안 함**. 파기 기준은 행별 `purge_after`(claim은 `purge_after <= now()`만 판정, 재계산 없음). expire_unreviewed가 전이 시 `purge_after = now()+7d` 확정. `purge_after IS NULL`은 자동파기 제외·이상상태 점검 대상.
- Q2. 경고 수신자 = **operator+owner** (verified·sanction none). `owner_warned_3_at/7_at`는 "운영진 경고 발송 완료" 의미(레거시 명칭). 발송+표식 한 트랜잭션.
- Q3. `operational_messages.kind` = **'system' 재사용 승인**('warning'은 회원 모더레이션용이라 부적합, 동결 CHECK 미변경).
- Q4. **009에서 `prepare_account_deletion` 멱등 보강**: 이미 deleting이면 hold/snapshot 재삽입 없이 정상 반환(최초 진입 시에만 전이·hold·snapshot). post-freeze CREATE OR REPLACE로 허용(001~008 수정 아님).
- Q5. **현재 범위 승인**. 자발 탈퇴 접수 UI/RPC는 **DEFERRED**(009 말미·문서에 명시). 향후 자발 탈퇴 RPC가 prepare를 호출해 deleting을 만들면 Cron이 재개. withdrawal 컬럼 지금 미추가.

## 다음 (GPT D)
- 수정된 009 + 본 표는 DRAFT·원격 미적용 유지.
- **Batch 1(Route·공통 보안 기반) 병행 착수 허용** — dependency injection + mock(실제 RPC 성공 불요).
- Batch 1 검수 요청 시 수정된 009 요약 + Route 테스트 결과 동반 제출.
- 009 dev 적용·재동결은 Batch 1 코드 검수 뒤 별도 단계.
