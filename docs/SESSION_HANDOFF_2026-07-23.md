# 🔴🔴 세션 인수인계서 + 작업지시서 (2026-07-23, 상세판) — 새 채팅은 이걸 통째로 읽고 시작

> **이 문서 하나만 읽으면 "무엇이 라이브인가·무엇이 남았나·무엇을 어떤 순서로 어떻게" 를 전부 안다.**
> 이전 세션이 매우 길어져 새 채팅으로 넘어옴. 요약·기억이 이 문서 또는 `docs/COLLAB_STATE.md`와 어긋나면 **문서가 이긴다.**
> ⚠️ 대원칙: **"파일이 있음 ≠ 배포/적용됨."** 라이브 여부는 반드시 **운영 실측**(배포 SHA·flag값·DB 조회)으로 확인한다.

---
## §A. 이 프로젝트가 뭔가 (30초)
- **SNUE "새록이"** = 서울교육대학교(서울교대) 학생용 웹앱. 소유자=조상호(첫 개발 프로젝트, **존댓말로 응대**).
- 스택: **Next.js 16.2.10 (App Router) + React 19 + Supabase(Postgres/Auth/Storage) + Tailwind**, Vercel 배포.
- URL: 프로덕션 `https://snueapp.vercel.app` · 도메인 `snueapp.com`(가비아, 메일용) · repo `github.com/ttako88/snueapp` (branch `main`).
- 로컬 경로: `C:\Users\조상호\Desktop\클로드\snue-app`. 데이터: `app/data/*.json`, 마이그레이션: `supabase/migrations/`.
- **소유자 성향(중요)**: 바지사장 모델 — "아이디어 내고 자면 아침엔 구현돼 있길". 가역적인 건 **자율로 만들어 붙이고 보고**.
  멈춰서 계속 묻지 말 것. 호출은 "서버 삭제급"만. 단 **시크릿·비가역·인증경계**는 소유자 몫.

## §B. 반드시 지키는 규율 (매번 밟음)
1. **완료어휘 금지.** "완료/됐다" 대신 `CODE_WRITTEN`/`LOCAL_VERIFIED`(테스트 PASS)/`PROD_VERIFIED`(운영 실측)/
   `USER_REACHABLE`(사용자 실제 도달). **flag OFF면 USER_REACHABLE 아님.** 테스트·빌드 PASS는 완료가 아니라 증거.
2. **물어볼 수 있는 걸 추론하지 않는다.** 권한은 `has_function_privilege`로 묻는다(ACL 수동파싱 금지, 3회 틀림).
   `count(*)`는 문자열로 오니 `Number()`. 산술은 코드로.
3. **실패를 조용히 삼키지 않는다.** 파싱실패를 빈배열·0·기본값으로 덮지 말고 명시적 오류/UNKNOWN으로 중단.
4. **비밀정보 절대 파일/로그/git/채팅 금지**: 실명·학번·학번HMAC·개인이메일·게시글본문·auth user id·API키·커넥션문자열·JWT.
   소유자 개인 학번(형식만 OK)·실명도 금지.
5. **★ 과업 하나 끝날 때마다 상세 MD 저장 ★** (소유자 강조, 그동안 소홀했음): 진행원장/핸드오프/메모리를 그때그때
   갱신. "무엇을·왜·어떻게·다음" 을 컴팩에도 안 잃게. 이 습관을 반드시 지킬 것.
6. GPT 검수는 **적용/배포 전.** 마이그레이션 한 번에 하나. 배포 가역(직전 SHA 기록·smoke 실패 시 롤백).

