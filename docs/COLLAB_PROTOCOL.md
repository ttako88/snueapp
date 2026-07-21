# 협업 규약 (GPT ↔ Claude)

> 상태: **초안 (라운드 2)** — 확정 전. 라운드 3에서 GPT 합의 후 확정한다.
> 절차 매뉴얼은 `GPT_CLAUDE_WORKFLOW.md`, 이 문서는 **재발하는 오류를 막는 규칙**만 담는다.

## 0. 이 문서를 짧게 유지하는 이유

`GPT_CLAUDE_WORKFLOW.md` §2b 에 REVIEW_PENDING 잠금 규칙이 있다.
2026-07-20 에 "검수 요청해놓고 회신 전에 실행" 사고가 나서 만든 규칙이다.
그리고 2026-07-21, **같은 일이 또 났다** (과목 마스터 1,267건 적재).

즉 규칙이 없어서 재발한 것이 아니라 **규칙이 있는데도 재발했다.**
그래서 이 문서의 설계 원칙은 하나다.

> **실행자가 기억해야 지켜지는 규칙은 지켜지지 않는다.**
> 규칙은 가능한 한 도구에 박아 실행 시점에 걸리게 한다.

문서에만 있는 규칙은 §4 에 최소한만 두고, 나머지는 §3 의 기계적 장치로 옮긴다.
규칙을 추가하고 싶을 때는 먼저 "이걸 도구로 강제할 수 있나" 를 묻는다.

## 1. 권한 순서

1. 소유자(조상호)의 명시 결정
2. 이 문서 + `docs/COLLAB_STATE.md` 의 확정 상태
3. GPT 검수 판정
4. 실행자(Claude)의 판단

### 1-1. 권한 상태는 서로 다른 상태다 (추론 금지)

`REVIEWABLE` ≠ `TECHNICALLY_SAFE` ≠ `OWNER_AUTHORIZED` ≠ `EXECUTED` ≠ `VERIFIED`

**한 상태에서 다른 상태를 추론하지 않는다.**
"되돌릴 수 있다", "검수 PASS 다", "테스트가 통과했다", "도구가 안전하다",
"멈추지 말라고 했다" — 이 중 무엇도 운영 mutation 권한을 만들지 않는다.

> 2026-07-21 과목 적재 사고의 정확한 이름이 이것이다. 나는
> `TECHNICALLY_SAFE` 를 `OWNER_AUTHORIZED` 로 읽었다.

### 1-2. 소유자 부재 중 L3

```
OWNER ABSENCE DOES NOT GRANT L3 AUTHORITY.
PAUSE THE DEPENDENT BRANCH, CONTINUE INDEPENDENT SAFE WORK,
AND ESCALATE URGENTLY ONLY WHEN DELAY INCREASES ACTIVE HARM.
```

**"알아서 해" 는 판단 위임이지 승인 게이트 면제가 아니다.**
전체 작업을 멈추지 않는다. L3 에 **의존하는 분기만** mutation 직전에서 정지시키고,
막힌 항목은 pending 으로 걸고 독립적인 L1·L2 작업을 계속한다.
(OWNER_DECIDED 2026-07-22: "막힌 작업만 pending 으로 걸고 계속 작업 이어가는게 좋아")

허용: 원문·diff 작성, dry-run, read-only 측정, 테스트, rollback 계획,
증거 패키지, 승인 요청문 준비, L3 와 무관한 작업.

금지: 시크릿 등록, Cron 활성화, 운영 migration 적용, flag 활성화,
운영 데이터 적재·수정·삭제, 권한·보안 경계 변경,
**그리고 L3 를 여러 L2 로 잘게 쪼개 우회 실행하는 것.**

소유자를 즉시 깨우는 것은 **지연 자체가 피해를 키울 때만** — 진행 중인
데이터 손실·비밀 유출·무단 접근·운영 오염, 시간이 갈수록 복구가 어려워지는 사고.
그 경우에도 부재가 새 mutation 권한을 만들지는 않는다. 사전 승인된 긴급
containment 범위가 없으면 **현재의 안전 상태를 유지한 채** 알린다.

## 2. 위험 등급

