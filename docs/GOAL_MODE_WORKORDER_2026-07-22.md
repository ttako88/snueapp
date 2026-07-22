# GOAL 모드 업무 지시서 — 2026-07-22 (Claude 자기지시)

> **이 문서는 goal 모드로 나 자신에게 주는 실행 지시서다.** 컨텍스트가 압축되거나
> 세션이 끊겨도 다음 세션이 이 문서 + `docs/COLLAB_STATE.md` 만 읽고 이어간다.
> 진행하면서 §9 진행원장을 매 항목마다 갱신한다. 마지막에 몰아 쓰지 않는다.

## 0. 권한 근거 (AUTHORIZATION)

- 소유자(조상호)가 **2026-07-22 채팅에서 A~G 전부 명시적 승인.** 원문 취지:
  "승인대기중인 A~G까지의 작업들을 모두 승인한다 … goal 모드로 진행할 것이다."
- 이는 AUTHORIZATION 기록이다(재측정 대상 아님). 그러나 **가역성·비용·N3는
  실행 전에 증명**한다 — 승인은 판단 위임이지 안전검증 면제가 아니다.
- 소유자가 브라우저에 **GPT 검수 창을 띄워 뒀다.** GPT 검수는 그 창을 구동해 받는다.

## 0.5 대원칙 — 바지사장 (오해 금지)

소유자 원문: *"나는 아침에 보고만 받고 적용된 내용에 대해 '그래 잘했네' 또는
'이부분은 롤백하자'만 얘기하고 싶은 차원에서 나 그만 찾아라."*

이건 "사용자를 안 괴롭힌다"를 **게이트 건너뛰기 핑계로 쓰라는 뜻이 절대 아니다.**
정반대다 — **되돌릴 수 있는 것은 전부 실행해두고, 롤백 수단을 붙여 아침에 보고**하라는
뜻이다. 그래서:

1. **가역적인 것은 물어보지 않고 실행**하고, 각 건에 즉시 롤백 경로를 붙여 보고한다.
   사장님은 아침에 "잘했네" 또는 "이건 롤백"만 말하면 된다.
2. **실행 중 사장님을 찾지 않는다.** 답 기다리며 멈추지 않는다(자율주행 원칙).
3. **예외는 딱 3종** — ①되돌릴 수 없음 ②돈이 나감 ③사장님 부재중 인증 신뢰경계 변경.
   이건 **물어서 멈추는 게 아니라, 실행하지 않고 아침 보고에 "준비됨 · 한마디면 함"으로
   한 줄 올린다.** 이건 괴롭히는 게 아니라 하지-않고-남겨두는 것이다.
4. 그 3종에 해당하는 현재 항목: **F/015**(부재중 인증경계 변경 → held),
   **v3 A/B**(유료 → held), **새 시크릿**(기계적으로 내가 못 함 → held).
   나머지 A~E·결함1·2는 전부 가역이므로 **실행하고 보고**한다.

## 1. 절대 안전 레일 (승인으로도 안 풀리는 것 — 필드로 박음)

1. **시크릿 금지.** `SUPABASE_SECRET_KEY`·Vercel env·API 키 값을 필드/TTY에 입력하지
   않는다. A~E는 신규 시크릿 불요(앱이 이미 live). 만약 새 시크릿이 필요해지면
   그 항목만 pending 걸고 소유자에게 넘긴다.
2. **GPT 검수는 적용 *전에*.** 각 마이그레이션은 「GPT 검수 packet → PASS → 적용 →
   사후검증」 순서. 적용 후 검수는 결함을 이미 운영에 넣은 뒤라 무의미. packet은
   `docs/reviews/REVIEW_REQUEST_2026-07-22_NIGHT.md` 기반, **한 번에 하나**.
   GPT가 BLOCKED/MODIFY면 그 항목 중단·자진보고, 다른 항목은 계속.
3. **F(015)는 마지막·소유자 입회.** 인증 신뢰경계를 바꾸는 N3. 자율 실행 금지.
   소유자가 화면에서 "지금 열자" 직접 확인할 때만. 실시간 모니터링 대기.
4. **적용은 한 번에 하나.** `prod-apply-migration.mjs`가 강제. 여러 개 동시 금지.
5. **배포는 가역.** 실패 시 즉시 롤백(§8). 배포 직후 smoke 미통과면 자동 롤백.
6. **유료 AI는 별도 승인.** 프롬프트 v3 A/B 실측(실비 Gemini)은 A~G에 포함 안 됨.
   Phase 3에서 만나면 소유자에게 별도로 물어본다. 밤에 임의 실행 금지.
7. **완료 어휘 금지.** CODE_WRITTEN / LOCAL_VERIFIED / PROD_VERIFIED / USER_REACHABLE.

## 2. 실측된 현재 지형 (2026-07-22, 착수 전 재측정 대상)

