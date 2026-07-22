# GPT 판정 — 분석·수익화 설계 (2026-07-22)

MESSAGE_ID = P-20260722-ANALYTICS_DESIGN_REVIEW
```
DESIGN_DIRECTION = APPROVED
DATA_COLLECTION_SCOPE_REDUCTION_REQUIRED = NO   ← 소유자 성향(안 좁힘) 존중
LEGALIZATION_REFACTOR_REQUIRED = YES            ← 축소 아니라 "적법 경로로 리팩터"
ANALYTICS_ACTIVATION = YES_AFTER_MUST
TARGETED_SPONSOR_ACTIVATION = YES_AFTER_MUST_AND_BUSINESS_READINESS
GA4_ADSENSE_ACTIVATION = SEPARATE_CONSENT_AND_POLICY_PATH
```
결론: **기능 범위 유지, 데이터 경로를 3층으로 분리** — 필수(운영·보안) / 선택(상세 제품분석) / 선택(맞춤광고). 핵심 결함 지적: "학번을 이미 수집한다"가 통계·광고 이용까지 자동 정당화하지 않는다. HMAC 학번·파생 학과·학년·행동정보는 여전히 개인정보. 인증·중복가입 목적 ≠ 광고 목적. 고치면 학과·학년 상세분석 + first-party 스폰서 광고 **자체는 유지 가능**.

## 질문별 답
1. **PIPA·앱마켓·구글**: 목적별 적법화. ⚠️ **로그인이 이제 누구에게나 열려서(015), 모든 가입자에게 학번 필수로 받으면 안 됨 — 학번은 "학생 인증 시작할 때" 받는다.** 선택 동의는 약관에 묶지 말고 **기본 OFF 독립 항목**([선택] 상세 이용통계 / [선택] 학과·학년 맞춤 스폰서). 거부해도 핵심서비스 제공+일반광고. "개인 미결합" 명명으론 면책 안 됨(개인정보위). Apple: 익명 usage도 동의·철회, 클릭=Product Interaction, 결합추적 시 ATT. Google Play: SDK 수집·공유를 Data Safety·처리방침 일치+계정삭제 시 데이터삭제.
2. **학번 파싱 엣지**: 학번→ **예상 학년**(휴학·복학·유급·편입·조기졸업·유예·대학원으로 실제와 다름). 저장: entry_year(학번확정)·entry_department(코드확정)·expected_grade(계산)·current_grade(사용자 학기마다 확인·수정)·current_major(사용자확인). 학과=**입학 당시**. 복수·심화·현재관심은 별도 선택. 성별·나이 학번추론 금지(각각 선택+"응답안함"). 코드표 **입학연도별 버전**관리, 미등록·비정상 임의추정 금지. 시간표=학번만으론 개인 수강변경 모름 → **"권장 시간표 초안"**으로 문구, 사용자 확정.
3. **버튼 집계·재식별**: 자동 DOM 전체수집 부적합 → **registry 방식(허용 이벤트만)**: screen_view/feature_start/feature_complete/button_click/search_submitted/error/sponsor_impression/sponsor_click. 금지: keystroke·자유서술·글/댓글 내용·인증서류·이메일/학번/회원ID·URL 식별자·원문검색어 무제한·DM/신고/상담. 학과·학년+정밀시각 붙으면 **pseudonymous**(anonymous 아님). 3파이프라인: 미동의=즉시 counter만(ID·세그먼트 저장X) / 분석동의=무작위 analytics_subject_id·학과학년segment·원시 90일후 집계만 / 광고동의=학과학년segment로 광고선택(행동 이벤트는 광고선택에 미사용). **k**: 대시보드 셀≥5, 맞춤광고 대상 segment 최근활성 옵트인≥20, 광고주보고 셀≥10·24h지연, complementary suppression. 광고주는 개인·학번·학과별 목록 못 봄, 집계만.
4. **first-party 스폰서 vs Google 혼용**: 가능하나 인벤토리·데이터경로 분리. 옵트인=자체 스폰서 슬롯(서버가 학과·학년으로 선택), 미옵트인=일반 자체 스폰서 or 비개인화 Google. **Google 요청에 학번·HMAC·회원ID·학과·학년·검색어 미전송.** 네이티브는 AdSense 아니라 **AdMob/Ad Manager**(직접광고+backfill은 Ad Manager 자연). 규칙: 광고·후원 표시, 시스템버튼 오인금지, UI 겹침금지, 광고주 픽셀·SDK 삽입금지, 외부링크 학과·학년 query 금지, Google 클릭에 자체보상 붙이지 않기. 리워드는 Google 공식 Rewarded Ads(현금화·양도불가 free SR 제한, 자발적·사전고지·서버검증).

## MUST — 활성화 전 (요약)
1. 학번 수집을 **학생 인증 단계로** 이동(전원 가입시 X).
2. 목적 3분리 + consent version·시각·철회시각 저장(student_verification/product_analytics/academic_segment_ads).
3. 중복가입 HMAC을 analytics/광고 ID로 재사용 금지. 목적별 키·식별자 분리. 학번 원문 로그·URL·GA4·광고요청에 미기록.
4. 학번 파생값을 entry_year/entry_department/expected_grade/current_grade/current_major로 정정.
5. /api/track allowlist schema 검증. 자유문자열·객체ID·회원ID 금지.
6. 비동의/분석동의/광고동의 파이프라인 분리(상세분석 동의≠맞춤광고 자동승격).
7. raw event 보존기간·집계전환·철회·계정삭제 삭제절차.
8. /admin/analytics: 권한감사·기초테이블 직접접근 차단·조회 audit·원시 drill-down 없음·CSV 원시 export 기본금지·소수셀 suppression.
9. GA4에 학과·학년 dimension·학번 HMAC 미전송, PII redaction, Google Consent Mode 4신호 제어.
10. 처리방침·Play Data Safety·App Store Privacy Label 실제와 일치.
11. **맞춤 스폰서는 만 18세 이상 확인 사용자만**, 미확인·미성년 일반광고, age-treatment 신호.
12. 광고주엔 집계보고만(픽셀·click ID·lead 별도 기능·동의 없이 금지).

## 추가 제안 (축소 아닌 확장 — GPT)
전환 퍼널(가입→인증→첫 핵심기능), 기능별 D1/D7/D30 재방문·휴면 전조, 학과·학년별 기능 채택속도, 검색어 정규화·무결과·재검색률, 지도안 단계별 중단률·평균원가·SR부족률, 게시판 공급/수요 불균형·질문대비 답변률, 알림 노출→열람→행동 전환, **기능별 서버비용·수익·유지율 합친 contribution dashboard**.

## 처리
- **분석/대시보드는 MUST 반영 후 활성화 가능**(사업자등록 불요). **맞춤 스폰서 광고는 사업자등록(business readiness) + MUST 후.** → 순서: 학번 인증단계 이동 + 3층 동의 + 자체 대시보드/집계 먼저 → 광고는 사업자등록 후.
