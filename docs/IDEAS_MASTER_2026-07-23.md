# SNUE 앱 — 아이디어·구상 총정리 마스터 (2026-07-23)

> 소유자 지시: 흩어진 디자인md·구상안 **싸그리 발굴**. 컴팩에 묻힌 것까지.
> 출처: `BACKLOG_남은목록.md`·`PRACTICUM_QUESTION_PACK.md`·`MODULES.md`·design.md 발췌·이번 세션 논의·메모리.
> 표기: ✅라이브 · 🟡계획확정(미구현) · 🔜다음착수후보 · 🔲남음 · ⏸️대기(선행조건) · ❌안함(확정)
> ⚠️ "파일 있음 ≠ 라이브". 상태는 배포/flag/DB 실측 기준.

---
## 0. 이번 세션(2026-07-23) 산출물
- ✅ 회원가입 대개편(아이디·학번HMAC·닉네임·동의·아이디로그인) · ✅ 통합 콘솔(회원·이용권·역할·삭제·메모)
- ✅ 지도안 저장/불러오기 · ✅ 자랑배너(실측 정정) · ✅ 숨은기능(스크랩·알림함) · ✅ 이모지금지 · ✅ 생성권 개방
- ✅ **지도안 DOCX 내보내기** · ✅ **HWPX 베타**(서식 채우기, 겹침수정) · ✅ **지도안 생성 분석 콘솔**(035)
- ✅ AI 모델 레지스트리 1단계(메타·availableModels)
- 🟡 **게시판 관리 콘솔**(계획확정: Phase1 CRUD + Phase2 B전부·C전부·D1245·E전부·F전부 · Phase3=G1~8) — `BOARD_CONSOLE_PLAN`
- 🟡 **HWP 폼 다양화 + 사용자 업로드 커스텀폼**(스타일입히기 0원/칸맞춤 폼당1회) — `HWP_EXPORT_RESEARCH` 백로그
- 진행중(로컬 GPT): 출판사별 목차·지도서 데이터 수집(균형·OCR·총차시 규칙) — `PACKET_local_GPT_data_improvements`

## 1. 🎓 실습모드 (소유자 핵심 관심 — 아직 큰 게 안 됨)
- 🔜 **최적 실습학교 찾아주기/지망 도우미** — 지도API(카카오/네이버)로 **출발지(역 단위)→최소환승·거리** 기준 실습학교 최적 나열, 지망순위 도움. flag `practicumSchoolAdvisor`, 지도키=소유자. **← 아직 미구현(백로그 §0 최우선).** 상세 [[snue-practicum-advisor-initiative]]
- 🔜 **실습학교 목록 정정** — `practicumSchools.json`이 HWP 최소파서라 불완전(**신용산초 누락**). 정식 협력학교 목록으로 교체(도우미 전제).
- 🔜 **관리자 업로드 파이프라인**(백로그 §7.5, GPT가 catalog 착수) — 실습학교 명단 업로드기(HWP/xlsx→파싱→**검수 미리보기**→확정) + 수강시간표 업로드기. "파일만 주면 알아서 DB로."
- 🔲 **지망 경쟁률 여론조사** → 학교정보·교통·후기 → **배정 후 "교환 원함" 매칭(돈 없이 의사만, C안 확정)**. 금전중개는 ❌(리스크).
- 🔲 **실습학교 평점**(학교 단위만, 지도교사 개인 ❌ — 특정 위험) · 공개 임계 **작성자 5명**.
- ⏸️ **practicumPlacement**(실습학교 배정 게시) — `019` pending, 화면 있음. 원자적 게시게이트+레이트리밋+catalog 선행.
- 🔲 실습모드 진입 = 별도 탭 + 실습기간 자동 앞노출, 1학년 숨김. (급식·연락처·준비물·타임라인은 이미 동작)

## 2. 📝 지도안(AI) 고도화
- 🟡 **AI 모델 선택 + 모델별 SR가격 + API키 콘솔**(§3 2단계~6) — `AI_MODELS_AND_SR_ECONOMY_DESIGN`. 무한확장·메뉴판·폰딸깍 키관리.
- 🔲 **교과서/지도서 데이터 완성**(로컬 GPT 진행) → 재배포 시 출판사 정밀도↑.
- 🟡 **출판사 상위 선택기 UI**(단원중복 해소) — GPT page.js 커밋 후 착수. `PACKET_publisher_selector`
- 🔲 지도안 분석 **클라 내보내기 보고 배선**(export 컬럼 채우기) + **약안 run_id 체인 정밀화**(현재 서버 best-effort).
- 🔲 HWP **실서식(약안/세안 .hwpx)** 채우기 + **서식 선택 UI**(레지스트리).
- 🔲 v3 프롬프트(오답+되돌리기) A/B 채택 여부 · PDF 내보내기.

