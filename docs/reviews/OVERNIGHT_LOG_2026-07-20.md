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
1. **SNUE 학번 형식** (자릿수·구조) — §4.1 학번 정규화 규칙 확정에 필요, Gate 4a 전 확인 항목.
2. **Gate 4a 착수 승인** — dev 리허설 시작 여부 (운영 초기화는 그 뒤 별도 재확인 단계 있음).
