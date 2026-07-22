# 세션 인수인계 — 2026-07-22 (컴팩 직전 갱신)

> **다음 세션이 이 파일을 제일 먼저 읽는다.** (AGENTS.md → CLAUDE.md 로 매 세션 자동
> 로드되며 이 파일을 최우선으로 가리킨다.) 대화가 길어져 컴팩(요약)하고 넘어온다.
> **컴팩으로 잃으면 안 되는 것이 여기 다 있다.** 요약·기억이 이 파일 또는
> `COLLAB_STATE.md` 와 어긋나면 **문서가 이긴다.** "파일이 migrations/에 있음 ≠ DB 적용";
> 적용 여부는 **운영 DB 실측**이 근거.

## 0. 지금 무슨 일이 진행 중인가 (한 줄)
goal 실행으로 **A~F(마이그레이션 015·016·019·020·021·022·023) 전부 운영 적용 완료,
flag 3개 전부 OFF, 로그인 개방됨.** 지금은 **분석·수익화(광고) 기능**을 설계 확정하고
**컴팩 후 goal 로 구현 착수** 대기 중. 소유자가 컴팩 후 goal 지시서(§5)를 붙여넣는다.

## 1. 운영 실제 상태 (2026-07-22 실측)
- 운영 DB: **015·016·019·020·021·022·023 전부 적용됨.** 데이터 무결(posts 1·members 1·
  auth.users 1·storage.objects 2). 배포 SHA `9fa001d → e6923dc → 7ae9501 → 153bf99`.
  롤백 기준 origin/main = `9fa001d`.
- **flag 3개 전부 OFF** (`app/lib/features.js`): courseReview / aiCreditCharge /
  practicumPlacement. 각 활성화는 선행조건 필요(아래 §3).
- **로그인 개방됨**(015 + OPEN_SIGNUP=true). 누구나 가입, 단 게시·운영 기능은 **인증(verified)**
  필요(is_active/writable_member 가 verified 하드요구 — 미인증 계정 능력 0).
- **AI 키**: 소유자가 Vercel 에 `GEMINI_API_KEY` 등록 + 재배포 완료. 라이브 AI **생성 테스트만
  남음**(소유자가 라이브에서 지도안 1건 눌러보면 확정, 약 ₩22). 개인별 SR 차감(aiCreditCharge)은
  여전히 OFF — durable 상태기계 후.
- 상세: `GOAL_MODE_WORKORDER_2026-07-22.md` §9 진행원장(상태 원본) + `GOAL_RUN_REPORT_2026-07-22.md`.

## 2. ★ 지금 착수할 것 — 분석·수익화(광고) 기능 (소유자 지시)
- **설계 확정본**: `docs/ANALYTICS_DESIGN_DRAFT_2026-07-22.md` (읽어라).
- **GPT 검수 판정**: `docs/reviews/GPT_VERDICT_ANALYTICS_2026-07-22.md` — DESIGN_DIRECTION=APPROVED,
  **범위축소 NO**(소유자가 범위 좁히기 싫어함), LEGALIZATION_REFACTOR=YES.
- **학번 구조·학과코드표**: 메모리 `snue-hakbeon-structure.md`(컴팩에도 안 지워짐, 매 세션 로드).
  8자리=[입학년도4][학과코드2][ㄱㄴㄷ순번2], 14=영어. 학번만 받으면 학년·학과 도출.
- **핵심 결정**:
  1. 데이터 3층 분리 + flag: `hakbeonAutofill`(편의) / `productAnalytics`(대시보드, **사업자 불요**) /
     **`targetedAds`(광고, 전부 구현하되 OFF 휴면 → 사업자등록 시 켬 — 소유자 지시)**.
  2. **학번은 "학생 인증 단계"에서만 수집**(로그인 개방됐으니 전원 가입 시 X). 학번→입학학과·
     예상학년(사용자가 현재학년 확정)·**권장 시간표 초안**.
  3. 동의 = 약관형 기본 OFF 독립 2칸(상세통계/맞춤광고), 거부해도 일반광고. **맞춤광고 18세+.**
  4. 이벤트 = registry(허용 이벤트만)·pseudonymous·k-익명(대시보드5·광고20·광고주10). 구글·광고주엔
     개인정보 미전송·집계만. GA는 익명 방문만.
  5. 구현 순서: ①`app/lib/hakbeon.js`+인증단계 수집 → ②동의3층+`/api/track`+usage_events →
     ③`/admin/analytics` 대시보드(여기까지 productAnalytics 로 활성) → ④광고 전부 구현 후 targetedAds OFF.
  - 각 단계 **GPT 검수(적용 전)** → 적용/배포. 브라우저 seed 탭이 GPT 협업창.

## 3. flag 3개 활성화의 선행작업 (소유자 "진행시켜" 승인 — 새 기능, 별도 트랙)
- courseReview 켜기 ← **스냅샷 공개**(실시간 통계 차분공격 차단).
- aiCreditCharge 켜기 ← **durable 상태기계**(CHARGED/GENERATING/DELIVERABLE_COMMITTED/REFUNDED,
  timeout 시 SR 영구차감 방지) + AI 키(등록됨).
- practicumPlacement(게시) 켜기 ← **원자적 게시 게이트 + 게시판층 제한**(레이트리밋·냉각).

## 4. 소유자 손이 필요 / 미실증 (held)
- AI 라이브 생성 1건 테스트(소유자, 라이브 로그인). F 로그인 controlled E2E(실계정 제출→승인 1회).
- 020 동시성 라이브 재현·016 통계 출력 = 합성데이터 필요(N3/flag OFF)라 이연. v3 A/B = 유료 승인.
- **시크릿 값 입력·Vercel env·auth.users 변경은 내가 못 함**(소유자만).

## 5. 절대 규칙 (여전히 유효)
- 운영 mutation·flag 활성화·시크릿·삭제(L3/N3)는 사전 승인. 적용은 한 번에 하나(prod-apply-migration).
- GPT 검수는 적용 *전*. 완료 어휘 금지(CODE_WRITTEN/LOCAL_VERIFIED/PROD_VERIFIED/USER_REACHABLE).
- **채팅·로그·git·파일에 절대 안 넣음**: 커넥션문자열·키·JWT·**실명·학번·학번HMAC**·개인이메일·게시글본문·auth user id. (소유자 개인 학번·실명도 파일 금지 — 형식·코드표만.)
- 규율 전문 `COLLAB_PROTOCOL.md`, 협업규약·시효주의 메모리 `snue-drive-collab-folder`.

## 6. 컴팩 후 붙여넣을 goal 지시서
→ `docs/ANALYTICS_GOAL_2026-07-22.md` 에 있다. 소유자가 그걸 `/goal` 로 넣고 시작한다.

---
*갱신: 2026-07-22 컴팩 직전. 이전 야간작업 인수인계는 이 문서로 대체됨. 현재 상태 원본은 COLLAB_STATE.md + WORKORDER §9.*