| 등급 | 범위 | 승인 |
|---|---|---|
| **L1** | 로컬·가역·외부 상태 무변경 (문서, 로컬 테스트, 도구 작성) | 사후 통보 |
| **L2** | 코드 변경, 마이그레이션 초안, 외부 read-only 측정 | 실행 후 증거와 함께 보고 |
| **L3** | 운영 mutation, 삭제, flag 활성화, 보안 경계 변경, 시크릿, 사용자 노출 변경 | **사전 승인** |

오버레이 — 하나라도 붙으면 등급을 올린다:
**S**(시크릿·민감정보) **D**(파괴적·대량) **B**(보안 경계) **P**(운영 대상)

> 진단 도구 작성은 L1 이지만, 그 도구를 운영 DB 에서 돌리면 L2+P 이고,
> 원시 개인정보를 출력하면 L2+P+S 다.

**Bounded Execution Envelope** — 소유자가 미리 허용 행위·대상·최대 영향량·중단
조건·유효기간을 명시하면 그 안에서는 재승인 없이 실행한다. 조금이라도 벗어나면
실행하지 않고 묻는다.

## 3. 기계적 장치 (§0 의 핵심 — 문서가 아니라 도구가 막는다)

| 위험 | 장치 | 예 |
|---|---|---|
| 실수로 운영 변경 | **dry-run 이 기본값**, 실제 적용은 `--apply` | `prod-load-course-subjects.mjs` |
| 시크릿이 로그·에이전트로 샘 | **TTY 전용** — 파이프·CI·에이전트에서 실행 거부 | `setup-verify-secret.mjs` |
| 읽기 도구가 쓰기 | `begin read only` 로 감싼다 (DB 가 거부) | `diag-*.mjs` |
| 잘못된 대상 | 실행 전 project ref 검증, dev/prod 구분 | `prod-url.mjs` |
| 되돌릴 수 없는 적용 | 트랜잭션 + 사후 불변식 검사 실패 시 롤백 | 적재 스크립트 |
| 규칙이 코드와 어긋남 | 규칙을 **테스트로 고정** | `tests/verification-files.test.mjs` |

새 도구를 만들 때 위 표에서 해당하는 칸이 있으면 그 장치를 넣는다.
**기본값이 안전해야 실수가 사고가 되지 않는다.**

### 3-1. 우회 금지 — 이 조항이 없으면 §3 은 강제가 아니다

기계적 장치는 **그 도구를 거치는 경로만** 막는다. 같은 일을 직접 SQL·수동
명령·임시 스크립트로 하면 장치는 아무것도 막지 못한다. 그러면 "도구에 박는다" 는
강제가 아니라 *선택 가능한 안전 경로*에 그친다.

> 보호된 mutation 에는 **승인된 실행 경로가 지정되며, 동등한 수동 수단으로
> 우회하지 않는다.**

도구가 아래 상태이면 **수동으로 대신 실행하지 않는다.** 처리는 `UNKNOWN`
또는 `BLOCKED` 이고, 그 사실을 보고한다.

- 도구가 없거나 실행 불가 (unavailable)
- 파싱 실패 (parse failure)
- 검증 결과가 판정 불가 (validation UNKNOWN)
- 대상이 예상과 다름 (target mismatch)
- 증거가 낡음 (stale evidence)
- 예상 밖 출력 (unexpected output)

**도구가 막혔다는 것은 "다른 방법을 찾으라" 가 아니라 "멈추라" 는 신호다.**

### 3-2. 강제 수준을 정직하게 표기한다

> **같은 쓰기 자격증명을 도구 밖에서 꺼내 쓸 수 있으면, 그 도구는 강제 경로가 아니다.**

도구에 안전장치를 넣었다는 사실과 그 경로가 유일한 경로라는 사실은 다르다.
보호 대상마다 아래 셋 중 하나로 적는다.

| 표기 | 뜻 |
|---|---|
| `MECHANICAL` | 승인 경로 밖에서는 필요한 자격증명·권한을 **쓸 수 없다** |
| `PROCEDURAL_ONLY` | 우회 경로가 존재하지만 규약상 사용 금지 |
| `NOT_COVERED` | 승인 경로와 우회 통제가 아직 정의되지 않았다 |

