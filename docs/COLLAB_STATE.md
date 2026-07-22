# 협업 상태 원장

> 규범은 `COLLAB_PROTOCOL.md`. 이 문서는 **지금 무엇이 어떤 상태인가**만 적는다.
> 각 항목에 근거 주체와 시각을 붙인다 — 시각이 다른 증거를 한 상태처럼 섞지 않기 위함.
>
> 최종 갱신 2026-07-21

## 소유자 대전제 (2026-07-22, 본인 요청으로 기록)

> **"그저 내가 하고싶은건, 내가 아이디어를 내고 잠들면,
>  아침엔 그게 구현이 돼서 적용되어있는걸 바랄뿐이야"**

원하는 모델은 **바지사장**이다. "최대한 내 권한을 이양하고 싶다."
따라서 이 규약의 목적은 **승인 횟수를 늘리는 것이 아니라, 사전에 넓게 승인받고
되돌릴 수 있게 만들어 밤사이 자율 진행을 가능하게 하는 것**이다.
게이트를 추가하고 싶을 때는 먼저 "이걸 envelope 로 미리 받아둘 수 없나",
"되돌릴 수 있게 만들어 승인을 대체할 수 없나" 를 묻는다.

## 소유자 오버라이드 기록 — 부트스트랩 범위 (2026-07-22)

GPT 판정(P-20260722-ONE_SHOT_BOOTSTRAP_COMPLETENESS_REVIEW_01)은 다음이었다.
- 토큰 일괄 수집 마법사 = BLOCKER
- Supabase PAT = 소유자 계정과 동일 권한, 기본 사용 금지
- `PROD_DB_URL` 존재는 선례가 아니라 **줄여야 할 빚**
- 미래 provider 키 선수집 = 기각

**소유자가 이를 인지한 상태에서 명시적으로 기각했다.** 원문:

> "그냥 받아가. (…) 이거 무슨말인진 알지 당연히 알지. 근데 이 판단때문에
> 향후에 내가 엄청나게 불려다니고 고통받을걸 생각하면 그냥 다 받아가면 좋겠어.
> 지피티 말중에 지금 원래 니 계획보다 범위가 좁혀지는건 내가 reject 할게
> 명시적으로. 오히려 지피티의 규제를 느슨하게 푸는 방향만 허가할게"

판정: `OWNER_AUTHORIZED` — 소유자가 위험을 이해하고 자신의 비용(반복 호출)과
견주어 선택했다. 이는 GPT 판정을 몰래 무시한 것이 아니라 authority 의 override 다.

**따라서 유효한 규칙:**
- GPT 의 검수 의견 중 **범위를 좁히는 방향**은 소유자 승인 없이는 채택하지 않는다
- GPT 의 의견 중 **규제를 느슨하게 하는 방향**만 즉시 반영 가능
- 이 규칙은 부트스트랩·자율성 범위에 한한다. 데이터 파괴·보안 경계 관련
  BLOCKER 는 여전히 유효하다 (소유자가 "7·9번은 이해한다" 며 결제·앱스토어를
  제외한 것과 같은 취지)

**Claude 가 소유자 개입 없이 자체 부담하는 완화책** (소유자에게 요구하지 않는다):
- PAT·토큰 사용을 **프로젝트 고정 래퍼**로만 허용 — 다른 project/org 를 대상으로
  하는 호출은 래퍼가 거부. 실수로 인한 오대상 변경을 기계적으로 막는다
- 각 토큰의 폐기 경로를 문서에 링크로 유지 (사고 시 소유자는 그것만 누름)
- 보호된 실행기는 야간 작업으로 계속 구축하고, 완성되면 토큰을 그쪽으로 옮긴다

## 야간 자율 실행 범위 (NIGHT ENVELOPE)

> 목적: 소유자를 **매번 승인하는 자리에서 빼는 것.**
> 소유자는 authority 이지 reviewer 가 아니다. 아침 보고서가 인터페이스다.

**야간 진행 가능한 변경의 정의** — 행위 이름이 아니라 *실제 영향*으로 판정한다.
① 보호된 사용자 상태를 직접·간접으로 파괴하지 않고 ② 신원·인가·보안 신뢰경계를
바꾸지 않으며 ③ 외부·금전·법적 효과를 만들지 않고 ④ 영향 범위가 사전에 제한되며
⑤ 실측 가능한 rollback 또는 즉시 차단 수단이 준비된 변경.

