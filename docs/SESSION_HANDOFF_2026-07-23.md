# 🔴 세션 인수인계 + 작업지시서 (2026-07-23) — 새 채팅창은 이걸 제일 먼저 읽어라

> 이전 세션이 매우 길어져 새 채팅으로 넘어옴. **이 문서 하나로 "무엇이 라이브고·무엇이 남았고·무엇부터 어떻게"** 를
> 다 담았다. 요약·기억이 이 문서 또는 `docs/COLLAB_STATE.md` 와 어긋나면 **문서가 이긴다.**
> ⚠️ "파일이 있음 ≠ 배포/적용됨" — 라이브 여부는 **운영 실측**(배포 SHA·flag·DB)이 근거.

---

## 0. 시작 전 5분 오리엔테이션 (반드시 이 순서)
1. **이 문서 전체**
2. 메모리(자동로드): `snue-state-2026-07-22-compact`(현 상태) · `snue-practicum-structure`(교육실습 구조) ·
   `snue-practicum-advisor-initiative`(이니셔티브·순서) · `snue-hakbeon-structure` · `owner-wants-autonomous-shipping` ·
   `speech-style-jondaemal`(존댓말) · `completion-vocabulary` · `claim-evidence-discipline`
3. **`snue-app/docs/BACKLOG_남은목록.md`** — 도입 아이디어 전부(0착수~8인프라). 새 아이디어는 여기 추가.
4. `docs/COLLAB_STATE.md`(상태 원본) · `docs/COLLAB_PROTOCOL.md`(규율)

**소유자 = 조상호(존댓말). 바지사장 모델**: 가역적인 건 자율로 만들어 붙이고 보고. 되돌리기만 되면 됨.
멈춰서 계속 묻지 말 것(autonomy-dont-stall). 단, 시크릿·비가역·인증경계는 소유자.

---

## 1. 지금 라이브 상태 (2026-07-23 실측 기준)
- **프로덕션 배포** = 커밋 `276eebe` 계열(그 뒤 GPT 지도안 데이터 커밋 가능성 — `git log` 확인). 롤백기준 `153bf99`.
- **배포 방법** = ⚠️ Vercel GitHub 웹훅이 push→build 자동으로 **안 뜬다**. **Deploy Hook `claude-main-deploy`** 를
  POST해야 배포됨: Vercel 대시보드 Settings→Git 에서 훅 URL 찾아 `fetch(url,{method:'POST'})`. Pro 플랜(빌드한도 OK).
- **가입메일/로그인 = 해결.** 도메인 `snueapp.com`(가비아) 구매·DNS(DKIM/SPF/DMARC) 등록·**Resend 인증 완료**,
  Supabase 커스텀 SMTP 저장(발신 no-reply@snueapp.com). 로그인=이메일 **매직링크**. 친구가 실제 가입·인증신청 성공(실증).
- **지도안 마법사 = 라이브.** 폼렌더·PDF/한글 내보내기·약안→세안·**owner 전용 생성게이트**(lessonPlanPublic OFF라 지금은
  owner만)·관리자 콘솔(/admin, /admin/verification, /admin/analytics). planType 버그·단원 토글 버그 수정 배포됨.
- **분석·수익화 S1~S6 + migration 024~027 = prod 적용됨**(테이블 39→51·함수 134→152, 데이터 불변). **전부 flag OFF 휴면.**
- **flag 상태(app/lib/features.js) 전부 OFF**: courseReview · aiCreditCharge · practicumPlacement · hakbeonAutofill ·
  productAnalytics · targetedAds · lessonPlanPublic · socialLogin. (DB fence app_flags.targeted_ads=false)

---

## 2. 즉시 대기 (첫 세션에서 확인/처리)
- 🔲 **가입 임시차단** — 소유자 지시로 "잠시 회원가입 막기". **Supabase Auth→Sign In/Providers→User Signups→
  "Allow new users to sign up" 토글 OFF→Save**. ⚠️ 이 컨트롤드 스위치는 **자동클릭(좌표/ref/JS/포인터)이 다 안 먹혔다** →
  소유자가 직접 클릭하거나, 새 세션에서 재시도. (앱코드로도 가능하나 배포 시 GPT WIP 딸려가 위험.)
