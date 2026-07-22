<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

# 프로젝트 현재 상태

> ⛔ **아무 작업/추론 전에 반드시 먼저 읽어라. 컴팩(요약) 직후일 가능성이 높다.** ⛔
> 1. **`docs/SESSION_HANDOFF_2026-07-22.md`** — 현재 상태·진행 중인 일·다음 착수의 진입점.
> 2. **`docs/COLLAB_STATE.md`** — 무엇이 어떤 상태인가의 **원본**. 기억·요약과 어긋나면 이게 이긴다.
> 3. 메모리(`MEMORY.md`)도 매 세션 로드됨 — 소유자 성향·학번 구조·확정 정책이 거기 있다.
>
> **현재(2026-07-22): 마이그레이션 A~F(015~023) 전부 운영 적용됨·flag 3개 OFF·로그인 개방됨.**
> **다음 착수 = 분석·수익화(광고) 기능** — 설계 `docs/ANALYTICS_DESIGN_DRAFT_2026-07-22.md`,
> GPT판정 `docs/reviews/GPT_VERDICT_ANALYTICS_2026-07-22.md`, goal 지시서 `docs/ANALYTICS_GOAL_2026-07-22.md`.
> ⚠️ "파일이 migrations/에 있음 ≠ DB 적용" — 적용 여부는 운영 DB 실측이 근거(재적용 사고 주의).

세부: `docs/CURRENT_STATE.md`(Gate·코드경계·운영/개발 Supabase), 커뮤니티 전환 기준
`docs/ARCHITECTURE_AUDIT_PHASE1.md`(승인본).

**지금 무엇이 어떤 상태인지는 `docs/COLLAB_STATE.md`가 원본이다.** 동결된 데이터,
승인 대기 항목, 미해결 결함이 근거 종류와 함께 적혀 있다. 여기 적힌 것과
어긋나는 기억·요약을 근거로 실행하지 않는다.

# 작업 규율 (docs/COLLAB_PROTOCOL.md 요약)

전문은 `docs/COLLAB_PROTOCOL.md`. 아래는 실행 직전에 걸리는 것만.

- **"완료"라고 쓰지 않는다.** `CODE_WRITTEN` / `LOCAL_VERIFIED` / `PROD_VERIFIED` /
  `USER_REACHABLE` 중 하나로 적는다. 테스트 PASS·빌드 PASS는 완료가 아니라 증거다.
  feature flag가 OFF면 `USER_REACHABLE`이 아니다.
- **물어볼 수 있는 것을 추론하지 않는다.** 권한은 `has_function_privilege`로 묻는다
  (ACL 문자열 수동 파싱 금지 — 이 프로젝트에서 3회 틀렸다). `count(*)`는 문자열로
  오므로 `Number()`. 산술은 코드로.
- **실패를 조용히 삼키는 방어 금지.** 파싱 실패를 빈 배열·0건·기본값으로 대체하지
  않는다. 명시적 오류나 UNKNOWN으로 판정을 중단한다.
- **운영 mutation·flag 활성화·시크릿·삭제(L3)는 사전 승인.** 가역성은 실행 *전에*
  증명한다. "알아서 해"는 판단 위임이지 승인 면제가 아니다 — L3를 만나면 pending으로
  걸고 다른 일을 한다.
- **새 도구는 안전한 기본값으로.** dry-run이 기본, 실제 적용은 `--apply`.
  읽기 전용 도구는 `begin read only`로 감싼다. 시크릿을 다루면 TTY 전용.
- **범위를 넘었으면 즉시 자진신고.** 복구·삭제도 새로운 mutation이므로 소유자
  결정 전에 실행하지 않는다.
<!-- END:nextjs-agent-rules -->
