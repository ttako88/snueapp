# 🔴🔴 작업지시서 + 인수인계 (2026-07-23 밤, 초대형 세션) — 컴팩 직후 이것부터 통째로 읽어라

> 이 세션에서 **핫픽스 다수 + 회원가입 대개편 + 통합 콘솔 대량 확장 + 지도안 저장/자랑 + 숨은기능 노출**
> 을 쏟아냈다. 컨텍스트가 차서 컴팩 대비 상태를 통째로 박제한다. 요약·기억이 이 문서와 어긋나면 **이 문서가 이긴다.**
> ⚠️ "파일 있음 ≠ 적용/배포됨" — 라이브는 배포SHA·flag·DB 실측이 근거.

---
## ⏫ 밤 후반 갱신 (컴팩 이후, 이 줄이 §0·§1보다 최신)
- **프로덕션 배포 = `9b56b6d` (Ready 확인, 빌드 성공).** 아래 §0의 460bff4는 낡음.
- **§1 적용대기 SQL 전부 해소**: 029·032·033 **모두 프로덕션 적용 확인**(읽기전용 프로브 `scripts/manual/probe-pending-applied.mjs`로 실측 — analytics VOLATILE·lesson_plan_saves·member_notes 다 존재). 소유자가 cmd로 다 침. **더 이상 적용 대기 SQL 없음.**
- **§3 1단계 완료+배포**: `budget.mjs` MODELS 메타(label·blurb·badge·order·provider) + `provider.mjs` `availableModels()`. 유저영향 0(아직 호출부 없음). 커밋 419ec8a.
- **게시판 콘솔 설계 doc 작성**: `docs/BOARD_CONSOLE_DESIGN_2026-07-23.md` — 전체 옵션 superset(A~F + G). **소유자 번호 선택 대기** → 고른 범위로 구현. 커밋 9b56b6d.
- **주의(관찰)**: git push 후 9b56b6d가 자동 Ready 되고 훅 POST 빌드가 하나 더 돌았다 → **웹훅 자동배포가 켜져 있을 수 있음**(워크오더는 "꺼짐"이라 적었으나 실측은 자동배포 정황). 다음 배포 땐 push만으로 뜨는지 먼저 확인.
- **다음**: §3 2단계(ai_model_pricing 테이블+가격콘솔, 마이그레이션 034) OR 게시판 콘솔(소유자 번호 선택 후). 초기 SR 시드값 = 제미나이Flash 약안100/세안300, Claude Haiku 약안150/세안400(소유자 "초기값대로" 승인).

## 0. 지금 상태 한 줄
- **프로덕션 배포 = origin/main `460bff4`** (Deploy Hook로 배포함, 전부 push됨). 롤백은 직전 커밋들로 가역.
- **배포 방식**: git push만으론 안 뜬다 → **Vercel Deploy Hook POST**. tab-2(vercel Settings/Git)에서 훅 URL fetch POST. 훅 URL은 채팅에 안 남김(배포트리거 권한).
- **소유자=조상호, 존댓말. 바지사장 모델**(가역이면 자율로 만들고 보고).

## 1. ⛔ 먼저: 소유자가 적용해야 할 SQL (이거 안 하면 방금 만든 것들 안 動)
pending/ 에 028~033. **028·030·031 = 적용됨.** 남은 것:
- **029** (이용통계 read-only 오류 수정, analytics_overview·analytics_daily VOLATILE) — 상태 불명(소유자 SQL Editor로 했을 수도). 안 됐으면 SQL Editor 2줄:
  `alter function public.analytics_overview() volatile; alter function public.analytics_daily(text,int) volatile;`