강제 수준은 **두 층으로 나눠 적는다.** 섞으면 "도구 하나에 장치가 있다" 가
"보호대상 전체가 막혔다" 로 둔갑한다.

- `ENTRYPOINT_LOCAL_GUARD` — 그 도구를 실제로 썼을 때 요청이 거부되는가
- `SYSTEM_ENFORCEMENT` — 같은 행위를 다른 도구·자격증명·제어면으로 할 수 없는가

**`MECHANICAL` 이라 쓸 때는 범위를 함께 적는다** — 무엇에 대해, 누구에 대해,
어떤 우회가 남는지가 없으면 그 라벨은 무의미하다:
`ENFORCEMENT_SCOPE` / `ENFORCED_ACTOR` / `BYPASS_CAPABILITY` /
`THREAT_MODEL` / `RESIDUAL_PATH`

> 실제 사례: `setup-verify-secret.mjs` 의 TTY 거부를 "에이전트 기준 MECHANICAL"
> 이라고 적었다가 교정했다. 증명된 것은 *이 도구를 통한 비-TTY 입력 차단*뿐이고,
> 에이전트는 `.env.local` 을 직접 쓸 수 있다(실제로 그렇게 했다).
>
> 그리고 대체 문장으로 쓰려던 "소유자가 직접 입력하므로 에이전트가 값을 보지
> 못한다" 도 **무조건적 보장이 아니다.** 에이전트가 입력 직전에 wrapper 를
> 고치거나, 로깅을 심거나, 실행 파일을 바꾸거나, 오류·임시파일로 흘리면 값을
> 얻을 수 있다. 정확히는 두 가지를 나눠 적어야 한다:
> - `OWNER_DIRECT_INPUT` — 값을 채팅·비대화형 입력으로 에이전트에게 넘기지
>   않는 **운영 절차**
> - `CREDENTIAL_NON_DISCLOSURE` — *검토·고정된 executor 가 실제로 실행되고*
>   입력·로그·오류·프로세스 환경에 값이 남지 않는다는 **전제 아래** 성립
>
> `MECHANICAL NON-DISCLOSURE AGAINST MODIFIABLE EXECUTOR = NOT ESTABLISHED`.
> 고정 revision·hash 도 "확인한 바이트와 실제 실행된 바이트가 같다" 는 결합이
> 있어야 의미가 있다 — 확인 후 변경 가능한 working tree 에서 다른 바이트가
> 실행되면 TOCTOU 가 남는다.

**`PROCEDURAL_ONLY` 를 "기계적으로 강제됨" 이라고 보고하지 않는다.**

**이름은 안전 속성이 아니다.** 2026-07-22 실측: `diag-` 로 시작하는 도구 셋
(`diag-auth-role`, `diag-signup-path`, `diag-orphan-users`)이 실제로는 운영
`auth.users` 를 UPDATE 하는 쓰기 도구였다. 이름만 보고 읽기 전용이라 단정해
읽기 잠금을 걸었다가 도구를 깨뜨릴 뻔했다. 접두사·파일명·주석이 아니라
**연결 시점에 의도를 선언**하게 한다 (`connectProd({ write, reason })`).

각 보호 대상에 대해 `docs/COLLAB_STATE.md` 에 기록한다:
`APPROVED_ENTRYPOINT` / `REQUIRED_IDENTITY` / `ENFORCEMENT_STATUS` /
`OWNER_AUTHORITY_RULE` / `FAILURE_DISPOSITION` / `BREAK_GLASS_PATH` / `CURRENT_GAP`

### 3-3. 애플리케이션 런타임 변경과 운영자 변경은 다르다

- **APPLICATION-RUNTIME MUTATION** — 배포된 코드가 인증·인가·입력제한 안에서
  하는 변경(사용자 업로드·글쓰기 등). 배포 승인과 권한 모델이 envelope 역할을 한다.
  건건이 소유자 승인 대상이 아니다.
- **OPERATOR MUTATION** — 운영자·에이전트가 운영 상태를 직접 바꾸는 것.
  work packet 과 소유자 권한이 필요하다.