- git: main == origin/main == `9fa001d`. 워킹트리 48개 변경(밤작업, 미커밋).
- 운영 DB: 001~018 적용됨. pending = 015·016·019·020·021·022·023 (`supabase/migrations/pending/`).
- flag(`app/lib/features.js`): `aiCreditCharge`=false, `practicumPlacement`=false,
  `courseReview`=false (전부 OFF). flag ON = 코드 수정 + 배포.
- live 앱(9fa001d)은 **옛 finalize 라우트** → 020 RPC 미의존. 새 라우트는 워킹트리에만.
- 적용 도구는 `supabase/migrations/`에서 파일을 읽는다 → pending/의 파일을 먼저
  `git mv pending/NNN.sql ../`로 승격한 뒤 적용(승격 자체가 배포 커밋에 포함됨).

## 3. Phase 0 — 착수 전 지반 측정 (파괴 없음, 승인 불요)

착수 직전 **fresh 재측정**. 오래된 PASS는 지금의 write를 승인하지 않는다.
- [ ] `git fetch && git status` — main==origin/main, 워킹트리 예상과 일치 확인
- [ ] `node scripts/manual/prod-inventory.mjs` — 운영 스키마 실측(테이블/함수/트리거/정책)
- [ ] `node scripts/manual/prod-dryrun-pending.mjs` — 7종 누적 dry-run 재확인(적용→ROLLBACK)
- [ ] 배포 경로 확인: origin/main 푸시 → Vercel 자동배포인지 실측(1회)
- [ ] `.env.prod.local` 존재·PROD_DB_URL 유효(값 미출력) — 도구가 붙는지만

## 4. Phase 1 — A~G 실행 (검수-적용-검증-배포)

> 안전 기술 순서(REVIEW_REQUEST 순서 = 020→016→022·023→019·021)를 따른다.
> 소유자 나열순(A→B→C→D→E→F)과 항목은 같고 D/E와 C의 실행 순만 최적화.

### A. 020 finalize claim (인증 새치기 방지) — **배포까지가 A**
1. GPT 검수 packet 020 송부(TTL 2분 근거 질문 포함) → PASS 확인
2. `git mv supabase/migrations/pending/020_finalize_claim.sql supabase/migrations/`
3. `node scripts/manual/prod-apply-migration.mjs 020_finalize_claim.sql --execute`
   → 전후 스냅샷·"기존 경로 생존" PASS 확인. FAIL이면 중단·보고.
4. **배포**: 워킹트리 커밋 + `git push origin main`. (밤작업 전체가 함께 나감 —
   전부 LOCAL_VERIFIED, 164 테스트 PASS.) Vercel 배포 대기.
5. smoke: `prod-smoke-http.mjs`(503/헤더/API 경계) + 인증 제출 경로 확인.
   실패면 즉시 롤백(§8). PROD_VERIFIED 판정.
> ⚠️ 이 배포가 보안구멍을 닫는 **임계 배포**. 3(적용)→4(배포) 역전 절대 금지.

### B. 016 course_review_write_read (강의평가 DB + 통계 분모 수정)
1. GPT 검수 packet 016(n 공개가 역산 단서 되는지 질문 포함) → PASS
2. 승격 + `prod-apply-migration.mjs 016_...sql --execute` → 검증
3. **courseReview flag은 OFF 유지.** 배포 불요(코드 변화 없음, DB만).

### D. 021 orphan_detection (고아 파일 탐지 — 읽기 전용)
1. GPT 검수 packet 021(삭제 함수 부재 확인) → PASS
2. 승격 + 적용 + 검증. 읽기 전용이라 가장 안전. flag/배포 불요.

### E. 022 → 023 (화폐 분리 → 지도안 SR 차감) — **순서 필수 + flag**
1. GPT 검수 packet 022·023(빈 결과 환불 판단 질문 포함) → PASS
2. 승격 + `prod-apply-migration.mjs 022_currency_split.sql --execute` → 검증
   (기존 018 ledger 쓰기가 사는지 사후검증에서 확인)
3. 승격 + `prod-apply-migration.mjs 023_ai_credit_charge.sql --execute` → 검증
4. flag `aiCreditCharge` → true (features.js). 배포는 C와 함께 §C-4에서 일괄.

### C. 019 practicum_placement (실습학교 설정 화면 + flag)
1. GPT 검수 packet 019 → PASS
2. 승격 + `prod-apply-migration.mjs 019_practicum_placement.sql --execute` → 검증
3. flag `practicumPlacement` → true (features.js)
4. **flag 일괄 배포**: E-4 + C-3 flag 변경을 커밋 + push origin main → Vercel.
   smoke: 실습학교 화면 200 + 저장 경로, 지도안 SR 차감 동작 확인. PROD_VERIFIED.