| 등급 | 예 | 야간 규칙 |
|---|---|---|
| **N0** 비운영 | 로컬 구현·테스트·문서·리팩터·flag 뒤 미배포 코드 | Claude 자체검증. 자유 진행 |
| **N1** 가역적 운영변경 | DB·auth·외부효과 없는 UI 개선, 하위호환 API, 즉시 끌 수 있는 기능, 직전 SHA 복귀 가능한 배포 | batch 단위로 GPT 사전 도전 → 배포 후 smoke·에러율 검증 → 실패 조건 시 자동 flag off |
| **N2** 상태 변경 | 추가형 호환 마이그레이션, 격리된 파생데이터 적재, 내부 Cron | 항목별 독립 검수 + **Claude·GPT 2-key PASS**, 한 번에 하나, 실행 후 불변식 재측정 |
| **N3** 제외 | 아래 금지 목록 | 야간 실행 안 함. pending 후 다른 일 |

**야간 금지 (N3)**
- 사용자·보호 데이터: posts·comments·members·verification_requests 삭제/대량변경,
  auth.users 변경, 개인정보·인증자료·신고·제재·감사로그 변경, Storage 원본 삭제,
  보존기간·백업 정책 변경, source-of-truth bulk rewrite
- 인증·권한·보안: role·grant 변경, RLS 해제·정책 변경, 권한 확대,
  SECURITY DEFINER 경로 변경, secret 노출·삭제·교체, 인증 우회·약화
- 저가역 DB: DROP TABLE/COLUMN, 파괴적 타입 변환, 대규모 rename,
  데이터를 지우는 down migration, 검증 안 된 snapshot restore, 장시간 lock
- 외부·금전·법적: 메일·푸시·웹훅 발신, 유료 리소스 활성화, 결제,
  DNS·도메인·스토어, 약관·처리방침, 제3자 데이터 전달
- 복구 기반 파괴: 백업·rollback artifact·감사 증거 삭제

**사전 승인된 긴급 차단** (야간 우리 변경이 장애를 냈을 때)
해당 flag 끄기 · 해당 Cron 중지 · 직전 호환 SHA 로 rollback · 신규 모듈 트래픽 차단.
**DB snapshot restore 는 포함하지 않는다** — 그 사이 생긴 새 데이터를 잃는다.

> ⚠️ **현재 제약**: 보호된 실행기가 없으므로 **N2 의 DB mutation 은 아직 야간
> 자율 대상이 아니다.** 코드·UI·무상태 배포는 야간 진행하고, DB 변경은 초안·
> dry-run 까지만 하고 pending. (GPT 라운드 1 판정)

## 소유자 확정 결정

| 항목 | 결정 | 근거 |
|---|---|---|
| **Decision A — 협업 규약 canonical 채택** | **승인** | OWNER_DECIDED 2026-07-22 |
| **부트스트랩 범위 — GPT 축소안 기각** | **전부 수집 (Supabase PAT 포함)** | OWNER_DECIDED 2026-07-22 (아래 참조) |
| Decision B — hardening 조사·설계 | 재설계 중 (자율성 우선 방향으로) | OWNER_DECIDED 2026-07-22 |
| 과목 마스터 1,267건 | **롤백하지 않음. 동결 유지** | OWNER_DECIDED 2026-07-21 |
| 이메일 도메인 제한 | 폐기 예정 (v2 RFC). 단 인증 동작 후 | OWNER_DECIDED, RFC |
| 배포 플랫폼 | Vercel + Supabase 유지 | OWNER_DECIDED |
| GitHub 푸시 | 사전승인 면제 (운영 배포·병합은 제외) | OWNER_DECIDED 2026-07-20 |
| **L3 를 만났을 때** | **막힌 항목만 pending 으로 걸고 나머지 작업은 계속 진행.** workstream 전체를 멈추거나 소유자를 깨우지 않는다 | OWNER_DECIDED 2026-07-22 |

## 활성 작업 상태

