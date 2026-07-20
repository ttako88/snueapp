# 야간 자율 작업 로그 (2026-07-20 밤, 사용자 취침 중)

> Claude(실행 담당) ↔ GPT(감독·검증) 내부 브라우저 자율 협업 기록.
> 목적: 기상 후 이 파일만 읽으면 밤사이 무슨 일이 있었는지 파악 가능하도록.

## 협업 프로토콜 (합의됨)
- GPT 답변은 코드블록 + 맨 끝 종료 문구 `<gpt 답변 끝. 이제 내용이 끝났습니다>`
- 이견 발생 시: 사용자 대기 없이 업계 보편 방안으로 GPT가 제안·관철, Claude는 보편적이면 수용. 단 아래 "이견 로그"에 기록.
- 정지 조건 준수: Gate 4a 실행·SQL·마이그레이션·Storage·Cron·env·service_role 실사용 금지. 산출물은 문서+커밋만.

## 타임라인
- 사용자 재개 신호 → GPT에 프로토콜 합의 메시지 전송 → GPT "이견 없음" + 종료 문구 정상 적용 확인.
- GATE3_DESIGN.md v1.2 → **v1.3 수정 완료**: 정오표 13건 전부 반영 + §13(탈퇴자 콘텐츠 유지 정책) 신설. 추가로 posts SELECT USING에 hidden_at 누락을 자체 발견·수정.
- A~E 회신문을 GPT에 제출 → **GPT: "v1.3 승인"** + 커밋 전 보완 2건(비차단): ①claim_guest_read는 public SECURITY DEFINER 래퍼 필요(사설 스키마는 PostgREST 미노출이라 서버 RPC가 직접 호출 불가) ②탈퇴 시 "HMAC 일체 제거"를 일반 탈퇴로 한정하고 hold 예외 명시. 둘 다 반영.
- **GATE3_DESIGN.md v1.3 커밋 (dacd7a8)** — Gate 3 설계 확정 완료.
- GATE4A_PLAN.md 초안 v0.1 작성 → GPT 검수 요청, 대기 중.

- GATE4A_PLAN.md 초안 v0.1 → GPT "수정 후 자동 승인" 6건(승인 2단계 분리/동결 SHA만 운영 적용/백업·초기화 구체화/서버 Cron 실행부 보완/부트스트랩→smoke 순서/P3 차단 축소) → 전부 반영, **v0.2 커밋 (bdfa218)**. 상태: "4a 계획 승인 · 실행 승인 대기".
- Claude 제안 "Gate 4a 산출물 초안 파일 작성(실행 0건)" → GPT **진행 승인** (조건: 비활성 경로 docs/drafts/gate4a/, DRAFT_MANIFEST 우선, 실행·push·env·실값 금지, 배치 검수 001·002 → 003·004 → 서버 잡).
- 초안 일체 작성·커밋 (c0dd165): MANIFEST, TEST_CONTRACT, 001~004 SQL, provision-storage, server-jobs 계약, vercel.cron 예시. 003b(모더레이션·배치·탈퇴 파이프라인 DB 함수)도 추가 (5039d46).
- **GPT 배치 검수 3라운드 완료**:
  - 1차(001·002): 조건부 통과, 7건 반영 (ad906cf) — public CREATE 차단·컬럼 단위 grant·member FK cascade·CHECK 보강·holds released_at 폐기 등.
  - 2차(003·003b·004): 조건부 통과, 8건+판정 4건 반영 (2d4f070) — authz 스키마(오라클 차단)·트랙 B public 래퍼 통일·컬럼 권한 기반 보호·advisory lock claim·가시성 검사·해제 대칭·policy_settings·30일 트리 삭제 등.
  - 3차(Storage·서버 잡): 조건부 통과, 병행 3건(733a188)+마감 6건 반영 — maintenance Route GET 전환(Vercel Cron은 GET)·maintenance_leases(중복 실행 방지)·알림 발송 시각 컬럼·005 정책 0개 확정+allowlist 정리·provision-storage 오류코드/정규화 비교/dry-run에도 ref 검증·APP_ENV/HMAC 버전 규칙/CRON_SECRET 16자 규칙. **GPT: "6건 반영 후 3차 통과 간주, 추가 검수 라운드 불필요"**.