## 3. 💰 분석·수익화 + 분필(SR) 경제
- ⏸️ **productAnalytics 대시보드 켜기** — 동의UI·처리방침 문구 확정 후. (기록계층·GA4 G-T287… 라이브)
- ⏸️ **맞춤광고 targetedAds** — 전부 구현·휴면, **사업자등록 후** flag ON. 게시판별 광고 타게팅(E3/E4)과 연동.
- 🟡 **SR(새록) 경제** — `POINT_ECONOMY`·`AI_MODELS…§D`. **화폐명 = SR(새록)** 확정(※실습질문팩의 "분필"은 폐기된 옛 제안). 벌기(강의평·추천·광고·…) / 쓰기(지도안 모델별·후기열람). 현금화·양도 불가. `CURRENCY_SPLIT_DESIGN`(SR/유료/마켓결제 분리).
- ⏸️ **aiCreditCharge flag ON** ← durable 상태기계(023, timeout 영구차감 방지) 선행.
- 🔲 결제: 광고 리워드 포인트로 시작, 현금(PG+사업자)은 코드만 만들고 스위치 OFF. `MONETIZATION_ADR`.

## 4. 🗣️ 커뮤니티 flag 활성화 (코드 있음, 선행필요)
- ⏸️ **강의평가 courseReview** ← 스냅샷 공개(차분공격 차단) + 과목마스터 적재. `COURSE_REVIEW_DESIGN`
- ⏸️ **학교후기**(신규, SR 적립원천) · 🔲 강의평가 **교수 중심 구조**(교수별 강의목록→평가, 크로스참조).
- 🔲 **강의별/교수별 톡방**.

## 5. 🌐 v2 소셜 대전환 (계정+백엔드 위, RFC 게이트)
- 🔲 공지 **댓글/대댓글/추천·비추/신고**(수정X 삭제O)
- 🔲 **쪽지**(허용설정) + **알림함/푸시** + **키워드 구독 알림**(단어 감지) + 개인 일정 알림
- 🔲 **친구 시간표** — 학기별 노출설정, 수업 누르면 **같은 수업 듣는 친구 목록**
- 🔲 홍보게시판 **상단고정 유료 노출**

## 6. 🛒 거래/마켓 (에스크로·결제 별도설계, 더 나중)
- 🔲 **장터**(교재·식권 — 급식화면 원터치 팔아요/구해요 스텁 有)
- 🔲 **족보/자료 거래**(즉시전달/에스크로 — 사기사례 有) · `MEAL_TICKET_MARKET_DESIGN`
- 🔲 **기숙사 거래/룸메이트 매칭**(1인실 교환·성향매칭)
- 🔲 **대타(알바) 게시판**(실습기간 대타수요, 학사일정 타이밍 알림)

## 7. 🧰 로컬 도구 (백엔드 0, 남은 것)
- 🔲 **캘린더 개선 2차**: 일정 종류별 숨김·막대모드 드래그핸들·헤더 로그인버튼
- 🔲 **과거 학기 시간표 저장**(4학기 데이터, localStorage 개편→마법사 자동제외·학점계산 연동)
- 🔲 **학점계산기 차트**(추이·분포) · 🔲 **e-Class iCal 연동 마무리**(색규칙 준비됨) · 🔲 **ICS 내보내기/불러오기**

## 8. 🖥️ 콘솔 모듈 로드맵 (게시판 Phase3 = G1~8)
G2 공지/PR배너편집 → G1 flag관리 → G3 모더레이션큐 · G4 버그접수함 → G6 강의평/학교후기관리 · G7 실습학교데이터관리 → G5 광고/스폰서관리 · G8 약관버전관리. (각 독립 모듈, 개별 계획서로 분할)

## 9. 📱 네이티브·인프라
- 🔲 **홈스크린 위젯**([[snue-app-widget-wish]]) · 외부링크 WKWebView 승격
- 🔲 Vercel 웹훅 자동배포 복구(현 Deploy Hook 수동) · 🔲 학교 정식 API 문의(e-Class·학생증)
- ❌ **학생증 출입 QR — 안 함(확정)**(키 은닉 불가·법 위반)

---
## 관련 설계 문서 지도 (docs/)
- 실습/수익화 질문·정책: `PRACTICUM_QUESTION_PACK` · `DATA_AND_MODERATION_CHARTER` · `MONETIZATION_ADR`
- 경제: `POINT_ECONOMY` · `CURRENCY_SPLIT_DESIGN` · `AI_MODELS_AND_SR_ECONOMY_DESIGN`
- 커뮤니티/모듈: `GATE3_DESIGN` · `MODULES` · `MODERATION_QUEUE_DESIGN` · `COURSE_REVIEW_DESIGN` · `MEAL_TICKET_MARKET_DESIGN`
- 이번 세션: `BOARD_CONSOLE_DESIGN`/`_PLAN` · `HWP_EXPORT_RESEARCH` · `LESSON_ANALYTICS_DESIGN` · `SIGNUP_REDESIGN` · `ADMIN_CONSOLE`
- 지도안 데이터: `LESSON_DATA_CONTRACT` · `PACKET_*`
- 운영/전환: `BACKLOG_남은목록`(원본 백로그) · `WORKORDER_2026-07-23_NIGHT` · `NATIVE_APP_PREP` · `VERIFICATION_PIPELINE` · `SOCIAL_LOGIN_SETUP`

> 이 문서는 **살아있는 목록**이다. 새 아이디어는 여기 + `BACKLOG_남은목록`에 추가.
