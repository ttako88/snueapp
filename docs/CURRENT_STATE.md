# 현재 상태 (AI 협업 진입 문서)

> 갱신: 2026-07-20 (Gate 4a DB+서버부 동결 · **운영 CODE 배포 완료(코드-only)** · 파괴적 DB 재기반은 Gate 4b+로 연기).
> 새 세션/컨텍스트 압축 후: 이 문서 → [reviews/GATE4A_LEDGER.md](reviews/GATE4A_LEDGER.md) → [GPT_CLAUDE_WORKFLOW.md](GPT_CLAUDE_WORKFLOW.md) 순으로 읽고 이어서 진행.

## ★ 재개 앵커 (2026-07-20 현재)
- **동결 SHA**: Gate 4a DB(001~008) = `6746127` (dev clean replay 66/66). 서버부(009 RPC+maintenance 코드+테스트) = `cc8b43b` (dev 적용·통합 8/8·행동 6+2 PASS, 009 원문 SHA-256 `faff5f85…`).
- **GitHub/운영 배포**: `origin/main` = `1d5def9` (코드-only). 이력: cb3e7ab→812fe5e(기능4개)→a6f0c33(문서)→**1d5def9(UI hotfix c5dccd7: 교양 목록 성격별 분리·택1 낱개·dept 정규화, 사용자 "GO-DEPLOY-UI-HOTFIX" 승인)**. 라이브 스모크 통과(영어과 2학년 2026-1 교양 핵심/중점/자율 노출, 콘솔 0). `integration/gate4a-preproduction` = `40f7210`. 커뮤니티 백엔드는 여전히 **잠자는 코드**(MAINTENANCE_ENABLED 미설정→disabled, prod에 vercel.json 미배포→cron 미호출, prod DB 무접촉).
- **상태 문구(GPT 확정)**: "Phase 5a — 코드/UI 선행 배포 완료. Production DB 전환·Maintenance 활성화는 미실행." 라이브 비파괴 확인: `GET /api/maintenance?job=stale-reviews` = `200 {"status":"disabled"}` (secret 없이, 변경 0).
- **다음 = GPT 런북 P0-1~P0-9 해소 (integration 브랜치, Production 무접촉).** ✅완료: P0-1·P0-2·P0-3·P0-4·P0-5·P0-6·P0-9. **P0-6 dev clean replay 완주**(RC후보 `c227001`): dev(uiikgqeoxocpvphlmoqp)에 node-pg 실행기(`scripts/manual/apply-sql-dev.mjs`, DEV_DB_URL은 .env.dev.local·값 비출력)로 reset→활성 001~009→fixture→테스트 61/61+80behavior→bootstrap 12/12 전부 PASS. reset 지문 불변·rls_auto_enable 보존. 실측결함 3건 수정(reset char캐스트·authz._log allowlist·fixture uuid::text). reset 파일 SHA-256 `4b0ab5d8…`. **RC 동결 전 GPT REQUIRED R1~R4 완료**(RC후보 `d1d0f77`): R1 CC 5건 추가→dev 실측 66/66 PASS(90_comment_count.sql) / R2 실제 2세션 동시성 실측 PASS(boot-concurrency-dev.mjs, owner=1) / R3 rls_auto_enable OID·def_md5·ACL 불변 증명 / R4 apply-sql-dev 하드닝(URL 구조검증·기본 행 비출력·.sql한정·pg devDep). **R1/R2 하드닝 완료**(GPT 재검수): CC 재실행성·CC-3 예외폐기·동시성 finally. **P0-7 완료**(RC후보 `2b05bbf`): maintenance-e2e-dev.mjs로 Route↔dev HTTP E2E 13/13 PASS(disabled/401/400/500/4job실호출/already_running/batch_runs/비식별/lease잔존0, delete-accounts failed=1=§13 안전게이트). dev env는 .env.dev.local의 SUPABASE_SECRET_KEY+DEV_DB_URL만 참조·비출력. 🔲남음: **P0-8(Vercel Preview env=dev 연결·4기능+`/api/maintenance` disabled smoke — 대시보드, 사용자와 함께)** → 그 후 새 RC 최종 동결(GPT E섹션 10조건: DB66/66·009행동·bootstrap동시성·rls불변·mock76·RouteE2E·npm test·build·Preview smoke·secret0·integration만). **P0 완료 전 main 재병합 금지(GPT).** 이후 운영 수렴은 GPT 런북 A~Q, 각 파괴 단계 지정 문구(BACKUP-OK / GO-RESET-PROD / GO-DEPLOY-RC / OWNER-BOOTSTRAP-OK / GO-ENABLE-PROD-CRON)로만.
  - dev 실행기 사용법: `node scripts/manual/apply-sql-dev.mjs <sql파일…>` 또는 `--preflight`. DEV_DB_URL은 git 미추적 `.env.dev.local`에만.
