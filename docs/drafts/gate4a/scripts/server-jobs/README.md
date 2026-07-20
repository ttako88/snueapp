# server-jobs 초안 (서버 Cron 실행부)

> DRAFT — NOT EXECUTED. 승격 시 최종 경로: `app/api/maintenance/route.js` + `app/lib/server/jobs/*`
> 근거: GATE3_DESIGN.md v1.3 §9(서버 Cron 4종)·§13(계정 삭제 14단계)·§7(공용 Storage 삭제 모듈)

## 구조 (단일 maintenance Route + 작업 분기 — GPT 권고 "단순한 쪽" 채택)

### Route 계약 (r4 — GPT 3차 확정: GET + lease)

**GET** `/api/maintenance?job=<job-name>` — Vercel Cron은 GET으로 호출 (POST 전용이면 운영에서 405 실패).
`export async function GET`, POST는 405 거부. `export const dynamic='force-dynamic'`,
`export const runtime='nodejs'`, 응답 `Cache-Control: no-store`. User-Agent·x-vercel-cron-schedule은
관찰값일 뿐 인증 근거 아님.

```
  0) MAINTENANCE_ENABLED !== 'true' → 인증과 무관하게 상태 변경 없이 200 {status:"disabled"}
  1) CRON_SECRET 검증 — Vercel이 Authorization: Bearer <secret>으로 자동 전송. 상수시간 비교.
     secret이 미설정·16자 미만이면 maintenance 자체를 실행하지 않음 (r4). 실패 시 무작업 401
  2) job allowlist 4종 외 400 (문자열 상수 분기, 동적 해석 금지)
  3) 환경 확인 — APP_ENV(dev|prod, 그 외 무조건 중단)에 따라 EXPECTED_PROJECT_REF_DEV/PROD 중
     하나를 선택해 SUPABASE_URL의 ref와 대조, 불일치 500
  4) lease 획득 (r4 — 중복 실행 방지): private.maintenance_leases(job_name PK, lease_token,
     leased_until, started_at). service_role 전용 public 래퍼로 원자적 acquire/release.
     유효한 lease 존재 시 상태 변경 없이 200 {status:"already_running"}.
     release는 자기 lease_token 일치 시만, 서버 중단 시 leased_until 경과 후 다음 실행이 회수.
     인메모리 잠금 금지(서버리스 인스턴스 간 비공유). 멱등성은 lease와 별개로 유지.
  5) 작업 모듈 실행 → batch_runs 기록 → lease release → 응답
```

### 응답 계약
- 200 `{status:"ok", job, processed:<n>, failedStep:null}` / 200 `{status:"disabled"}` / 200 `{status:"already_running"}`
- 405(POST) / 401(인증 실패, body 없음) / 400 `{status:"unknown_job"}` / 500 `{status:"error", failedStep:<이름>}` — 오류에 토큰·신원값·경로 미포함, 상세는 서버 로그(비식별)만

### 작업별 상태 전이·재시도·멱등성 표 (r3)

| job | 상태 전이 | 재시도 | 멱등성 근거 |
|---|---|---|---|
| purge-verification-docs | purge_after 경과 → purge_started_at 기록 → Storage remove → **성공 확인 후** storage_path·real_name null + purged_at | 실패 시 attempts+1·last_error, 다음 실행에서 재시도. "파일 이미 없음"=성공 수렴 | purged_at null 조건으로만 선별 — 재실행 시 완료분 스킵 |
| delete-accounts | §13 14단계: deleting 전이→hold/snapshot→detach→Storage→Auth Admin→확인 | **연결 제거 실패 시 Auth 삭제 진행 금지** — 실패 단계 기록 후 다음 실행에서 그 단계부터 | 각 단계가 조건부(이미 처리된 행은 no-op). deleting 상태로 재선별 |
| expire-uploads | ①uploading+24h → upload_expired 전이(finalize 차단) ②객체 remove | Storage 실패 시 전이 유지, **다음 실행이 `upload_expired AND purged_at IS NULL`도 재선별**해 정리 재시도. 파일 없음=성공 수렴 (r4) | status+purged_at 조건 선별 |
| stale-reviews | 3/7일 경고·지연 안내: verification_requests의 **owner_warned_3_at·owner_warned_7_at·user_delay_notified_at** 컬럼으로 발송 여부 판정(단순 메시지 조회 금지), 상태 확인+메시지 삽입+시각 기록을 한 트랜잭션 (r4) / 30일: expired_unreviewed·pending 복귀·deadline+7d·사과 메시지·purge_after 설정을 한 트랜잭션, Storage 삭제는 purge 작업이 담당 | 실패 시 다음 실행 재처리 | 발송 시각 컬럼 대조 |