| 작업 | 상태 | 근거 종류 | 비고 |
|---|---|---|---|
| 인증 파이프라인 코드 | `CODE_WRITTEN` | MEASURED (빌드·테스트 130/130, 2026-07-21) | |
| 인증 fail-closed 경로 | `LOCAL_VERIFIED` | MEASURED (세 라우트 503 + no-store 실측) | |
| 인증 exact-byte TOCTOU | **CLOSED** — `EXACT_VALIDATED_BYTES_IDENTITY=PASS`, `VERIFIED WRITE INTEGRITY CHECK=PRESENT` | GPT 판정 2026-07-22 (P-20260722-COLLAB_RETRO_ROUND_2_REVIEW_01). 근거는 Claude 가 보고한 코드 경로에 대한 설계 판정 — **GPT 독립 재실측 아님** | |
| 인증 동시 finalize | **NOT PASS (미해결)** | 자진 보고 + GPT 판정 | claim 전이·DB 락 없음 |
| **6A 전체** | **PARTIAL PASS — 동시성 보강 필요** | GPT 판정 2026-07-22 | exact-byte 는 닫혔으나 concurrency 미해결 |
| 인증 운영 E2E | `NOT_VERIFIED` | — | 시크릿 미등록 |
| 과목 마스터 1,267건 | `FROZEN_IN_PLACE` / `NOT_ACCEPTED_AS_CANONICAL` | MEASURED (증거 패키지) | 추가 적재·prune·merge 금지 |
| 강의평가 flag | **OFF (유지 필수)** | — | |
| 015 도메인 폐기 | `SQL_DRAFTED` | — | 인증 동작 전 적용 금지 |
| §9 배치 4종 | `CODE_WRITTEN` (기존 구현) | MEASURED (RPC 12종 존재) | Cron 미활성 |
| Cron | **비활성 (유지)** | — | 활성화는 소유자 승인 |

### pending 마이그레이션 (2026-07-22 야간 갱신)

누적 dry-run **PASS 7/7**, 롤백 후 운영 스키마 37/118/20/17 로 적용 전과 동일함을
실측했다. **전부 `APPLICATION AUTHORITY = NONE`** — 적용은 소유자 승인 후.

| 파일 | 상태 | 증거 | 비고 |
|---|---|---|---|
| 015 도메인 폐기 | `SQL_DRAFTED` | dry-run PASS | 낮에만. 야간 수정 금지 |
| 016 강의평가 쓰기·조회 | `SQL_DRAFTED` + `DRY_RUN_VERIFIED` | 함수 +4 | **통계 결함 수정 포함**(아래) |
| 019 실습학교 배정 | `SQL_DRAFTED` + `DRY_RUN_VERIFIED` | 테이블 +1 함수 +8 | 화면 있음, flag OFF |
| 020 finalize claim | `SQL_DRAFTED` + `DRY_RUN_VERIFIED` | 테이블 +1 함수 +10 | ⚠️ **라우트가 이미 의존한다** |
| 021 고아 탐지 RPC | `SQL_DRAFTED` + `DRY_RUN_VERIFIED` | 함수 +12 | 읽기 전용. 삭제 함수 없음 |
| 022 화폐 분리 | `SQL_DRAFTED` + `DRY_RUN_VERIFIED` | 함수 +13 트리거 +1 | 유료 기능 0개인 지금이 최적기 |
| 023 AI SR 차감 | `SQL_DRAFTED` + `DRY_RUN_VERIFIED` | 테이블 +2 함수 +15 | **022 뒤에** 적용. flag OFF |

> ⚠️ **020 은 배포 순서가 걸려 있다.** `/api/verification/finalize` 가
> `svc_claim_verification_finalize` 를 호출하도록 이미 고쳐져 있다.
> **마이그레이션 → 배포** 순서를 어기면 학생 인증 제출이 전부 실패한다.
> (2026-07-22 시점 커밋·배포 안 함. 작업 트리에만 있음.)

> 023 은 022 의 `currency` 컬럼을 쓴다. **022 → 023** 순서 필수.

## 소유자 승인 (2026-07-22 — AUTHORIZATION, 채팅 직접 발화)

> **소유자가 2026-07-22 채팅에서 A~G 전부 명시 승인.** goal 모드로 실행 착수.
> 이는 AUTHORIZATION 기록이다(재측정 대상 아님). 실행 절차·안전레일·진행상태는
> `docs/GOAL_MODE_WORKORDER_2026-07-22.md`가 원본. 아래 표는 그 매핑.
>
> | 승인항목 | pending | 안전레일 |
> |---|---|---|
> | A 020→배포 | 020 | 적용 후 배포(순서 절대). GPT 검수 선행 |
> | B 016 | 016 | 강의평가 flag OFF 유지 |
> | C 019+flag | 019 | practicumPlacement ON |
> | D 021 | 021 | 읽기전용, 삭제함수 없음 |
> | E 022→023+flag | 022,023 | 022 먼저. aiCreditCharge ON |
> | F 015 | 015 | **N3 — 소유자 입회, 마지막.** 자율 금지 |
> | G 사업자등록 | — | 소유자 사업 판단(내 실행 아님) |
>
> **승인으로도 안 풀리는 것**: 시크릿 값 입력(§아래 1·2), GPT 검수는 적용 전,
> F는 소유자 입회, 유료 v3 A/B는 별도 승인. flag는 코드(features.js)라 배포 동반.