- 🔲 **실습학교 목록 정정** — 아래 §3 첫 작업. 원본 확보됨.

---

## 3. ⚑ 작업 순서 (소유자 확정 2026-07-22: **#3 먼저 → #0**, 전부 GPT검수·flag OFF·롤백)

### 3.0 (공유 기반, 제일 먼저) 실습학교 목록/catalog + 업로드 파이프라인
- **왜 먼저**: #3의 practicumPlacement(school catalog)와 #0(도우미 학교목록)이 **같은 데이터**.
- **현 문제**: `app/data/practicumSchools.json` 이 HWP 최소파서(`scripts/manual/parse-hwp-schools.mjs`)로 추출돼 불완전
  (verified:false, **신용산초 누락**, 관찰6·종합13 요약과 목록수 불일치, "강남서초" 지역명을 학교로 오인한 전례).
- **원본 확보(소유자 제공, ~/Downloads)**: 학기별 "교육실습 협력학교 실습생 배정현황" — 2025-1(이미지)·
  `2025-2학기 교육실습 협력학교 실습생 배정현황(20250908).pdf` · `교육실습 협력학교 배정 현황표.pdf`(2026-1).
  표 = `실습종류(관찰/참가/수업/운영/종합) × 지역(11) × 학교 × 학급수 × 배정인원(A/B군)`.
- **할 것**:
  1. 이 배정현황표 파싱 → 학기·실습종류·지역·학교·학급수·배정인원 구조화(검수 미리보기 포함, 자동추출 그대로 믿지 말 것).
  2. **DB school_catalog**(private, 학기별 active) 스키마 = practicumPlacement 게시게이트가 자유입력 대신 canonical school_id 쓰게.
  3. **재사용 업로드기**(관리자 /admin 전용): 파일 업로드→파싱→검수→확정 반영, 이전버전 보존(롤백). 시간표 업로드기로도 확장.
- 상세·구조는 memory `snue-practicum-structure`.

### 3.1 #3 커뮤니티 flag 활성화 (코드는 있음, 선행 안전작업 필요)
> 이 셋은 코드/migration은 있으나 **켜기 전 하드닝**이 있어야 안전(각 실패모드가 큼).
- **practicumPlacement(실습배정 게시)** ← GPT 019 검수 MUSTs 반영 필요:
  자유입력 school_short → **canonical school_id + 학기별 active catalog 검증**(§3.0) / `can_post_practicum` 의
  locked_at **부작용 제거**(STABLE 읽기전용化) → **원자적 게시게이트**(게시물 writer가 한 트랜잭션에서 배정행 FOR UPDATE
  →학기·학교 일치→insert→locked_at) / set_practicum_placement 현재학기만·과거 읽기전용·DB single current-semester /
  학교별 count는 **k=3** 이상만. (GPT 판정: placement UI는 MUST 후 flag ON 가능, **게시 활성화는 원자게이트 전 금지**.)
- **aiCreditCharge(지도안 SR 차감)** ← **durable 상태기계**(CHARGED/GENERATING/DELIVERABLE_COMMITTED/REFUNDED,
  timeout·실패 시 **SR 영구차감 방지**). 022(currency_split)·023(ai_credit_charge) migration 적용됨. flag OFF면 개인제한 없음.
- **courseReview(강의평가)** ← **스냅샷 공개**(실시간 통계 차분공격 차단) + **과목 마스터 적재**(private.course_review_subjects 비면 대상 0).

### 3.2 #0 실습학교 지망 도우미 (flag `practicumSchoolAdvisor`)
- 지도 API(카카오/네이버 — **키=소유자 등록 시크릿**) geocoding+거리. 실습학교를 **거리·위치**로 최적 나열해 지망순위 도움.
- **반드시 반영**: 배정원칙(이미 다녀온 학교 뒤로) · 배정인원 대비 지망자=경쟁률(추첨 확률) · 지역 · 실습종류/학년별 후보 다름.
- client+정적데이터+지도API, DB 최소 → 롤백 쉬움.