- **032** (지도안 저장/불러오기 + my_lesson_plan_access): `node scripts/manual/prod-apply-migration.mjs pending/032_lesson_plan_saves.sql --execute`
- **033** (회원메모 + 알림함 목록 + 콘솔 note): `node scripts/manual/prod-apply-migration.mjs pending/033_member_notes_and_messages.sql --execute`
- ⚠️ **적용 도구 헛FAIL 주의**: 함수만 바꾸는 마이그레이션은 "객체 안 늘었다" FAIL, `anon EXECUTE 2` FAIL(030의 username/nickname_available, 의도된 것). **"실행 완료"+데이터불변+기존함수생존이면 성공.** 028·030·031 적용 때 같은 패턴 확인함.
- ⚠️ **하네스 분류기가 Claude의 운영 DB 쓰기(prod-apply --execute)를 하드블록** → **소유자가 cmd로 직접 실행**해야 함(028·030·031·032 다 소유자가 침). dry-run·ACL측정은 Claude 가능(읽기·롤백). 새 세션에선 settings.local.json 허용규칙이 먹을 수도(미검증).

## 2. 이 세션에 라이브로 나간 것 (전부 배포됨, git에 있음)
**회원가입 대개편** (030 적용됨): 아이디·이메일·비번·**학번(HMAC 1인1계정, 원문 미저장)**·닉네임 + 동의(학번필수·통계선택·**전체동의 체크**). 아이디·닉네임·**학번** 실시간 초록/빨강 중복확인. 학번칸 안심박스(🔒 암호화·대조전용·관리자도 못 봄)+경고문(추후 인증서류 대조). **아이디 로그인**(서버가 아이디→이메일 조회, 이메일 비노출). 매직링크는 '메일 링크' 탭 유지. 라우트: `/api/auth/signup·login·check-hakbeon`. ⚠️ **비번 신규가입은 Supabase 'Allow new users to sign up' ON 필요**(현재 임시 OFF일 수 있음). 기존 매직링크 유저는 '비번 잊음'→재설정으로 비번 최초설정.

**통합 콘솔 `/admin/console`** (028·031·033): 회원(검색·아이디·이메일·🎓학번인증·📊통계동의·**운영자 메모**[목록 회색 미리보기])·**이용권 부여/회수**(지도안 생성권, 인앱 사유입력)·**권한(역할) 부여**(grant_role, owner전용)·**계정 강제삭제**(`/api/admin/members/delete`, owner·본인/운영진차단·사유). 이용권/분석 탭 + boards/moderation/sponsors/settings/audit=플레이스홀더.

**지도안**: 약안→세안 시 약안 보전(탭 전환)·**저장/불러오기**(💾저장→📁내 지도안 `/practicum/lesson-plan/saved`)·**잔여 이용권 표시**·**상단 자랑 배너**(LessonPlanIntro: 6출판사·11과목·1~6학년·378단원·5,884차시·성취기준600+·2022개정, 할루시네이션 없음, AI선택 예고).

**숨은 기능 노출**: **내 스크랩**(`/settings/bookmarks`)·**알림함**(`/settings/messages`, 받은 제재/인증 알림). 게시판 목록에 조회·추천·댓글 수(에타식). 설정 동의옵션 최하단. 운영자 진입버튼 /admin 허브로.

**분석**(이전 세션): productAnalytics·GA4(측정ID G-T287GHDNWQ) 라이브. 029만 적용하면 대시보드 오류 해결.