### 여전히 소유자 손이 필요 (승인과 무관하게 기계적으로 내가 못 함)

1. `SUPABASE_SECRET_KEY` 등록 — `npm run verify:setup` (TTY 전용, 소유자만 실행 가능).
   ※ 앱이 이미 live 이므로 A~E 엔 신규 시크릿 불요 추정 — Phase 0 에서 확인.
2. Vercel 환경변수 등록(필요 시). 3. Cron 활성화 · 고아 객체 실제 삭제 · purge 실행.

> A~G 실행 항목(020 적용·배포, 016/019/021/022/023 적용, flag)은 위 승인표로
> 이관됨 — `GOAL_MODE_WORKORDER_2026-07-22.md` §4 가 실행 원본.

## 운영 변경 진입점 인벤토리 (READ-ONLY 조사, 2026-07-22)

> 강제 수준 표기는 `COLLAB_PROTOCOL.md` §3-2. **자격증명 값은 적지 않는다** —
> 존재 여부·권한 범주·보관 위치 유형만.
>
> ⚠️ 이 목록은 **핵심 집합이지 완전한 집합이라고 증명되지 않았다.**
> 부재 주장을 하려면 모집단을 먼저 정의해야 한다 (§4-1).

**강제 수준은 두 칸으로 나눠 적는다** (GPT 라운드 4 교정).
`LOCAL` = 그 도구를 실제로 썼을 때 장치가 거부하는가 /
`SYSTEM` = 같은 행위를 다른 도구·자격증명·제어면으로 할 수 **없는가**.
**한 경로에 장치가 있다는 사실을 보호대상 전체의 기계적 강제로 승격하지 않는다.**

| 변경 종류 | 승인 경로 | 현재 신원 | 자격증명 추출 | LOCAL | SYSTEM | 구멍 |
|---|---|---|---|---|---|---|
| 운영 DB 데이터 | `prod-*.mjs` (dry-run 기본 + `--apply`) | `postgres` (전권) | **가능** (평문 파일) | 부분 | `PROCEDURAL_ONLY` | 같은 자격증명이 도구 밖에서 쓰인다 |
| 운영 DB 스키마 | `prod-apply-migration.mjs` | `postgres` | 가능 | 부분 | `PROCEDURAL_ONLY` | + 대시보드 SQL Editor 미측정 |
| 진단·조회 | `connectProd()` 세션 read-only + reason 요구 | `postgres` | 가능 | **`MECHANICAL`** (25006 실측) | `PROCEDURAL_ONLY` | 직접 Client 생성으로 우회 가능 |
| 시크릿 등록 | `setup-verify-secret.mjs` TTY 전용 | 소유자 입력 | — | `MECHANICAL_VS_NON_TTY_INPUT` | `PROCEDURAL_ONLY` | **아래 주 참조** |
| Storage — 사용자 기능 | 서버 라우트 `/api/verification/*` | service_role | 서버 env | 배포 코드+인가가 envelope | (§3-3 런타임) | 건별 승인 대상 아님 |
| Storage — 운영자 조작 | (없음) | service_role / 대시보드 | 서버 env | 없음 | `PROCEDURAL_ONLY` | 대시보드·CLI·임시 스크립트 |
| Cron 배치 | `/api/maintenance?job=…` | service_role | 서버 env | `CRON_SECRET` 인증 = `MECHANICAL` | `PROCEDURAL_ONLY` | 인증은 막아도 **승인 여부는 판단 못 함**. 현재 비활성 |
| Vercel env·flag | 대시보드 | 소유자 | — | 없음 | `NOT_COVERED` | 에이전트 접근 경계는 미측정 |

