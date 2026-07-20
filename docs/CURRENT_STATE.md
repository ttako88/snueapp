# 현재 상태 (AI 협업 진입 문서)

> 갱신: 2026-07-20 (Gate 4a DB+서버부 동결·GitHub 비운영 푸시 완료·운영배포 승인 대기).
> 새 세션/컨텍스트 압축 후: 이 문서 → [reviews/GATE4A_LEDGER.md](reviews/GATE4A_LEDGER.md) → [GPT_CLAUDE_WORKFLOW.md](GPT_CLAUDE_WORKFLOW.md) 순으로 읽고 이어서 진행.

## ★ 재개 앵커 (2026-07-20 현재)
- **동결 SHA**: Gate 4a DB(001~008) = `6746127` (dev clean replay 66/66). 서버부(009 RPC+maintenance 코드+테스트) = `cc8b43b` (dev 적용·통합 8/8·행동 6+2 PASS, 009 원문 SHA-256 `faff5f85…`).
- **GitHub**: 비운영 브랜치 `integration/gate4a-preproduction` 푸시 완료(HEAD `58f0456`). 원격 main=`cb3e7ab` 그대로. Production 무배포.
- **다음 = 사용자 최종 운영 배포 컨펌 대기.** 진행 가능(무위험): Vercel Preview 확인·UI 4기능 원격검증·배포전 체크리스트·AI playbook. BLOCKED: Route↔dev service_role HTTP E2E(안전 dev secret 준비까지).
- **운영 금지선(사용자 명시 승인 전 절대 금지)**: main 병합, Vercel Production 배포·승격, 운영 Supabase 001~009 적용, 운영 Cron/env/OAuth 활성화, 운영 service_role/env 등록, 실사용자 데이터 초기화.
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