## 3. ⚑ 다음 착수 = SR 경제 + AI 모델 콘솔 (한 번에, 소유자 확정)
**설계 원본: `docs/AI_MODELS_AND_SR_ECONOMY_DESIGN.md` (필독).** 소유자: "각 잡고 제대로·무한확장. 강의평가·학교후기 슬슬 오픈."
착수 순서(설계문서 §빌드순서):
1. **AI 모델 레지스트리 확장** (budget.mjs MODELS에 label·blurb·badge·order 메타 + availableModels 헬퍼). provider.mjs엔 이미 gemini·claude·gpt 어댑터 있음(키만 있으면 활성).
2. **`private.ai_model_pricing(model_id,purpose,sr_cost,enabled)` 테이블 + 운영자 가격 콘솔**(모델별 약안/세안 SR 입력칸, owner).
3. **API 키 콘솔 관리**(소유자 폰 딸깍): `private.ai_provider_keys`(pgcrypto 암호화, env `AI_KEY_ENC_SECRET`). **쓰기전용·원문 반환 RPC 절대 없음·`설정됨 ····last4`만·owner전용**. provider.mjs가 env 대신/우선 DB키 복호화. ⚠️키 원문 입력은 **소유자만**(Claude 금지).
4. **이용자 모델 메뉴판**(지도안 화면 카드: `label·badge·약안N/세안N SR`+내 잔액, 부족시 안내). 서버가 model 허용목록 검증(비싼모델 우회 차단).
5. **SR 적립원천**: **강의평가**(courseReview flag 011/016, 차분공격 snapshot+과목마스터 선행) + **학교후기**(신규) → +SR. **SR 잔액·거래내역 UI**.
6. aiCreditCharge flag ON → 공개 SR 경제 가동(모델별 차감). 023 durable 상태기계(CHARGED→GENERATING→CONSUMED/REFUNDED, timeout 영구차감 방지).
- SR = 현금화·양도 불가. 이용권(028)은 지인 경로로 공존.

## 4. 아직 안 붙인 것 (백로그)
- **학과·학년 확정**(get_my_academic/set_my_academic_confirmation, 마이그레이션 불필요) — 다음 바로 가능.
- **차단 관리**(block_author/list_my_blocks 있으나 목록에 닉네임 없어 스키마 손봐야 제대로).
- 콘솔 모듈: 모더레이션 큐·버그제보 관리·게시판 공지(리스트 RPC 신설 필요).
- 지도안 툴 위 **편집형 PR 배너**(콘솔에서 문구 관리) — 소유자가 원하면.
- 지인 이용권 부여(콘솔 부여버튼 작동, 닉네임 받으면).

## 5. 🔧 Gotchas (매번 밟음)
- **page.js(지도안 마법사)=GPT 공동편집**. GPT 미커밋 WIP(textbookName→**textbookLabel**+isSelected, unitList.mjs·CSV 짝)이 워킹트리에 있다. **page.js 커밋 시 격리**: GPT 훅을 HEAD(textbookName)로 되돌림→내 것만 커밋→GPT 훅 재적용. `git diff --cached page.js | grep -c textbookLabel` 로 0 확인. 이번 세션 3회 그렇게 함(67828ea·81a3828·3427556).
- **커밋은 명시 경로만**(`git add <경로>`). `git add -A` 금지(GPT WIP·미완 딸려감).
- **완료어휘 금지**: CODE_WRITTEN/LOCAL_VERIFIED/PROD_VERIFIED/USER_REACHABLE. flag OFF/미적용이면 USER_REACHABLE 아님.
- **비밀정보**: 학번원문·실명·HMAC·이메일·auth id·API키·훅URL 파일/로그/git/채팅 금지. **API키 원문 입력은 소유자만**.
- **협업 GPT**: 브라우저 seed 탭(chatgpt "여분채팅창 대기"). DOM은 javascript_tool로 통짜 읽기(좌표X). 이번 콘솔은 GPT R1~R3 검수받고 배포함(BLOCKER 다 반영).
- **마이그레이션 다음 번호 = 034.** pending/ 정리: 028·030·031(+032·033 적용후)은 migrations/로 옮기면 dry-run 깔끔(028 재적용 index 충돌 FAIL 방지).

## 6. 참고 문서
- `docs/AI_MODELS_AND_SR_ECONOMY_DESIGN.md` — 다음 작업 설계 원본.
- `docs/SIGNUP_REDESIGN_2026-07-23.md` — 회원가입 재개편 상세.
- `docs/ADMIN_CONSOLE_2026-07-23.md` — 콘솔·이용권 상세.
- `docs/SESSION_HANDOFF_2026-07-23.md`(상세판) — 세션 이전 상태·규율.
- 메모리: snue-admin-console-2026-07-23 · harness-blocks-prod-writes · browser-read-via-js.