## §C. 지금 라이브 상태 (2026-07-23 실측 기준 — 새 세션은 `git log -5` + 아래 flag/배포로 재확인)
- **프로덕션 배포** = 커밋 `276eebe` 계열(그 뒤 GPT 지도안 데이터 커밋 있을 수 있음, `git log`로 최신 확인). 롤백기준 `153bf99`.
- **배포 방법 (중요!)**: ⚠️ **Vercel GitHub 웹훅이 push→build를 자동으로 안 띄운다.** git push만으론 배포 안 됨.
  → **Deploy Hook `claude-main-deploy`** 를 POST해야 배포됨. 방법: Vercel 대시보드 → 프로젝트 snueapp → Settings → Git →
  Deploy Hooks 에 훅이 있음. 브라우저에서 그 페이지 열고 `fetch(deployHookUrl, {method:'POST'})`. Pro 플랜이라 빌드한도 OK.
  배포 라이브 확인: `curl https://snueapp.vercel.app/<신규경로>` 또는 units API에 `textbookName` 마커 등. smoke=`scripts/manual/post-deploy-smoke.mjs`.
- **가입메일/로그인 = 완전 해결.** 도메인 snueapp.com(가비아) 구매 → DNS(DKIM `resend._domainkey` TXT / SPF `send` MX+TXT /
  DMARC `_dmarc` TXT, ⚠️MX는 가비아 IP검증버그로 **트레일링 닷** 필요했음) → **Resend 도메인 Verified** → Supabase 커스텀 SMTP
  저장(host smtp.resend.com·port465·user resend·pw=Resend API키·발신 no-reply@snueapp.com). 로그인=**이메일 매직링크**.
  친구가 실제 가입·인증신청까지 성공(end-to-end 실증). Resend/Supabase/Gabia 창은 브라우저 seed 외 탭들에 로그인돼 있음(소유자).
- **지도안 마법사(/practicum/lesson-plan) = 라이브.** 폼렌더(LessonPlanView)·PDF인쇄·한글/워드(.doc) 내보내기·약안→세안 버튼·
  **owner 전용 생성게이트**(lessonPlanPublic OFF라 지금은 role=owner만)·관리자콘솔(/admin, /admin/verification 인증심사,
  /admin/analytics). **버그 2건 수정 배포됨**: ①planType(`onClick={submit}`→이벤트가 planType으로 새어 "지도안 종류 골라주세요"
  항상 실패 → `onClick={()=>submit()}`) ②단원버튼 재클릭 토글(해제) 추가. **교과서(textbookId) 구분 시스템**도 배포(출판사별
  차시 안 섞이게, unitList.mjs·buildEvidence 선택교과서만).
- **학생 인증 심사 = 작동.** /admin/verification 에서 owner가 제출서류 보고 승인/반려. (친구 신청 1건 대기 상태였음.)
- **분석·수익화 S1~S6 + migration 024~027 = prod 적용됨.** 테이블 39→51·함수 134→152, 기존데이터 불변, RLS·권한·k익명 검증.
  member_academic·member_consents·analytics_subjects·usage_events·usage_counters·analytics 대시보드RPC·sponsors 등. **전부 flag OFF 휴면.**
- **flag 전부 OFF** (`app/lib/features.js`): courseReview · aiCreditCharge · practicumPlacement · hakbeonAutofill ·
  productAnalytics · targetedAds · lessonPlanPublic · socialLogin. DB fence `app_flags.targeted_ads=false`.

## §C-2. ★ 사용자 데이터 수집(분석·수익화) — 뼈대 완성·배포됨, flag OFF라 지금 수집량 0 ★
> 소유자가 강하게 원하는 **수익화 기반**. "인프라는 다 있는데 스위치가 꺼진" 상태. 브리핑 때 반드시 언급할 것.
- **prod 적용됨(migration 024~027, 휴면)**: `usage_events`·`usage_counters`(행동이벤트 allowlist) · `member_academic`
  (학번 파생 학과·학년 세그먼트, 인증단계 서버계산 저장) · `member_consents`(상세통계/맞춤광고 독립동의·18+) ·
  `analytics_subjects`(무작위 가명id, 중복가입 HMAC 재사용 안 함) · `/admin/analytics` 대시보드RPC(학년·학과 세그먼트·k익명) ·
  sponsors 광고테이블. 3파이프라인(미동의=카운터만/분석동의=무작위id+세그먼트 90일후 집계/광고동의=세그먼트). GPT 검수 PASS(12 MUSTs 반영).