- 공통 (r4): 각 작업은 페이지네이션·배치 상한·실행시간 예산을 두어 한 계정/파일의 실패가 전체 배치를 영구 정지시키지 않게 한다

| job | 모듈 | 요지 |
|---|---|---|
| purge-verification-docs | jobs/purgeVerificationDocs.mjs | purge_after 경과 요청 조회 → 공용 storageRemove로 원본 삭제 → **성공 확인 후** path·real_name null (50파일+페이지네이션, attempts·last_error) |
| delete-accounts | jobs/deleteAccounts.mjs | §13 14단계 파이프라인 (deadline 경과 미인증 + 탈퇴 요청 계정. hold·snapshot이 cascade 선행, 연결 제거 실패 시 Auth 삭제 금지·해당 단계부터 재시도, 20계정/회) |
| expire-uploads | jobs/expireUploads.mjs | uploading 24h 경과 → upload_expired 전이 + 미완 객체 정리 |
| stale-reviews | jobs/staleReviews.mjs | 3/7일 owner 경고 메시지, 30일 expired_unreviewed 전환+파기 대기열(사과·재제출 안내 운영 메시지) |

## 공용 모듈
- `lib/storageRemove.mjs` — Storage API remove() + 성공 확인 + "파일 이미 없음=성공 수렴" (§4.4 공통)
- `lib/serviceClient.mjs` — service_role 클라이언트 (서버 전용. 사용자 세션 클라이언트와 분리 — §2 트랙 B)
- `lib/batchRuns.mjs` — 실행 기록(마지막 성공 시각·처리 수·실패 단계·재시도), 3연속 실패 시 owner 운영 메시지

## 안전장치 (GPT 합의)
- 비활성 기본값: `MAINTENANCE_ENABLED` 미설정 시 모든 job이 no-op — DB 준비+smoke 통과 후에만 활성화
- 인증 실패 시 no-op / 모든 job idempotent / 로그에 토큰·학번·신원값·실명 금지 (비식별 참조만)
- env 이름 목록 (값·프로젝트 ID·secret은 어디에도 미기재, dev/prod 분리 — r4):
  `APP_ENV`(dev|prod — 그 외 값이면 무조건 중단) `SUPABASE_URL` `SUPABASE_SERVICE_ROLE_KEY`
  `CRON_SECRET`(16자 이상 강제) `MAINTENANCE_ENABLED` `EXPECTED_PROJECT_REF_DEV` `EXPECTED_PROJECT_REF_PROD`
  `PREVIEW_IP_DAILY_CAP` `STUDENT_NO_HMAC_CURRENT_VERSION` `STUDENT_NO_HMAC_KEY_V1`
  `PREVIEW_COOKIE_SIGN_KEY` `PREVIEW_IP_HMAC_KEY` (domain separation §8)
  `NEXT_PUBLIC_SUPABASE_URL` `NEXT_PUBLIC_SUPABASE_ANON_KEY` (기존)
- HMAC 키 버전 규칙 (r4): 키 이름은 `STUDENT_NO_HMAC_KEY_V<n>`, 현재 버전은
  `STUDENT_NO_HMAC_CURRENT_VERSION=<n>`. 교체 시 V2 키 추가+CURRENT_VERSION만 올리고,
  과거 버전 데이터가 남아있는 동안 과거 키를 유지 (GATE3 §4.2)

## TODO (승격 전)
- 각 모듈 실제 구현 (이 초안 단계에서는 계약만 확정 — GPT 검수 2차·3차 배치)
- delete-accounts의 DB 부분(①~⑧)은 003 후속분 SQL 함수와 역할 분담 확정