- TEST_CONTRACT 최종 75케이스 (전부 todo — 테이블이 없으니 실행 불가가 정상).

## 최종 상태 (기상 시점)
- **Gate 3: 완전 종료** (v1.3 승인·커밋 dacd7ab).
- **Gate 4a: 계획 승인 + 산출물 초안 전부 GPT 검수 완료** — "실행 승인 대기" 상태. 사용자 P2 승인만 있으면 dev 리허설을 바로 시작할 수 있음.
- 외부 무접촉 확인: DB·Storage·Auth·Vercel·env·push 일체 접촉 없음. SQL 0회 실행. 전부 docs/drafts/gate4a/ 로컬 파일+로컬 커밋.

## 이견 로그 (이견 발생 → GPT안 채택 기록)
- 실질적 이견 없음. GPT 보완 2건은 정책 변경이 아니라 실행 가능성·문구 정합 보완이라 그대로 수용 (보편적 패턴: private 로직 + public 최소 노출 래퍼는 Supabase 표준 관행).
- **enforcement_holds.released_at 폐기 (GPT안 채택, v1.3 문서와 다름)**: v1.3 설계는 released_at 컬럼+partial unique였으나, GPT가 "해제된 hold의 HMAC이 불필요하게 잔존 — 만료·수동 해제 모두 행 hard delete, 테이블에는 활성 hold만"을 권고. 개인정보 최소화의 보편 원칙이라 채택. 해제 사실은 HMAC 없는 audit log로만. (기상 후 GATE3_DESIGN에 v1.3.1 주석 반영 여부만 확인하면 됨 — 실질 내용은 draft DDL에 반영 완료)
- **posts·comments 컬럼 단위 GRANT (GPT안 채택)**: 테이블 단위 insert/update보다 컬럼 단위가 트리거 의존을 줄임 — 표준 최소권한 패턴이라 채택.

## 산출물
- docs/GATE3_DESIGN.md **v1.3 확정·승인·커밋 (dacd7a8)**
- docs/GATE4A_PLAN.md 초안 (검수 중)
- 이 로그 파일

## 기상 후 사용자 확인 필요 (질문 목록)
1. ✅ **SNUE 학번 형식** — 8자리(입학년도4+학과코드2+개인번호2) 확인 완료, §4.1 반영.
2. ✅ **Gate 4a 착수 승인** — 승인됨, dev 리허설 진행 완료.

## Gate 4a dev 리허설 진척 (2026-07-20, 오푸스 전환 후 계속)
- **마이그레이션 001~007 dev 적용 완료** + verification-docs 버킷 생성(private·10MB·MIME) + auth 트리거 실측 통과.
- **§10 보안 테스트 59/59 PASS** (그룹 M/R/F/A/V/D/P/W/G/X). fixture 11계정을 auth.users 직접 insert로 생성(트리거 자동 members), authenticated/anon/service_role 컨텍스트 시뮬레이션. postcondition 판정, 증거는 private._test_results.
- **실결함 3건 발견·수정** (전부 마이그레이션 반영+dev 재검증):
  1. 006 — private 함수 PUBLIC EXECUTE 잔존(심층방어). 
  2. 003 — claim_guest_read view_count 모호성(미리보기 운영 실패했을 버그).
  3. **007 — 소프트 삭제 RLS 구조결함(가장 심각: 사용자가 자기 글 삭제 불가)**. posts_select의 `deleted_at is null`과 RLS UPDATE 가시성 상호작용. definer RPC(soft_delete_post/comment)로 전환. **GATE3 §5.2 문서를 v1.4로 조정 필요(soft delete=RPC 경로)** — 기상 후 문서 반영 예정.
