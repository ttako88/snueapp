# 현재 상태 (AI 협업 진입 문서)

> 갱신: 2026-07-20 (Gate 2). 새 세션은 이 문서 → 필요시 감사 보고서 순서로 읽을 것.

## 문서 신뢰 우선순위

1. 실제 코드 (`app/`, `supabase/`)
2. [ARCHITECTURE_AUDIT_PHASE1.md](ARCHITECTURE_AUDIT_PHASE1.md) — 커뮤니티 전환의 **기준 문서** (Gate 1 승인, 사용자+GPT 공동검수)
3. 이 문서
4. `docs/archive/` — 역사 기록. **현재 방향과 다름** (특히 archive/RESUME_v1은 "게시판 없음"이 확정이라 적혀 있으나 폐기된 방향)

## 지금 어디까지 왔나

- **정보 축**: 완성 (급식·일정·공지·시간표·마법사·학점계산기·e-Class·캘린더). 기능적으로 베타 품질
- **커뮤니티 축**: 로그인(이메일 매직링크)+게시판 CRUD+익명 동작. 단 **회원 신원·역할·제재·신고는 미구현** — Gate 3~7에서 감사 보고서대로 구축
- **Gate 진행**: Gate 1 완료(감사 승인) → **Gate 2 완료**(dev Supabase 분리, 코드 경계, tests, 문서) → 다음 = Gate 3(서면 설계 확정: 데이터 모델·권한표·RLS·정책. 코드/DB 변경 없음)

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