둘을 섞으면 서비스가 작동할 수 없거나, 반대로 위험한 변경이 일상 기능으로 위장된다.

## 4. 문서로만 있는 규칙 (최소)

### 4-1. 근거 표기
판정에는 근거 종류를 붙인다.
`MEASURED`(직접 측정) / `REPORTED_MEASURED`(남이 측정했다고 보고한 값) /
`DERIVED`(코드·스키마에서 도출) / `ASSUMED`(가정) / `OWNER_DECIDED`(소유자 결정)

- `MEASURED` 에는 **환경·대상 리비전·측정 시각·한계**를 함께 적는다.
- `ASSUMED` 만으로 PASS·완료·운영 mutation 을 정당화할 수 없다.
- 도구로 바로 계산되는 값(권한·행 수·산술)은 **수동 계산·눈대중 금지**.
  - 권한은 `has_function_privilege` 로 **묻는다**. ACL 문자열 수동 파싱 금지.
  - `proacl IS NULL` 은 "아무도 못 부름" 이 아니라 기본 ACL(PUBLIC EXECUTE).
  - `count(*)` 는 bigint → node-pg 가 **문자열**로 준다. 비교 전 `Number()`.
- 부재 주장("다른 변경 없음", "참조 0")은 **모집단 전체**를 정의하고 세야 한다.
  표본 하나로 증명하지 않는다.
- 시각이 다른 증거를 한 상태처럼 결합하지 않는다.

### 4-2. 실패를 숨기는 방어 금지
파싱 실패·예상 밖 형식을 빈 배열·0건·false·기본값으로 조용히 대체하지 않는다.
명시적 오류나 `UNKNOWN` 으로 처리하고 판정을 중단한다.

> 실제 사고: `Array.isArray` 가드를 "안전하게" 넣었더니 node-pg 가 준 `text[]`
> 문자열을 전부 빈 배열로 만들어, 권한이 있는 함수를 "아무도 못 부름" 이라고
> 보고했다. **안전한 기본값이 실패를 성공처럼 보이게 하면 fail-safe 가 아니라
> fail-hidden 이다.**

### 4-3. 완료 어휘
"완료" 라는 단어를 쓰지 않는다. 상태 벡터로 적는다.

`DESIGNED` → `CODE_WRITTEN` → `LOCAL_VERIFIED` → `PROD_VERIFIED` → `USER_REACHABLE`

마이그레이션: `SQL_DRAFTED` → `DRY_RUN_VERIFIED` → `APPLIED` → `POSTCHECK_VERIFIED`

- 테스트 수·빌드 PASS 는 **완료가 아니라 증거**다.
- feature flag 가 OFF 면 `USER_REACHABLE` 이 아니다.
- 마이그레이션에 "다음 배치"·"범위 밖" 주석이 있으면 그 모듈은 미완이다.

> 실제 사고: "강의평가 모듈 완료" 로 기록됐으나 011 SQL 만 있고 제출·조회 RPC 는
> 파일 끝에서 명시 제외돼 있었다. 쓸 수도 볼 수도 없는 상태였다.

### 4-4. 검수 요청 최소 첨부물 (L2·L3)
요약만 보내지 않는다. 매번 "원문 없이는 검수 불가" 라는 왕복이 생긴다.

exact commit/artifact ID · **전체 원문 또는 diff** · 대상 환경 · 실행 명령 ·
비밀 제거한 raw output · before/after · 영향 행 수 · 실패 경로 ·
rollback 방법 · **미충족 항목** · 근거 종류 구분

전체 저장소를 붙이라는 뜻은 아니다. diff 와 판단에 필요한 의존 조각이면 된다.

### 4-5. 오류·범위초과 발견 시 순서
`CONTAIN → DISCLOSE → MEASURE → CLASSIFY → OWNER DECISION → REMEDIATE → VERIFY → RECORD`

**복구·삭제도 새로운 mutation 이다.** "원상복구" 를 이유로 소유자 결정 전에
실행하지 않는다. 숨기지 말고 즉시 자진신고한다 — 그 편이 항상 싸다.