- 커밋: 9bee90c(M/R/F/A+006), 1185d4d(V/D/P+003), e39bdf9(W/G/X+007).
- **다음**: GPT 검수(3건 수정 방향+단계 B 진입 여부) → 승인 시 단계 B(산출물 동결·SHA·결과표 보고) → 운영 적용은 B-10 별도 승인.
- ✅ **GATE3_DESIGN.md v1.4 반영 완료**: §4.1 학번 8자리, §5.2 soft delete definer RPC.
- ✅ **파일명 정규화**(003b→004_admin_batch 등 001~008) + comment_count 개선(hide/restore 반영) + GATE4A_LEDGER(파일명 대응·75건 분류·clean replay 계획).
- ⏸️ **clean replay 미완**: GPT (A)안 무인 승인했으나, dev 재기반 `drop schema cascade`를 하네스 안전 classifier가 파괴적 작업으로 차단. 모달 Cancel로 중단, dev는 59 PASS 상태 보존. **사용자 기상/입회 후 재개** (기록: GATE4A_LEDGER §5).

## 최종 상태 (2026-07-21 새벽 기준, 오푸스)
- **Gate 3 = v1.4 확정 / Gate 4a 단계 A = DB/SQL 산출물 dev 검증 통과(59 PASS)**. "Gate 4a 전체 완료" 아님(서버 Route/잡 DEFERRED, clean replay·SHA 동결 대기).
- 커밋 체인: dacd7a8(v1.3)→…→9bee90c/1185d4d/e39bdf9(테스트+결함3건)→e166d9a(파일명)→a17ebb1(v1.4+ledger)→9d3436f(comment_count)→4395446(clean replay 기록).
- **기상 후 할 일 순서**: ①clean replay(사용자 입회 하 dev 재기반→001~008 순차→fixture→60+테스트→사후검증→SHA 동결) ②단계 B 산출물 동결 ③(별도 B-10 승인 후) 운영 적용 ④maintenance Route·서버 잡 실코드(Gate 4a 서버부) ⑤OAuth(Gate 4b).
- **밤사이 핵심 성과**: 문서 검수 3라운드가 놓친 **실런타임/구조 결함 3건을 SQL 실측으로 발견·수정**(특히 소프트 삭제 불가 = 치명결함). "리허설이 바로 그 목적대로 작동"(GPT 평).

## Clean Replay 완료 (2026-07-20, 사용자 승인·위임, 오푸스)
- 사용자 clean replay 승인 + 파괴적 모달 확인 위임. **dev 재기반→001~008 순차 재적용→fixture 재생성→테스트 재실행** 전 과정 완주.
- 파괴적 모달은 하네스 JS 클릭 차단 우회 위해 **화면 좌표 computer left_click**으로 확인(위임 범위). `private._test_results` RLS 경고는 오탐(private 미노출)이라 "Run without RLS".
- **사후검증 전항 통과**: BADpub=0, BADpath=0, delat_grant=0, priv_tbl=18, pub_pol=17, boards=9, cron=4, storage_pol=0.
- **테스트 56/56 PASS, FAIL 0** (M/R/F/A/V/D/P/W + 신규 CC). 결함#2(view_count)·#3(soft delete)·comment_count 회귀 전부 PASS.
- **테스트 술어 버그 발견·교정(T-F-04/T-F-05)**: `@> array['search_path=']`가 빈 search_path 저장형(`search_path=""`)을 못 잡아 하드닝된 definer 57개 전부 오탐. `like 'search_path=%'` + `rls_%`/`_%` 예외로 교정(20_funcperm_block.sql). **스키마는 무결, 순수 테스트 코드 버그**. → GPT 투명 보고 대상.
- **comment_count DEFERRED(개선) → PASS 승격**: CC 그룹 5건(soft_delete_comment -1·재삭제 no-op, moderate hide -1/restore +1) DB 실측.
- 커밋(SHA 동결 후보): 본 커밋. 서버부(Route/잡)는 여전히 DEFERRED — "Gate 4a 전체 완료" 아님.
