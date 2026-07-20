# server-jobs 초안 (서버 Cron 실행부)

> DRAFT — NOT EXECUTED. 승격 시 최종 경로: `app/api/maintenance/route.js` + `app/lib/server/jobs/*`
> 근거: GATE3_DESIGN.md v1.3 §9(서버 Cron 4종)·§13(계정 삭제 14단계)·§7(공용 Storage 삭제 모듈)

## 구조 (단일 maintenance Route + 작업 분기 — GPT 권고 "단순한 쪽" 채택)

### Route 계약 (r3 — GPT 3차 확정 순서: 비활성이 인증보다 우선)

```
POST /api/maintenance?job=<job-name>
  0) MAINTENANCE_ENABLED !== 'true' → 인증 성공 여부와 무관하게 상태 변경 없이 즉시 종료
     (응답 200 {status:"disabled"} — 비활성 기본값)
  1) CRON_SECRET 헤더(Authorization: Bearer) 상수시간 비교 — 실패 시 어떤 작업도 없이 401
  2) job allowlist 검사 — ['purge-verification-docs','delete-accounts','expire-uploads',
     'stale-reviews'] 외에는 400 (문자열 그대로 분기, 동적 해석 금지)
  3) 환경 확인 — SUPABASE_URL의 project ref를 EXPECTED_PROJECT_REF와 대조, 불일치 시 500 중단
  4) 해당 작업 모듈 실행 → batch_runs 기록 → 응답
```

### 응답 계약
- 200 `{status:"ok", job, processed:<n>, failedStep:null}` / 200 `{status:"disabled"}`
- 401(인증 실패, body 없음) / 400 `{status:"unknown_job"}` / 500 `{status:"error", failedStep:<이름>}` — 오류 메시지에 토큰·신원값·경로 미포함, 상세는 서버 로그(비식별)만

### 작업별 상태 전이·재시도·멱등성 표 (r3)

| job | 상태 전이 | 재시도 | 멱등성 근거 |
|---|---|---|---|
| purge-verification-docs | purge_after 경과 → purge_started_at 기록 → Storage remove → **성공 확인 후** storage_path·real_name null + purged_at | 실패 시 attempts+1·last_error, 다음 실행에서 재시도. "파일 이미 없음"=성공 수렴 | purged_at null 조건으로만 선별 — 재실행 시 완료분 스킵 |
| delete-accounts | §13 14단계: deleting 전이→hold/snapshot→detach→Storage→Auth Admin→확인 | **연결 제거 실패 시 Auth 삭제 진행 금지** — 실패 단계 기록 후 다음 실행에서 그 단계부터 | 각 단계가 조건부(이미 처리된 행은 no-op). deleting 상태로 재선별 |
| expire-uploads | uploading+24h 경과 → upload_expired + 미완 객체 remove | Storage 실패 시 상태 전이는 유지, 객체 정리만 재시도 | status 조건 선별 |
| stale-reviews | submitted 3/7일 → owner 경고 메시지(중복 발송 방지 기록) / 30일 → expired_unreviewed+pending 복귀+파기 대기열+사과 메시지 | 실패 시 다음 실행 재처리 | 전이는 상태 조건부, 메시지는 발송 기록 대조 |

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
- env 이름 목록 (값·프로젝트 ID·secret은 어디에도 미기재, dev/prod 분리 — r3 F항):
  `SUPABASE_URL` `SUPABASE_SERVICE_ROLE_KEY` `CRON_SECRET` `MAINTENANCE_ENABLED`
  `EXPECTED_PROJECT_REF_DEV` `EXPECTED_PROJECT_REF_PROD` `PREVIEW_IP_DAILY_CAP`
  `STUDENT_NO_HMAC_KEY_V1` `PREVIEW_COOKIE_SIGN_KEY` `PREVIEW_IP_HMAC_KEY` (domain separation §8)
  `NEXT_PUBLIC_SUPABASE_URL` `NEXT_PUBLIC_SUPABASE_ANON_KEY` (기존)

## TODO (승격 전)
- 각 모듈 실제 구현 (이 초안 단계에서는 계약만 확정 — GPT 검수 2차·3차 배치)
- delete-accounts의 DB 부분(①~⑧)은 003 후속분 SQL 함수와 역할 분담 확정