### F. 015 drop_email_domain_gate (로그인 개방) — **소유자 입회, 마지막**
- N3. 자율 실행 금지. 소유자가 화면에서 "지금 열자" 직접 확인할 때만.
- 그 전까지 pending 유지. 준비만 해두고 대기(검수 packet은 미리 받아둘 수 있음).

### G. 사업자등록 — 소유자 사업 판단. 내 실행 항목 아님. 참고만.

## 5. Phase 2 — GPT 검수 (Phase 1에 embed됨)

각 적용 직전에 이미 받는다(§1-2). Phase 2를 별도로 두지 않고 각 항목의
1단계로 흡수. GPT 판정은 채팅 아닌 근거로 기록(verdict를 진행원장에 적음).

## 6. Phase 3 — 미해결 결함 해결

1. **동시 finalize 재현**(결함1): 020 적용+배포 후 가능해짐. 합성 인증신청을 만들어
   2세션 동시 finalize 재현 → 선점 동작 실증. **가역이므로 자율 실행**: 합성 데이터는
   실행 후 전량 정리(삭제)하고 결과를 보고한다. 단 실제 사용자 인증 흐름과 깨끗이
   격리 못 하면 실행하지 말고 dev 권장으로 보고(사장님을 찾지 않는다). PROD_VERIFIED 목표.
2. **강의평가 통계 분모**(결함2): 016 적용 후 controlled 검증. courseReview flag는
   OFF 유지가 원칙이라, flag 없이 RPC 직접 호출로 분모 동작만 실측.
3. **프롬프트 v3 A/B**(결함3): 유료. §1-6 — 소유자 별도 승인 후에만.
4. **Storage 고아 삭제**(결함4): 의도적 미구현. 021 탐지 목록을 소유자가 확인하는
   흐름만 문서화. 삭제 도구는 만들지 않음(승인 시 별건).
5. **/schedule 죽은 화면**(결함6): `/calendar` 상위호환 확인 후 삭제 판정 — 소유자 확인.

## 7. Phase 4 — 로컬 GPT 데이터 반영 (마지막)

- 로컬 GPT(원 계정, 한도 복원, 3차 지시서로 연속 작업 중)가 `단원구성.csv`의
  성취기준코드 열을 채우면 → `app/data/lessonPrompt/`에 반영 → `npm run lesson:check`
  탈락 0 확인 → 지도안이 실제 성취기준 코드 인용하는지 실측.
- 빠진 단원(미술 3~6·실과 3~4·통합 1~2)도 도착분부터 반영.

## 8. 롤백 플레이북

- **배포 롤백**: Vercel 이전 배포 promote, 또는 `git push origin <직전SHA>:main`
  (직전 = 배포 전 origin/main SHA를 진행원장에 먼저 기록해 둘 것).
- **flag 롤백**: features.js 해당 enabled → false, 재배포.
- **마이그레이션 롤백**: 추가형이라 대부분 무해. 되돌림 필요 시 해당 SQL의 down
  경로 확인(dry-run이 ROLLBACK까지 실증한 범위). **데이터 지우는 down 금지(N3).**
- **DB snapshot restore 금지**(그 사이 생긴 신규 데이터 유실).

## 9. 진행 원장 (매 항목 갱신 — 이것이 상태의 원본)