### 4-6. 범위는 상속되지 않는다
작업 중 발견한 결함·안전해 보이는 후속 작업·가역적 개선은 **기존 권한을
자동으로 물려받지 않는다.** 별도 work packet 이나 소유자 결정으로 전환하기
전에는 실행하지 않는다.

검수자 쪽도 같다 — 하나를 검토하다 발견한 개선사항을 원래 안전 불변식과
같은 승인조건처럼 확장하지 않는다 (`OUT_OF_SCOPE_OBSERVATION`).

## 5. 메시지 형식

### 5-1. 지시·검수 (GPT → Claude)
긴 산문에 필수·권고·질문을 섞지 않는다. 고정 헤더를 쓴다.

`AUTHORIZED` / `FORBIDDEN` / `MUST` / `SHOULD` / `REQUIRED_EVIDENCE` /
`STOP_CONDITIONS` / `EXPECTED_REPORT`

검수 결과는 심각도를 나눈다:
`BLOCKER` / `NON_BLOCKING_DEFECT` / `HARDENING_RECOMMENDATION` / `OUT_OF_SCOPE_OBSERVATION`

`OUT_OF_SCOPE_OBSERVATION` 은 소유자 동의 없이 새 작업으로 전환하지 않는다.

### 5-2. 수신 확인 (Claude → GPT)
L3 또는 범위 불명확 작업은 실행 **전에** 항목별로 답한다:
`ACCEPTED` / `BLOCKED` / `NEEDS_OWNER_DECISION` / `OUT_OF_SCOPE`

명확한 envelope 안의 L2 는 실행 후 보고서에 이 표를 포함하면 된다.

> 한 packet 에는 원칙적으로 **하나의 mutation 경계 또는 하나의 검수 결론**만 둔다.
> 여러 항목이 섞이면 수신자가 일부만 이행하고 전체를 완료로 보고하게 된다.
> (실제로 6A 를 "완료" 라 보고했으나 exact-byte 확인은 GPT 가 물어서야 했다.)

## 6. 상태 진실

- `docs/COLLAB_PROTOCOL.md` — 규범 (이 문서)
- `docs/COLLAB_STATE.md` — 현재 활성 작업·소유자 결정·동결/승인 상태
- `CLAUDE.md`·GPT 내부지침·각자 메모리 — **요약과 포인터만.** 원본이 아니다.

불일치하면 repo 의 승인된 문서와 최신 소유자 결정이 우선한다.

## 7. 위협 모델 (필수)

> 통제를 만들 때 **누구의 어떤 능력을 막는지 적지 않으면** 그 통제는 반드시
> 과대 해석된다. 2026-07-22 의 "TTY 전용이니 에이전트 차단" 오판이 그 사례다.
> 동기가 아니라 **능력**을 적는다.

**PRIMARY THREAT** — 선의이지만 실수하거나 권한을 오독하는 에이전트.
(오늘 사고 셋이 전부 이것: 범위 초과 적재, ACL 오판, 이름 기반 오분류)

**PRIMARY CAPABILITIES** — repository 쓰기 · shell·PTY 실행 ·
로컬 환경파일 접근 · 임시 스크립트 생성 · 직접 네트워크 클라이언트 생성

**PROTECTION GOALS** — 무승인 운영 mutation 방지 · 쓰기 자격증명의 우발적
사용·노출 방지 · 대상·영향 오판 시 fail-closed

**TRUSTED COMPONENTS** — 소유자 · 소유자 확인 승인 ·
고정된 executor artifact/revision · DB 권한 경계

**OUT OF SCOPE** — 악의적·탈취된 소유자 · 탈취된 OS ·
executor 가 자격증명을 얻은 뒤 의도적으로 유출하는 공격

**RESIDUAL RISK** — 수정 가능한 executor · 외부 제어면 ·
break-glass 오용 · 측정되지 않은 실효 권한

**SECONDARY THREAT** — 악의적·손상된 executor.
`현재 설계는 이 위협을 완전히 막지 못한다. 보호된 executor 또는 broker 필요.`

> **통제 주장은 반드시 적용 대상 행위자·능력·범위·신뢰 전제·잔여 우회를
> 함께 명시한다.**