- **실제 수집 안 되는 이유 = 활성화 선행작업 미완**:
  ① **동의 3층 UI**(약관·설정, 상세통계/맞춤광고 독립토글) — 화면 없음
  ② **처리방침(개인정보) 문구** 확정(법적)
  ③ **이벤트 배선** — 앱 버튼·화면에 `POST /api/track`(허용이벤트만) 호출 심기 — 심긴 데 없음
  ④ **학번 파생 저장 연결** — 인증 finalize 라우트에서 svc_set_member_academic 배선(서버가 정규화 학번 재계산 저장, 클라값 불신)
  ⑤ 그다음 **flag `productAnalytics` ON** → 대시보드·수집 활성(사업자 불요). 맞춤광고 `targetedAds`는 사업자등록+DB fence 후.
- 설계 원본: `docs/ANALYTICS_DESIGN_DRAFT_2026-07-22.md` + `docs/reviews/GPT_VERDICT_ANALYTICS_2026-07-22.md`. 메모리 `snue-hakbeon-structure`(학번 파싱).
- **이건 #3·#0와 별개 트랙.** 소유자가 "데이터 수집 언제 켜냐" 물으면 위 ①~⑤가 남았다고 답하고, 원하면 이 트랙 착수.

## §D. 인프라·계정 (누가 뭘 할 수 있나)
- **Vercel**: Pro. 배포=Deploy Hook. env(GEMINI_API_KEY 등)=소유자만 등록. 웹훅 자동배포 복구는 backlog.
- **Supabase**: 프로젝트 ref `jclwkvxbvsegmbcnptpi`, org ttako88. Auth=매직링크. 커스텀SMTP 저장됨.
  ⚠️ **Supabase 컨트롤드 스위치(토글)는 자동클릭(좌표/ref/JS/포인터) 4방법 다 안 먹힌 사례 있음**(가입토글). 소유자 클릭 필요.
- **Resend**: 메일발송. 도메인 Verified. API키=한 번만 보임(재발급). SMTP비번=그 API키.
- **가비아**: 도메인 snueapp.com. DNS 관리 = my.gabia.com 로그인 후 dns.gabia.com(직접 URL은 차단, My가비아 경유).
- **내가(Claude) 못 하는 것**: 시크릿 값 입력(API키·비번·env), auth.users 변경, 결제, 계정생성, 지도API키 등록.

## §E. ⚑ 작업 순서 (소유자 확정 2026-07-22: **#3 → #0**. 전부 GPT검수·flag OFF·롤백 가능)

### E-0. (공유 기반, 제일 먼저) 실습학교 목록/catalog + 관리자 업로드 파이프라인
- **왜 먼저**: #3의 practicumPlacement(school catalog)와 #0(도우미 학교목록)이 **같은 데이터**. 이거부터.
- **현 문제**: `app/data/practicumSchools.json` = HWP 최소파서(`scripts/manual/parse-hwp-schools.mjs`) 추출 → `verified:false`,
  **신용산초 누락**, 요약(관찰6·종합11)과 목록수 불일치, "강남서초"(지역명)를 학교로 오인한 전례. 자동추출 그대로 믿으면 안 됨.
- **원본 확보(소유자 제공, `C:\Users\조상호\Downloads`)**: 학기별 "교육실습 협력학교 실습생 배정현황" —
  `2025-2학기 교육실습 협력학교 실습생 배정현황(20250908).pdf` · `교육실습 협력학교 배정 현황표.pdf`(2026-1). 2025-1은 이미지로도 받음.
  표 구조 = `실습종류(관찰/참가/수업/운영/종합) × 지역(11개) × 학교 × 학급수 × 배정인원(A/B군 분리)`.
  ✅ **신용산초 = 중부 지역 종합실습 협력학교**(2025-1 배정현황에 있음. 소유자 2026-1 종합실습 다녀옴).
