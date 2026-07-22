# GOAL 지시서 — 분석·수익화(광고) 기능 구현 (2026-07-22, 컴팩 후 착수)

> 소유자가 컴팩 후 아래 "§ /goal 붙여넣기용" 블록을 `/goal` 로 입력한다.
> 상세 설계·판정은 `ANALYTICS_DESIGN_DRAFT_2026-07-22.md` +
> `reviews/GPT_VERDICT_ANALYTICS_2026-07-22.md`, 학번은 메모리 `snue-hakbeon-structure`.

## 배경 (요약)
- 현 운영: A~F(015~023) 적용됨, flag 3개 OFF, 로그인 개방됨. (SESSION_HANDOFF 참조)
- 소유자 지시: GA(방문통계) + 자체 대시보드 + 학번 기반 맞춤광고. **범위 안 좁힘.**
  광고는 **전부 구현하되 flag(`targetedAds`) OFF 로 휴면 → 사업자등록 시 켬.**
- GPT: DESIGN APPROVED / 축소 NO / 적법 리팩터 YES. 학번은 인증단계 수집, 3층 동의,
  registry 이벤트, k-익명, 구글·광고주엔 개인정보 미전송.

---

## § /goal 붙여넣기용 (이 블록을 복사해서 /goal 로)

```
# GOAL: SNUE 분석·수익화(광고) 기능 구현

원본: docs/ANALYTICS_DESIGN_DRAFT_2026-07-22.md + reviews/GPT_VERDICT_ANALYTICS_2026-07-22.md
+ 메모리 snue-hakbeon-structure(학번 8자리=입학년도4+학과코드2+순번2). 상태 원본은
docs/COLLAB_STATE.md + WORKORDER §9. 매 단계 진행원장 갱신.

## 대원칙 (바지사장)
가역적인 건 전부 구현+flag OFF 휴면으로 안전히 배포하고 보고. 실행 중 사용자 안 찾음.
"잘했네/롤백"만 하게. "안 괴롭힌다"=게이트 스킵 아님, 되돌릴 수 있게 만들어 실행.

## 안전 레일
1. GPT 검수는 적용/배포 *전*(브라우저 seed 탭 GPT 협업창). BLOCKED면 그것만 중단·보고, 나머지 계속.
2. 마이그레이션 한 번에 하나(prod-apply-migration.mjs). 배포 가역(직전 SHA 기록, smoke 실패 시 롤백).
3. 시크릿 값 입력·Vercel env·auth.users 변경 금지(소유자만). 데이터 지우는 down 금지(N3).
4. 파일/로그/git에 실명·학번·학번HMAC·개인정보 금지. 소유자 개인 학번도 금지(형식·코드표만).
5. 완료어휘 금지: CODE_WRITTEN/LOCAL_VERIFIED/PROD_VERIFIED/USER_REACHABLE. flag OFF면 USER_REACHABLE 아님.

## 구현 순서 (단계별, 각 단계 GPT 검수→적용/배포, 전부 flag 뒤)
S1. app/lib/hakbeon.js — 학번 파싱(입학년도·학과코드→학과·예상학년, 입학연도별 코드표, 미등록 임의추정 금지),
    순수함수+테스트. **학번은 학생 인증 단계에서만 수집**(전원 가입 시 X). 파생값 entry_year/
    entry_department/expected_grade/current_grade(사용자확정)/current_major 저장. 시간표="권장 초안".
S2. 동의 3층 — 약관·설정 UI + consent(version·시각·철회시각) 저장. 기본 OFF 독립 2칸(상세통계/맞춤광고),
    상세분석≠광고 자동승격, 맞춤광고 18세+. 목적별 키·식별자 분리(중복가입 HMAC 재사용 금지).
S3. 이벤트 수집 — POST /api/track allowlist schema(허용 이벤트만: screen_view/feature_start/
    feature_complete/button_click/search_submitted/error/sponsor_impression/sponsor_click), 자유문자열·
    ID 금지. usage_events(3파이프라인: 미동의 counter만 / 분석동의 무작위id+세그먼트 90일후 집계 / 광고동의 세그먼트).
S4. /admin/analytics 대시보드 — operator+·audit·원시drill-down없음·CSV금지·소수셀 suppression·k-익명
    (대시보드5·광고20·광고주10). 지표는 학년·학과 세그먼트 + 전환퍼널·재방문·기능채택·무결과검색·
    지도안 중단률·기능별 원가·수익·유지율. ← 여기까지 flag `productAnalytics` 로 활성(사업자 불요).
S5. GA4 — 익명 방문만, Consent Mode 4신호, 학과·학년·학번 미전송, PII redaction. 처리방침·Play Data
    Safety·App Privacy Label 실제 일치.
S6. 광고(전부 구현, flag `targetedAds` OFF 휴면) — first-party 스폰서 슬롯(서버가 학과·학년으로 선택),
    미옵트인=일반/비개인화, 리워드=Google 공식 Rewarded Ads(SR 현금화·양도불가 유지), AdMob/Ad Manager
    (AdSense 아님), 광고주엔 집계만·픽셀 금지. **사업자등록 되면 flag ON.**

## held (실행 안 하고 아침 한 줄)
- targetedAds 활성화(=사업자등록 필요). AI 라이브 생성 테스트·F controlled E2E(소유자). 새 시크릿/Vercel env(소유자).

## 완료 조건
S1~S5 구현+테스트+GPT검수 통과, productAnalytics 로 대시보드 활성(가능하면), S6 광고 코드 완성+targetedAds OFF
휴면 배포, 진행원장·보고 갱신. targetedAds ON 은 사업자등록 대기로 남겨도 완료로 본다.
```