- **운영 금지선(사용자 명시 승인 전 절대 금지, 여전히 유효)**: 운영 Supabase 001~009 적용(파괴적 재기반), 운영 계정/데이터 삭제, 운영 Cron/env/OAuth 활성화, 운영 service_role/CRON_SECRET 등록, 재가입·owner 부팅(실명·학번). — **코드 배포는 이번에 완료됐고, 위 파괴적/비밀 단계만 남음.**
- 협업 규약·안전규칙 상세: [GPT_CLAUDE_WORKFLOW.md](GPT_CLAUDE_WORKFLOW.md).

## 문서 신뢰 우선순위

1. 실제 코드 (`app/`, `supabase/`)
2. [ARCHITECTURE_AUDIT_PHASE1.md](ARCHITECTURE_AUDIT_PHASE1.md) — 커뮤니티 전환의 **기준 문서** (Gate 1 승인, 사용자+GPT 공동검수)
3. 이 문서
4. `docs/archive/` — 역사 기록. **현재 방향과 다름** (특히 archive/RESUME_v1은 "게시판 없음"이 확정이라 적혀 있으나 폐기된 방향)

## 지금 어디까지 왔나

- **정보 축**: 완성 (급식·일정·공지·시간표·마법사·학점계산기·e-Class·캘린더). 기능적으로 베타 품질
- **커뮤니티 축**: 로그인(이메일 매직링크)+게시판 CRUD+익명 동작. 단 **회원 신원·역할·제재·신고는 미구현** — Gate 3~7에서 감사 보고서대로 구축
- **Gate 진행**: Gate 1 완료 → Gate 2 완료 → **Gate 3 완료** ([GATE3_DESIGN.md](GATE3_DESIGN.md) v1.3, GPT 공동검수 승인·커밋 dacd7ab) → **Gate 4a 준비 완료·실행 대기**:
  - [GATE4A_PLAN.md](GATE4A_PLAN.md) v0.2 — GPT 승인, "계획 승인 · 실행 승인 대기"
  - `docs/drafts/gate4a/` — 마이그레이션 001~005·스크립트·테스트 계약(65케이스) **초안** (GPT 3배치 검수 반영. NOT EXECUTED — 실행·승격은 사용자 P2 승인 후)
  - 야간 자율 협업 기록: [reviews/OVERNIGHT_LOG_2026-07-20.md](reviews/OVERNIGHT_LOG_2026-07-20.md)
  - **사용자 대기 항목**: ①SNUE 학번 형식 확인(P3) ②dev 리허설 착수 승인(P2)

## 코드 경계 (Gate 2 확립)

```
app/api/*            서버 프록시 — 학교 공개 데이터 (비회원 미리보기도 Gate 5에서 여기 패턴)
app/lib/supabase/    client.js(브라우저) · server.js(뼈대, Gate 5에서 service_role)
app/lib/community/   게시판 데이터 접근 — 화면은 Supabase 쿼리 직접 금지, 여기만 호출
app/lib/identity/    useAuth 훅 (상태 판정 추가는 Gate 4a 이후)
app/lib/policy/      권한 UX 미러 — ⚠️ 보안 최종 기준은 DB RLS이며 이 파일이 아님
app/lib/*.js         정보 축 (timetable, wizard 등 — 커뮤니티 전환과 무관)
tests/               node --test. `npm test`
```

## Supabase 프로젝트 2개

| | ref | 용도 |
|---|---|---|
| **운영** | `jclwkvxbvsegmbcnptpi` | snueapp.vercel.app이 사용. **실험 금지** |
| **dev** | `uiikgqeoxocpvphlmoqp` | 마이그레이션 리허설·실험용. 실제 학생증 자료 금지 |

env 전환 절차: [OPERATIONS.md](OPERATIONS.md). dev 값은 `.env.dev.local`(git 미추적)에 보관.

## 절대 규칙

- `supabase/schema.sql` 운영 재실행 금지 (전체 삭제됨) — 변경은 `migrations/00N_*.sql`로만
- 운영 DB 초기화는 Gate 4a에서, 감사 보고서 12.10 안전 절차(14단계)로만
- secret 키(sb_secret_)·service_role은 서버 env 전용 — NEXT_PUBLIC/채팅/커밋 금지
- 각 Gate는 사용자(+GPT 공동검수) 승인 후 진행
