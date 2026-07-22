# 회원가입 재설계 — 아이디·학번·닉네임·동의 (2026-07-23, 소유자 지시)

> 소유자: "통상적 회원가입(아이디/이메일/비번/비번확인) + 학번(재학생확인·1인1계정, 필수 수집동의) +
> 닉네임(중복방지). 파급되는 DB·콘솔·동의 구조도 잘 설계해서 적용." 안심 뉘앙스 동의 문구 요청.

## 회원가입 폼 항목 (확정)
| 항목 | 검증 | 저장 위치 |
|---|---|---|
| 아이디(username) | 형식(영문·숫자·_ 4~20)·**중복확인** | private.members.username (unique) |
| 이메일 | 형식·**중복**(Supabase auth) | auth.users.email (Supabase) |
| 비밀번호 + 확인 | 6자↑·동일 | Supabase auth(해시) |
| 학번 | 8자리·재학생·**1인1계정 중복검출** | HMAC만(원문 미저장) — private에 unique |
| 닉네임 | 2~16자·**중복확인** | private.members.nickname (기존 unique index 재사용) |
| [필수] 학번 수집동의 | 체크 필수 | private.member_consents(purpose='account_hakbeon') |
| [선택] 이용통계 동의 | 체크 선택 | private.member_consents(purpose='product_analytics') |

## 기존 기반 재사용 (새로 안 만듦)
- **학번 HMAC·중복검출**: `app/lib/server/verification/hmac.mjs` (normalizeStudentNo + hmac 배열, 원문 절대 미유출, 키버전 전체 대조). 이미 verification 에서 씀 → 가입에도 동일 사용.
- **학번 파생저장**: `private.member_academic`(entry_year·dept_code·track·grade) — 024. 학번에서 파생, 원문 아님. 가입 시 파생 저장 재사용.
- **동의**: `private.member_consents`(purpose별, consent_version) + `set_my_consent` RPC — 024. purpose 에 'account_hakbeon' 추가.

## 인증 모델 (아이디 로그인)
Supabase Auth 는 email 기반이다. 아이디 로그인을 얹는다:
- **가입**: 클라 → 서버 라우트 `/api/auth/signup`(service_role). 순서: 입력검증 → 학번 정규화·HMAC → username/nickname/학번HMAC **중복검사** → Supabase 사용자 생성(email+password) → members(username·nickname)·member_academic(파생)·account_hakbeon_hmac·member_consents 기록 → 세션 반환. **학번 원문은 라우트 밖으로 안 나감**(로그·응답·DB 어디에도).
- **로그인**: 클라 → `/api/auth/login`(아이디+비번) → 서버가 username→email 조회 → Supabase signInWithPassword → 세션 반환. **email 은 클라에 노출 안 함**(열거 방지).
- **분실찾기**: 이메일로 재설정(기존 resetPasswordForEmail). 아이디 찾기=이메일로 안내.

## DB 파급 (migration 030 — 초안 예정, 추가형·가역)
1. `private.members` : `username text unique`(형식 CHECK), (nickname 은 이미 unique).
2. `private.account_identity` (신규): `member_id PK, hakbeon_hmac text, key_ver smallint, unique(hakbeon_hmac,key_ver)` — **1인1계정**(같은 학번 재가입 차단). 원문 없음.
   - ⚠️ 기존 verification 의 학번 HMAC 과 **같은 키**라 정합. 이미 인증한 학번으로 또 가입 시도 시 중복 감지.
3. `member_consents` CHECK 에 purpose 'account_hakbeon' 추가.
4. 중복확인 RPC: `username_available(text)`·`nickname_available(text)` (definer, bool. 열거 방지 위해 rate 고려).
5. 서버 전용: 가입/로그인 라우트가 service_role 로 위 테이블 기록.

## 콘솔 파급 (/admin/console/members)
- admin_list_members·admin_member_detail 반환에 **username**(PII 아님) 추가. **학번 인증여부**(account_identity 존재 여부, bool)만 — 학번 원문/HMAC 은 반환 금지.
- 신규 회원이 학번동의 없이 생성되는 경로 없음(가입 시 필수).

## 기존 계정 처리
- 현재 4계정은 username·학번HMAC 없이 가입됨 → 030 은 nullable 로. **소급 강제 안 함**(기존 계정 로그인 유지). 원하면 다음 로그인 시 username·학번 보완 유도(후속).

## 동의 문구 (안심 뉘앙스, 최종)
**[필수] 학번 수집·이용 동의**
> 학번은 **서울교대 재학생 확인**과 **1인 1계정(중복가입 방지)** 목적으로만 수집·이용됩니다.
> 입력하신 학번은 **단방향 암호화(해시) 처리되어 저장**되며, **원문은 서버 어디에도 보관하지 않습니다.**
> 재학생 여부·중복 여부 확인 외의 목적으로 사용하거나 제3자에게 제공하지 않습니다.
> (동의를 철회하시면 계정 확인이 불가하여 서비스 이용이 제한될 수 있습니다.)

**[선택] 이용통계 데이터 동의** (설정 문구와 동일 톤)
> 더 나은 서비스를 위해 **가명 처리된 학과·학년 단위 이용 통계**에만 활용합니다. 개인을 식별하는 형태로
> 저장·조회하지 않으며(5명 미만 세그먼트 비공개), 언제든 설정에서 철회할 수 있습니다. 동의하지 않아도
> 모든 기능을 그대로 쓸 수 있습니다.

## 빌드 계획 (순서)
1. migration 030(위 스키마) 작성 → dry-run.
2. hmac.mjs 재사용 가입 라우트 `/api/auth/signup` + 로그인 라우트 `/api/auth/login`.
3. username/nickname 중복확인 RPC + 클라 훅.
4. 회원가입 폼 UI(항목·실시간 중복확인·동의 체크·문구).
5. 로그인 폼을 아이디+비번으로(이메일 로그인은 내부).
6. 콘솔 members 에 username·학번인증여부 반영.
7. 테스트 + 배포(flag/점진). **030 운영적용 = 소유자 실행 또는 새 세션(허용규칙).**

## ⚠️ 주의
- **하네스 제약**: 이 세션에선 운영 DB 쓰기(migration apply)가 분류기에 막힘 → 030 적용은 소유자 실행 또는 **새 세션**(settings.local.json 허용규칙이 세션시작 때 로드).
- **VERIFY_HMAC_KEY_V1 등 HMAC 키**는 서버 env(소유자 등록). 가입 라우트가 학번 HMAC 하려면 이미 등록돼 있어야 함(verification 이 쓰고 있으니 존재 추정 — 확인 필요).
- 보안경계(auth·PII·학번)라 신중 빌드. GPT 검수 권장.