### 3.3 SR 시스템 전체 도입 (소유자 "싹 다")
- 잔액 원장(022 토대) + 차감 durable 상태기계(§3.1 aiCreditCharge와 동일) + **적립원천**(강의평 작성·Google Rewarded Ads) +
  소모(지도안·자료열람) + UI(잔액·내역). 광고=S6(targetedAds, 사업자등록 후). SR은 **현금화·양도불가** 유지.

### 3.4 나머지 (BACKLOG 참조)
분석 대시보드 활성(동의UI·처리방침) · 캘린더 2차 · 과거학기 시간표 · e-Class iCal 연동 · v2 소셜 · 거래마켓 등.

---

## 4. 안전 레일 · Gotchas (매번 밟는 것)
- **완료어휘 금지**: CODE_WRITTEN/LOCAL_VERIFIED/PROD_VERIFIED/USER_REACHABLE. flag OFF면 USER_REACHABLE 아님.
- **배포=Deploy Hook POST**(웹훅 자동 안 됨). 배포 전 직전 SHA 기록, smoke(`scripts/manual/post-deploy-smoke.mjs`) 실패 시 롤백.
- **마이그레이션**: 한 번에 하나. 예행 `prod-dryrun-pending.mjs`(pending/ 폴더 사용, 적용→ROLLBACK) → `prod-apply-migration.mjs <파일> --execute`(사후검증). 다음 번호 = **028**.
- **GPT 검수는 적용/배포 전.** 협업창 = 브라우저 **seed 탭(chatgpt.com "여분채팅창 대기")**. 패킷 `[CLAUDE → GPT] MESSAGE_ID=…`.
- **시크릿·Vercel env·auth.users·Supabase 설정 시크릿값 입력 = 소유자만.** (지도API키·SMTP비번·Resend API키 등)
- **Supabase 컨트롤드 스위치(토글)는 자동클릭이 안 먹는다** — SMTP 토글은 됐지만 signup 토글은 4방법 다 실패. 소유자 클릭 필요.
- **page.js(지도안 마법사)는 GPT와 공동편집** — 소유자가 GPT에 "page.js 그만 만져" 전달함(소유자 다음 지시까지). 만지기 전 확인.
  GPT는 지금 **지도안 교과서ID(비상교육 등 전 출판사) 데이터 수집·테스트 추가 중**(working tree에 커밋 안 된 변경 있을 수 있음).
- **좌표 클릭 스케일**: 스크린샷 크기와 뷰포트가 다르면 어긋남. JS getBoundingClientRect 좌표 = 클릭 좌표계와 같을 때가 많음. 안되면 ref.
- **비밀정보 파일/로그/git/채팅 금지**: 실명·학번·학번HMAC·개인이메일·게시글본문·auth id·API키·커넥션문자열. 소유자 개인 학번·실명도.

---

## 5. 이 세션(2026-07-22~23)에 한 일 (참고)
앱배포 파이프라인 복구(Pro+DeployHook) · 가입메일 완전해결(도메인·DNS·Resend·SMTP, 친구 가입 실증) ·
지도안 마법사 버그2건 수정(planType·토글)+교과서(textbookId)구분 배포 · 분석 S1~S6+migration 024~027 휴면적용 ·
백로그/인수인계 문서화 · 교육실습 구조·학교데이터 파악(소유자 공지자료).

---

## 6. 첫 세션 추천 시작 액션
1. 오리엔테이션(§0) → `git log -5` + flag/배포 실측으로 §1 확인.
2. 소유자에게 "가입토글 껐는지"(§2) + "실습 목록정정부터 갈지, GPT 설계라운드부터 갈지" 확인.
3. §3.0 실습 배정현황표(PDF, ~/Downloads) 파싱 착수 → catalog 스키마 → 업로드기. GPT에 설계패킷(seed 탭).
4. 각 단계 flag OFF·롤백·GPT검수 유지. 진행원장·메모리 갱신.