- **할 것**:
  1. 배정현황표(PDF) 파싱 → 학기·실습종류·지역·학교·학급수·배정인원 구조화. **검수 미리보기 필수**(사람이 확인 후 확정).
  2. **DB `private.practicum_school_catalog`**(학기별 active, school_id·display_name) — practicumPlacement 게시게이트가 자유입력 대신 이걸 검증.
  3. **재사용 업로드기**(관리자 /admin 전용): 파일 업로드→파싱→검수→확정 반영, **이전버전 보존(롤백)**. → 나중에 **수강시간표 업로드기**로도 확장(같은 파서 틀).
- 상세는 memory `snue-practicum-structure`(교육실습 5단계·배정원칙·지망방식·데이터스키마).

### E-1. #3 커뮤니티 flag 활성화 (코드/마이그레이션은 있음, 켜기 전 하드닝 필요)
> 실패모드가 커서 **선행 안전작업 없이 flag ON 금지.**
- **practicumPlacement(실습배정 게시)** — 019 migration 적용됨. GPT 019 검수 MUSTs 반영:
  · school_short 자유입력 → **canonical school_id + 학기별 active catalog 검증**(E-0)
  · `can_post_practicum` 의 locked_at **부작용 제거**(STABLE 읽기전용으로) → **원자적 게시게이트**(게시물 writer가 한 트랜잭션에서
    배정행 FOR UPDATE→현재학기·학교 일치확인→게시물 insert→locked_at=coalesce)
  · set_practicum_placement: 현재 활성학기만 생성/수정, 과거학기 읽기전용, **현재학기는 DB single current-semester 설정** 기준
  · 학교별 count는 **k=3 이상**만 정확 반환(그 미만 익명화). 잠금 후 변경 audit.
  · GPT 판정: placement **UI는 MUST 후 flag ON 가능**, **게시 활성화는 원자게이트 완성 전 금지.**
- **aiCreditCharge(지도안 SR 차감)** — 022(currency_split)·023(ai_credit_charge) 적용됨. ← **durable 상태기계**
  (CHARGED→GENERATING→DELIVERABLE_COMMITTED / 실패·timeout 시 REFUNDED, **SR 영구차감 방지**). flag OFF면 개인제한 없음(일일예산 018만).
- **courseReview(강의평가)** — 011 적용됨. ← **스냅샷 공개**(실시간 통계 차분공격 차단) + **과목 마스터 적재**
  (`private.course_review_subjects` 비면 평가대상 0).

### E-2. #0 실습학교 지망 도우미 (신규 flag `practicumSchoolAdvisor`)
- 지도 API(카카오맵/네이버맵 — **키=소유자 등록 시크릿**) geocoding+거리. 실습학교를 **거리·위치**로 최적 나열해 지망순위 도움.
- **반드시 반영**: ①배정원칙(**이미 다녀온 학교는 뒤로**) ②배정인원 대비 지망자=**경쟁률**(추첨 확률) ③지역 ④실습종류/학년별 후보 다름.
- client + 정적데이터 + 지도API, DB 최소 → 롤백 쉬움. flag OFF 휴면.

### E-3. SR 시스템 전체 도입 (소유자 "SR 필요한거 싹 다")
- 잔액 원장(022 토대) + 차감 durable 상태기계(E-1 aiCreditCharge 동일) + **적립원천**(강의평 작성·Google Rewarded Ads 시청) +
  소모(지도안 생성·자료 열람) + **UI**(잔액·거래내역). SR = **현금화·양도불가** 유지. 광고연계는 S6(targetedAds, 사업자등록 후).