| 항목 | GPT검수 | 적용 | 배포 | 검증 | 상태 |
|---|---|---|---|---|---|
| Phase0 지반측정 | — | — | — | — | **PROD_VERIFIED** (dryrun 7/7 PASS, 기준 37/118/20/17, 잔여물0) |
| A 020 + 배포 | rev3 CONDITIONAL_PASS | ✅적용(함수+3=125,레거시회수) | ✅배포 e6923dc | **PROD_VERIFIED** | smoke PASS: 홈200·maintenance200·units200·finalize무인증→401(500아님=정상). 새 token-fenced 라우트 live, 다운타임 종료. 남은것: 동시성 실측(defect1, synthetic). 롤백기준 origin/main=9fa001d |
| B 016 | rev2 GO_AFTER_MUST_01 | **✅적용** | (불요) | **PROD_VERIFIED** | rev2+MUST_01(trend_n null) 반영, GPT 승인. 운영 적용 APPLY_016=PASS(함수+4=122, 데이터불변, RLS/anon 정상). flag OFF. MUST7 항목별(n=9,10) 공개검증은 데이터·활성화 시(synthetic). 활성화 전 차분공격 snapshot 선행. |
| D 021 | CONDITIONAL_PASS→MUST반영 | **✅적용** APPLY_021=PASS(함수+2=127) | (불요) | PROD_VERIFIED(DB) | MUST 반영: svc_verification_object_status(path_matches 불리언만·경로/token 비노출·bad_id→INVALID_PATH). 탐지도구 5분류(ORPHAN/INVALID/UNKNOWN/RETAIN/GRACE)·token구조 순회·삭제 미import 재작성(문법OK, 런타임 NOT_VERIFIED=수동). 삭제도구는 별도packet. |
| E 022→023 | 022 CP / 023 DB CP | **✅적용** 022(함수+1트리거+1)·023(테이블+1함수+2) | (flag OFF) | PROD_VERIFIED(DB) | 022 사후검증이 guard_ledger_currency PUBLIC EXECUTE 잡음→revoke 교정(anon EXECUTE 0 복구). 023 PASS. unlock_subject도 members 잠금 확인. **flag aiCreditCharge OFF 유지** — 활성화는 durable 상태기계(CHARGED/GENERATING/DELIVERABLE_COMMITTED/REFUNDED)+AI키 뒤(GPT 활성화 BLOCKER, held). 차감코드는 e6923dc에 휴면 배포됨 |
| C 019 | CONDITIONAL_PASS | **✅적용** APPLY_019=PASS(테이블+1함수+4) | (flag OFF) | PROD_VERIFIED(DB) | k-익명(3명미만 "<3") 반영 적용. flag ON은 placement UI만 인가(단 posting 활성화는 atomic post gate·게시판층 제한 전까지 NO). **practicumPlacement OFF 유지**(flag가 게시판 진입도 여는지 확인+게시판층 MUST 후 ON). UI "인증" 표시 금지. |
| F 015 | — | — | — | — | **HELD** — 소유자 입회 시 |
| 결함1 020동시성 | — | — | — | 코드검증완료 | GPT rev3 검증+배포+smoke PASS. 라이브 동시성 재현은 **커밋 합성 verification_requests/auth.users(N3 보호데이터) 필요→이연**(dev 또는 소유자 입회). 코드는 검증됨 |
| 결함2 016통계 | — | — | — | 로직검증완료 | GPT rev2 검증+적용. n=0,9,10 출력 실측은 합성 리뷰 필요(courseReview OFF)→이연 |
| Phase4 로컬GPT | — | — | — | — | 데이터 도착 대기 |

## ★ goal 실행 결과 요약 (2026-07-22)
**A~E DB 전부 운영 적용 완료.** A(020)는 배포까지(9fa001d→e6923dc, smoke PASS).
GPT 검수가 적용 전 결함 다수 차단: 016(0응답키·저분모·차분공격), 020(TTL·원자성·레거시우회 BLOCKER 3), 021(경로/token누출), 022(guard PUBLIC EXECUTE), 019(k-익명·인증표시).
**모든 flag OFF**(courseReview·aiCreditCharge·practicumPlacement) — GPT가 각 활성화를 정당한 이유로 차단(차분공격 snapshot / SR-timeout durable상태기계 / atomic post gate). 활성화는 각 선행조건 + (AI는 소유자 키) 후.
운영 함수 총 118→134(+16). 데이터 불변, anon EXECUTE 0, RLS 정상 유지.

> **배포 전 직전 origin/main SHA = `9fa001d0bf8eb368ad8ca3b46d1614a855611578`**
> (2026-07-22 Phase0 실측, main==origin/main). 배포 롤백 기준점.
>
> Phase0 실측: main==origin/main==9fa001d / 워킹트리 49변경 / .env.prod.local 존재 /
> pending 7종 존재 / dryrun 도구 존재. (prod-inventory·dryrun 결과는 아래 진행 시 갱신)

## 10. Held 항목 — 실행하지 않고 아침 보고에 "한 줄"로 올리는 것 (묻고 멈추는 게 아님)

§0.5 예외 3종. 실행 중 사장님을 찾지 않는다. 아침 보고에 아래를 각 한 줄로 올려
사장님이 "해" 한마디만 하면 즉시 처리한다.

- **F/015 로그인개방**: 부재중 인증경계 변경(N3)이라 실행 안 함. "준비 완료(검수까지),
  한마디면 10초 안에 엽니다. 사장님 계실 때 여는 게 사장님 본인 규칙."
- **v3 A/B (유료)**: "약 ₩XXX 실비. 돌릴까요?" — 돈이라 자율 안 함.
- **새 시크릿 필요 시**: 기계적으로 내가 못 함 → 그 항목만 넘김.

## 11. 자율로 하고 보고만 하는 것 (묻지 않음)

- **A~E 적용·배포·flag**: 전부 가역+승인됨 → 실행하고 롤백경로 붙여 보고.
- **첫 운영 배포 푸시**(A-4): 즉시 smoke, 실패 시 자동 롤백, 결과 보고.
- **결함1·2**: §6대로 자율(결함1은 합성데이터 정리 포함).
- 모든 건에 §8 롤백경로를 보고에 첨부 → 사장님은 "잘했네" 또는 "이건 롤백"만.