## 참고 — flag 3개 활성화 선행작업(별도 트랙, 소유자 승인함)
분석 기능과 별개로 courseReview(스냅샷공개)·aiCreditCharge(durable 상태기계)·practicumPlacement
(원자적 게시게이트)의 선행작업도 대기 중. 분석 goal 끝나거나 병행 시 착수.

---

## 진행원장 (goal 실행, 2026-07-22 야간)
> 상태 근거: 코드=파일 존재, 테스트=로컬 PASS, 검수=GPT 회신, 적용=prod DB. flag 전부 OFF.

| 단계 | 산출물 | 상태 | 근거 |
|---|---|---|---|
| S1 | `app/lib/hakbeon.js` + `tests/hakbeon.test.mjs` | CODE_WRITTEN·LOCAL_VERIFIED | 12/12 PASS, 전체 176/176 |
| S1 검수 | GPT P-...PARSER_REVIEW_01 | CONDITIONAL_PASS 반영완료 | 코드표 버전범위·KST경계·주석 정정 |
| S1 범위 | 코드표 유효 2000~ | 소유자 확인 | "2000년대 초반까지 커버"(2026-07-22) |
| S2 | `024_analytics_consent.sql` (pending) | CODE_WRITTEN | prod 미적용 |
| S2 flag | features.js hakbeonAutofill/productAnalytics/targetedAds = OFF | CODE_WRITTEN | 휴면 |
| S2 검수 | GPT P-...PACKET_S2_REVIEW_01 CONDITIONAL_PASS | BLOCKER 해소완료 | 철회=원자적 즉시파기(PIPA§37) |
| S3 | `025_usage_events.sql`(pending) + `app/api/track/route.js` + `app/lib/track.js` | CODE_WRITTEN·LOCAL_VERIFIED | 176/176, eslint 0, prod 미적용 |
| S3 검수 | GPT P-...PACKET_S3_REVIEW_01 CONDITIONAL_PASS | BLOCKER 해소완료 | DB rate limit(120/분·조합20/분, 우회불가) |
| S4 | `026_analytics_dashboard.sql`(pending) + `app/admin/analytics/page.js` + `analyticsAdmin.js` | CODE_WRITTEN·LOCAL_VERIFIED | operator+·audit·k_suppress·CSV없음. eslint 0 |
| S4 검수 | GPT P-...PACKET_S4_REVIEW_01 CONDITIONAL_PASS | BLOCKER 해소완료 | complementary suppression + 고정윈도우 7/30/90 |
| S5 | `app/lib/analytics/ga.js` + `app/components/Ga4.js` + `consent.js` + flag `ga4` OFF | CODE_WRITTEN·LOCAL_VERIFIED | **Basic** Consent Mode(동의 전 GA 미로드). eslint 0 |
| S5 검수 | GPT P-...PACKET_S5_REVIEW_01 CONDITIONAL_PASS | BLOCKER 2 해소완료 | 순서보장 인라인부트스트랩 + 동의전 미로드 + 계정전환 재평가 |
| S6 | `027_sponsors.sql`(pending) + `SponsorSlot.js` + `sponsors.js` + `/api/ad-event` + flag `targetedAds` OFF | CODE_WRITTEN·LOCAL_VERIFIED | 서버측 세그먼트 선택·광고주 집계만·seg≥20·보고 k≥10. eslint 0 |
| S6 검수 | GPT P-...PACKET_S6_REVIEW_01 CONDITIONAL_PASS | BLOCKER 해소완료 | **delivery token** 위조·중복·증폭 차단(원자적 1회) |
| 최종1차 | 사인오프 패킷 발신 → WITHHELD, 신규 BLOCKER 4 | 반영완료 | 아래 |
| B1 | 025 rate 순서(registry 먼저→전체키→등록조합만 combo) | 반영 | usage_rate 행 증폭 차단 |
| B2 | 026 세그먼트=완결 달력구간(주/월/분기) 불변 스냅샷 | 반영 | rolling 차감 공격 차단 |
| B3 | Ga4 full navigation 격리 + consent.js reload | 반영 | 철회·계정전환 후 태그 잔존 차단 |
| B4 | 027 DB app_flags fence + 발급상한 + caller일치 + click은impression후 + prune-analytics 크론 | 반영 | 광고 발급·위조·flag우회 차단 |
| 최종2차 | B1~B4 해소 사인오프 패킷 발신 | 회신 대기 | build ✓·176/176·eslint 0 |

**결론(2026-07-22 야간):** 분석·수익화 S1~S6 **코드 완성 + GPT 검수 7라운드(BLOCKER 총 9건) 전부 반영.**
전부 되돌리기 쉬운 상태(migration 024~027 미적용·flag 전부 OFF·targetedAds DB fence false·UI 미배선).
소유자 승인 후 ①024→025→026→027 순차 prod 적용(각 REQUIRED_EVIDENCE) ②productAnalytics ON
③동의 UI·처리방침·layout Ga4 배선 ④(사업자등록 후) app_flags.targeted_ads=true+targetedAds ON.

**UI 배선 미완(활성화 시점 작업):** 동의 설정 토글 화면·학번 자동채움 입력·finalize 라우트 파생저장 호출·이벤트 track() 호출부·layout에 &lt;Ga4/&gt; 얹기. 전부 flag OFF라 현재 휴면.

**미적용/보류(소유자·검수 게이트):** 024·025 prod 적용(검수+소유자), 어떤 flag ON, targetedAds(사업자등록).
finalize 라우트 학번파생 저장 연결(Q4: finalize 성공 후 idempotent, academic 실패해도 인증유지)은 S2/S3 검수 통과 후.
**S2 BLOCKER 해소:** 024 set_my_consent 철회 시 analytics_subjects 삭제 → 025 usage_events ON DELETE CASCADE 로 원시 즉시 파기.
