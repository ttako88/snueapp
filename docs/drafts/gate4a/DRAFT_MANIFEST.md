# Gate 4a DRAFT MANIFEST

> **DRAFT — NOT EXECUTED — NOT APPROVED FOR DEV APPLY.**
> 이 디렉터리의 모든 파일은 초안이다. 어떤 파일도 실행·적용되지 않았고, 사용자 P2(dev 리허설 착수) 승인 + GPT 검수 통과 전에는 실제 경로로 승격하지 않는다.
> 근거 설계: docs/GATE3_DESIGN.md v1.3 (dacd7a8) / 실행 계획: docs/GATE4A_PLAN.md v0.2 (bdfa218)

## 1. 초안 → 최종 배치 경로 매핑

| 초안 (이 디렉터리) | 승격 시 최종 경로 | 충족하는 GATE3_DESIGN 절 |
|---|---|---|
| migrations/001_schemas_roles.sql | supabase/migrations/001_schemas_roles.sql | §1(스키마 분리·스키마 권한), §2 공통(default privileges) |
| migrations/002_foundation.sql | supabase/migrations/002_foundation.sql | §1 표(테이블 21종), §3(members), §4.3(requests), §5(커뮤니티), §10(인덱스·CHECK), §0(시드) |
| migrations/003_functions_triggers.sql | supabase/migrations/003_functions_triggers.sql | §2 트랙 A/B, §3~§6, §8, §13 — **함수 의존 RLS 정책 포함** (아래 §4 참조) |
| migrations/004_schedules.sql | supabase/migrations/004_schedules.sql | §9 pg_cron 4종 |
| migrations/003b_functions_part2.sql | supabase/migrations/003에 병합 또는 003b 유지 (승격 시 결정) | §5.5·§6·§9·§13 |
| migrations/005_storage_policies.sql | supabase/migrations/005_storage_policies.sql | §7 Storage 정책 (r3 신설 — 적용 순서: 001~004 → provision-storage → 005) |
| scripts/provision-storage.mjs | scripts/provision-storage.mjs | §7 버킷 프로비저닝 (r3: --dry-run 기본·비교만·삭제 없음) |
| scripts/server-jobs/ | app/api/maintenance/ (또는 app/lib/server/jobs/) | §9 서버 Cron 4종, §13 파이프라인 |
| vercel.cron.example.json | (내용 확인 후 수동으로 vercel.json에 반영) | §9 — **실제 vercel.json은 수정하지 않음** |
| tests/ | scripts/gate4a-tests/ | §10 보안 테스트 |
| TEST_CONTRACT.md | (문서 유지) | §10 불변조건 → 테스트 계약 |

## 2. 미확정 값 (전부 명명된 placeholder — 실제 값 미기재)

| 이름 | 위치 | 해소 시점 |
|---|---|---|
| `TODO_STUDENT_NO_LENGTH` | 학번 정규화 규칙 (서버 코드·주석) | **사용자에게 SNUE 학번 형식 확인 후** — 신원 함수 확정·신원 테스트·운영 적용 전 필수 (P3) |
| `<DEV_PROJECT_REF>` / `<PROD_PROJECT_REF>` | scripts, env 목록 | P2 승인 후 dev부터 |
| `<CRON_SECRET_PLACEHOLDER>` | vercel.cron.example.json, server-jobs | env 설정 단계 (값은 어디에도 미기재) |
| hold retention_until | (스키마는 nullable) | Gate 7 법적 검토 — production hold 생성은 함수가 거부 |
| PREVIEW_IP_DAILY_CAP | env 목록 (기본 200) | 운영 조정값 — 진행 비차단 |
| 스케줄러 소유 역할명 | 004 주석 | Gate 4a dev에서 실측 확인 |

## 3. 실행 금지 범위 (초안 작성 중 고정 안전선 — GPT 합의)

Supabase CLI apply/reset/link 금지 / SQL 실행 금지 / Storage·Auth·Vercel API 호출 금지 / service_role 사용 금지 / 실제 .env 생성·수정 금지 / 실제 프로젝트 ID·키·학번·학생증 자료 삽입 금지 / 패키지 설치·변경 금지 / 기존 마이그레이션 이동·삭제 금지 / 앱 기존 import·runtime 경로에 초안 연결 금지 / GitHub push·외부 배포 금지. **로컬 정적 검사·문법 검토만 허용.**

## 4. 정책 배치 노트

- RLS는 002에서 전 테이블 `enable row level security`(정책 0 = 전면 거부)로 켠다. **함수에 의존하지 않는 정책**(boards anon, owners 본인 select 등)은 002에, **is_active_member() 등 함수 의존 정책**은 함수와 같은 파일인 003에 둔다 (선언 순서 의존성 제거).
- 컬럼 권한(grant/revoke)은 002에서 테이블 생성 직후 처리.

## 5. P2 승인 후 승격 순서

① GPT 배치 검수 통과 확인(001·002 → 003·004·서버 초안) → ② dev 프로젝트 ID 재확인 → ③ 초안을 최종 경로로 복사(파일 서두 DRAFT 표기 제거) → ④ GATE4A_PLAN.md 단계 A부터 실행 → ⑤ 이 디렉터리는 이력으로 보존