> **주 — 시크릿 등록 분류를 정정했다.** 처음에 "에이전트 기준 MECHANICAL" 이라
> 적었으나 과장이었다. TTY 거부 실측으로 증명되는 것은 *이 도구를 통한
> 비-TTY 입력 차단*뿐이다. 증명되지 **않은** 것: 에이전트가 PTY 를 열 수 없다,
> 에이전트가 `.env.local` 을 직접 못 고친다(**실제로는 고칠 수 있다 — 2026-07-21
> 에 HMAC 키를 그렇게 기록했다**), 다른 스크립트로 같은 상태를 못 바꾼다,
> 대시보드에서 못 바꾼다, 기존 값을 삭제·손상 못 한다.
> 따라서 `MECHANICAL_VS_AGENT = NOT DEMONSTRATED`.
> 실제로 성립하는 성질은 **"소유자가 직접 입력하므로 에이전트가 값을 보지 못한다"**
> 이지 "에이전트가 시크릿 상태를 못 바꾼다" 가 아니다.
>
> `MECHANICAL` 이라 쓸 때는 반드시 함께 적는다:
> `ENFORCEMENT_SCOPE` / `ENFORCED_ACTOR` / `BYPASS_CAPABILITY` /
> `THREAT_MODEL` / `RESIDUAL_PATH`

**외부 제어면 (Supabase 대시보드·CLI·Management API, Storage 대시보드)**
`IDENTIFIED` / `EFFECTIVE PERMISSIONS = NOT MEASURED` / `CONTROL STATUS = NOT_COVERED`.
"제품에 기능이 있다" 와 "이 계정에서 누가 실제로 쓸 수 있다" 는 별개의 증거다 —
후자를 측정하지 않았으므로 "존재하지만 통제되지 않는다" 고 단정하지 않는다.

**조사 결과 (MEASURED 2026-07-22)**
- `PROD_DB_URL` 을 읽는 파일 43개 — 전부 `.env.prod.local` 경유
- `SUPABASE_SECRET_KEY` 참조: 서버 코드 3개 + 스크립트 5개 + 빌드 산출물
- **클라이언트 번들(`.next/static`)에 시크릿 이름조차 없음** — 유출 없음 ✔
- CI/CD workflow 없음, Edge Function 없음 → 그쪽 진입점은 현재 부재
- `vercel.json` cron 4건 (비활성)

**⚠ 이름이 오도하는 도구 (2026-07-22 실측)** — 아래는 `diag-` 접두사이지만
운영 데이터를 **쓴다**. 읽기 전용으로 오인하지 말 것.
`mutate-auth-role.mjs`(SET ROLE, 현재 권한 부족으로 실패) ·
`mutate-signup-path.mjs`(auth.users UPDATE) · `diag-orphan-users.mjs`

**핵심 판정:** 직접 SQL 은 `PROCEDURAL_ONLY` 다.
`ROUTINE USE FORBIDDEN` / `BREAK_GLASS 설계 미착수`.
**"모든 변경 경로가 기계적으로 막혀 있다" 고 보고하지 않는다.**

## 미해결 결함

| 결함 | 심각도 | 상태 |
|---|---|---|
| 동시 finalize 시 claim 전이·DB 락 부재 | NON_BLOCKING_DEFECT | **수정본 작성됨 → `pending/020`** (`SQL_DRAFTED`+`DRY_RUN_VERIFIED`). ⚠️ **재현 실증은 못 했다** — 운영 DB 에 인증 신청을 만들어야 해서 야간 범위 밖. 근거는 코드 분석뿐 |
| 011 이 항목별 denominator 가 아니라 전체 k 로만 게이트 | NON_BLOCKING_DEFECT | **수정본 작성됨 → `pending/016` 안의 `course_review_stats` 교체** (`DRY_RUN_VERIFIED`). 응답 모양이 바뀐다(분포가 `items` 아래로) — flag 켜기 전 화면을 맞출 것 |
| **지도안 생성이 SR 을 안 깎는다** | 신규 발견 2026-07-22 | 018 예산 상한은 "지갑 총액" 만 정한다. 개인별 제한이 없어 한 계정이 하루치(약 227건)를 소진 가능 → `pending/023` + `aiCreditCharge` flag (OFF) |
| `/schedule` 라우트에 도달 경로 없음 | 사소 | `/calendar` 가 상위 호환으로 보이나 **삭제는 미판정**. 별도 작업으로 분리 |
| 강의평가 자유서술·operator 승인 큐 없음 | 의도적 v1 제외 | GPT APPROVE |
