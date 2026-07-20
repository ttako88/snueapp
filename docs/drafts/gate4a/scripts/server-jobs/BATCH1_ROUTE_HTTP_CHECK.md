# Batch 1 — maintenance Route HTTP 계약 확인

> route.js는 `next/server`를 import하므로 `node --test`에서 직접 로드 불가.
> Route 어댑터 계약(GET/no-store/405)은 실행 중 dev 서버에 실제 HTTP로 확인한다.
> (코어 로직·검증·lease는 mock 단위 테스트가 커버: tests/maintenance*.test.mjs)

## 확인 결과 (2026-07-20, 로컬 dev 서버 :3000, MAINTENANCE_ENABLED 미설정 = disabled)

| 요청 | 기대 | 실측 |
|---|---|---|
| `GET /api/maintenance?job=stale-reviews` | 200 + `Cache-Control: no-store` + `{"status":"disabled"}` | ✅ 일치 |
| `POST /api/maintenance?job=stale-reviews` | 405 (POST 미export → Next 기본) | ✅ 405 |
| 빌드 산출 | `/api/maintenance` = ƒ(Dynamic) | ✅ (npm run build) |

- disabled가 검증 순서상 최우선 단락이라, 미설정 환경에선 unknown job·secret 유무와 무관하게
  200 `{status:"disabled"}`를 반환한다(상태 변경·client 생성 0). 이는 의도된 fail-safe.
- unknown job → 400, secret 실패 → 401 등 나머지 분기는 MAINTENANCE_ENABLED=true 조건이 필요하며,
  실제 env 실값 없이 core 단위 테스트(mock)가 전수 커버한다(tests/maintenance.test.mjs).

## 재현
```
curl -s -i "http://localhost:3000/api/maintenance?job=stale-reviews"   # 200, no-store, disabled
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:3000/api/maintenance?job=stale-reviews"  # 405
```