### E-4. 가입 임시차단 (소유자 지시 "잠시 회원가입 막기")
- Supabase Auth→Sign In/Providers→**User Signups→"Allow new users to sign up" OFF→Save.** (기존회원 로그인 유지.)
  ⚠️ 이 토글 자동클릭 실패 이력 → 소유자 직접 or 재시도. 앱코드로 막으면 배포 시 GPT WIP 딸려가 위험하니 지양.

### E-5. 나머지 (`docs/BACKLOG_남은목록.md` 참조)
분석 대시보드 활성(동의UI·처리방침 선행)·캘린더 2차·과거학기 시간표·e-Class iCal 연동·GA4·v2 소셜(댓글/쪽지/친구시간표/포인트)·
거래마켓(장터/족보/기숙사/대타)·네이티브 위젯·웹훅 자동배포 복구·학교 정식 API문의.

## §F. Gotchas (안 밟으면 사고)
- **page.js(지도안 마법사) = GPT와 공동편집 파일.** 소유자가 GPT에 "page.js 그만 만져" 전달함(소유자 다음 지시까지). GPT는 지금
  **지도안 교과서ID(비상교육 등 전 출판사) 데이터 수집·테스트 추가 중** → working tree에 **커밋 안 된 GPT 변경 있을 수 있음**.
  지도안 파일 만지기 전 `git status` 확인, GPT WIP 존중. 배포 때 GPT WIP 딸려가는 것 주의.
- **GPT 협업창** = 브라우저 **seed 탭(chatgpt.com, "교대용 어플 개발" 프로젝트 > "여분채팅창 대기")**. 패킷 형식
  `[CLAUDE → GPT]\nMESSAGE_ID = C-YYYYMMDD-...\n...`. 응답도 `[GPT → CLAUDE]`. 컴포저 채워 전송, 응답은 DOM에서 읽기.
- **좌표 클릭 스케일 주의**: 스크린샷 크기 ≠ 뷰포트면 어긋남. JS `getBoundingClientRect` 중심좌표가 클릭좌표와 맞는 경우 많음. 안 되면 ref, 그것도 안 되면 소유자.
- 마이그레이션 다음 번호 = **028**. 예행 `prod-dryrun-pending.mjs`(supabase/migrations/pending/ 에 사본 두고 실행, 적용→ROLLBACK) →
  본 적용 `prod-apply-migration.mjs <파일> --execute`(강력 사후검증: 데이터불변·기존함수생존·RLS-off 0·anon EXECUTE 0).
- `node --test tests/*.test.mjs` = 전체 테스트. 빌드 `npm run build`. lint `npx eslint <파일>`.

## §G. 이 세션(07-22~23)에 한 일 (참고, 다시 안 함)
앱배포 파이프라인 복구(Pro+DeployHook) · 가입메일 완전해결(도메인·DNS·Resend·SMTP, 친구 실증) · 지도안 버그2건+교과서구분 배포 ·
분석 S1~S6+migration 024~027 휴면적용 · 백로그/핸드오프/교육실습 구조 문서화 · 학교 배정현황 원본 확보.

## §H. 첫 세션 액션 (이대로)
1. §A~B 규율 흡수 → `git log -5`·flag·배포 실측으로 §C 재확인. 소유자에게 존댓말.
   **브리핑 시 §C-2(사용자 데이터 수집: 뼈대완성·flag OFF·수집 0·활성화 선행작업 5개)를 반드시 포함**할 것.
2. 소유자에게 확인: "가입토글 껐는지" + "무엇부터: E-0(실습 목록/업로드) / #3 커뮤니티flag / 데이터수집 활성화(§C-2) / GPT 설계라운드".
3. **E-0 착수**: `~/Downloads` 배정현황표 PDF 파싱 → catalog 스키마 설계 → GPT에 설계패킷(seed 탭) → 검수 후 구현(flag OFF).
4. **★ 과업 끝날 때마다 이 문서/진행원장/메모리 갱신 ★**(§B-5). 각 단계 flag OFF·롤백·GPT검수 유지.
