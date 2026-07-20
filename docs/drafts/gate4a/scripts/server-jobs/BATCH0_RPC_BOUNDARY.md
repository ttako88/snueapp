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

## 009 미결 질문 (GPT 판정 요청 — 009 파일 말미 Q1~Q5와 동일)
- Q1. `policy_settings`에 `verification_doc_retention_days` 키 부재 → C-2 purge_after 계산용 seed 추가 여부.
- Q2. stale-reviews owner 경고 수신자 = role='owner' 1인 고정(1인 운영). operator 포함 여부.
- Q3. operational_messages.kind는 'system' 재사용(동결 CHECK에 전용 kind 추가 회피). 적절한지.
- Q4. delete-accounts 재개(deleting) 시 prepare의 case_snapshots 재삽입 중복 가능성 → 멱등 보강 필요 여부.
- Q5. claim_accounts_for_deletion이 '자발 탈퇴 요청'을 포착 못함(members에 withdrawal 신호 부재) — v1 탈퇴 경로 설계 시 조건 추가.

## 다음
- 이 표 + `009_server_job_rpcs.sql` 초안을 GPT 배치 검수 요청.
- 검수 통과 후: Batch 1(Route·공통 보안 기반) 서버 코드 착수 → 검수 → Batch 2A/2B 잡 → Batch 3 통합.
- 009는 GPT 승인 후에만 dev 리허설·재동결. 그 전까지 원격 무접촉.