### 7-1. 운영 위협 모델과 통제 반증 모델은 다르다
현실의 주된 위협이 실수라고 해서, 통제를 검수할 때도 선의만 가정하면
실수로 열 수 있는 우회를 못 찾는다.

- `OPERATIONAL THREAT MODEL` — 무엇이 실제로 일어날 법한가
- `CONTROL FALSIFICATION MODEL` — 행위자가 **가진 모든 기술적 능력**을
  써서 통제를 우회할 수 있다고 가정하고 반례를 찾는다

## 8. 단독 자기인증 금지 (핵심 보완)

같은 주체가 안전장치 코드·실행환경·자격증명 접근·검증 스크립트·PASS 보고를
**모두** 통제하면, 절차적 자기검증만으로는 강한 보장을 만들 수 없다.
"우회법 3가지를 스스로 적기" 는 유용하지만 충분하지 않다 — 이미 상상한
범위에 갇히고, 쉬운 셋을 채우고 끝낼 수 있다.

### 8-1. 통제 작성자가 단독으로 PASS 를 발급할 수 없는 주장
- `SYSTEM_ENFORCEMENT = MECHANICAL`
- L3 운영 안전 통제
- 자격증명 격리
- mutation 진입점 모집단이 닫혔다는 주장
- break-glass containment

이들은 **별도 검수자**가 반례 탐색·누락 진입점 제시·신뢰 전제 공격·
증거와 결론의 범위 비교·`UNKNOWN` 을 PASS 로 승격했는지 확인을 해야 한다.

| 역할 | 담당 |
|---|---|
| Claude | 통제 작성 + 1차 자기반증 |
| GPT | 독립 설계 검수 · 보고된 증거의 범위 검수 |
| 소유자 | 권한 결정 |

> GPT 가 Claude 의 보고만 검토한 경우는 **독립 설계검수이지 독립 실측이 아니다.**
> 그 구분을 상태 기록에 남긴다.

### 8-2. 우회 행렬 (L3 통제·MECHANICAL 주장에 필수)
아래 각 범주를 `BLOCKED WITH EVIDENCE` / `POSSIBLE` / `UNKNOWN` /
`NOT APPLICABLE WITH REASON` 중 하나로 판정한다. **`UNKNOWN` 을 PASS 로
처리하지 않는다.**

대체 자격증명 · 대체 진입점 · 파일·DB 직접 접근 · wrapper 변조 ·
PTY·입력채널 치환 · 외부 대시보드·API·CLI · 역할 상속·권한 상승 ·
낡은 증거·대상 불일치 · 검토→실행 사이 TOCTOU ·
로그·argv·환경변수·임시파일 유출 · fail-open·수동 fallback ·
break-glass 오용 · 행위자 치환 · 복구·rollback 경로 악용

최소 **3개의 구체적 우회 시나리오**를 작성자가 직접 제출한다.
다만 셋을 적었다는 사실이 검수 완료 조건은 아니다.

### 8-3. 수리 후 재검수
우회 하나를 막으면 **새 장치가 만든 경로**를 다시 검수한다.
첫 반증 라운드의 PASS 를 수정된 설계에 자동 승계하지 않는다.

## 9. 개정 이력

| 날짜 | 내용 |
|---|---|
| 2026-07-21 | 초안. GPT 라운드 1 반영 (4유형 → 8유형, GPT 자기실패 6건) |
| 2026-07-21 | 라운드 2 — 18절 제안 철회, 7절 축소 + "도구에 박는다" 원칙 확정 |
| 2026-07-22 | 라운드 3 — §1-1 권한상태 비동치, §3-1 우회 금지, §4-6 범위 비승계 추가 |
| 2026-07-22 | 라운드 4 — §3-2 LOCAL/SYSTEM 분리, MECHANICAL 과장 철회, §3-3 런타임/운영자 구분 |
| 2026-07-22 | 라운드 5 — §7 위협 모델 필수화, §8 단독 자기인증 금지·우회 행렬 추가 |

> 확정 상태: **소유자 승인 대기 (Decision A).**
> GPT 판정 — 7절 구조 PASS / 위협모델 명시 MANDATORY /
> compromised executor 대응은 명시적 잔여 구멍.
