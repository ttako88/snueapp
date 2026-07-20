# server-jobs 초안 (서버 Cron 실행부)

> DRAFT — NOT EXECUTED. 승격 시 최종 경로: `app/api/maintenance/route.js` + `app/lib/server/jobs/*`
> 근거: GATE3_DESIGN.md v1.3 §9(서버 Cron 4종)·§13(계정 삭제 14단계)·§7(공용 Storage 삭제 모듈)

## 구조 (단일 maintenance Route + 작업 분기 — GPT 권고 "단순한 쪽" 채택)

```
POST /api/maintenance?job=<job-name>
  1) CRON_SECRET 헤더 검증 — 실패 시 아무 작업도 하지 않고 401 (no-op 보장)
  2) MAINTENANCE_ENABLED env 플래그 확인 — 미설정이면 즉시 no-op 200 (비활성 기본값)
  3) job 분기 → 작업 모듈 실행 → batch_runs 기록
```

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
- env 목록: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, MAINTENANCE_ENABLED,
  PREVIEW_IP_DAILY_CAP(기본 200), HMAC 키 3종(학번/쿠키/IP — domain separation §8) — **값은 어디에도 미기재, dev/prod 분리**

## TODO (승격 전)
- 각 모듈 실제 구현 (이 초안 단계에서는 계약만 확정 — GPT 검수 2차·3차 배치)
- delete-accounts의 DB 부분(①~⑧)은 003 후속분 SQL 함수와 역할 분담 확정
