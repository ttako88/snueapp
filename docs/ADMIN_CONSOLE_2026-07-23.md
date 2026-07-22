# 관리자 통합 운영 콘솔 — 진행 원장 (2026-07-23)

> 소유자 라이브 지시(이번 세션): "관리자용 통합 작업콘솔. 회원 상태·강퇴·정지·접근권한,
> **개별 지도안 생성권한**(지인 베타테스터에게 결제 없이 열어주기), 게시판별 광고삽입·공지 등.
> GPT와 3~4라운드 합의 후 새벽 배포." → GPT 협업 R1·R2 합의(CONDITIONAL_PASS) 완료, 구현·로컬검증까지.

## 상태 요약 (2026-07-23)
- **`PROD_DEPLOYED` + `028 PROD_APPLIED`.** 콘솔 라이브·이용권 시스템 **운영 활성**.
- 콘솔 코드: origin/main=`4e9cc38`, Deploy Hook 배포, smoke PASS. 롤백기준=`1a56df2`.
  실측: /admin/console·/members·/entitlements=200, zzznonexist=404, 기존경로 회귀0.
- **028 운영 적용 완료(2026-07-23)**: APPLY_028=PASS. 테이블 51→55(+4)·함수 152→165(+13), 기존데이터 불변(글1 댓글0 계정4 회원4), 기존함수 8종 생존, RLS off 0·anon EXECUTE 0. (소유자가 settings.local.json 허용 후 cmd 직접 실행 — 하네스 분류기가 Claude 실행 차단했었음.)
- 빌드 PASS·eslint 0·테스트 **208/208**. dry-run PASS·ACL_028 PASS.
- **남은 것(선택)**: 특정 지인에게 이용권 부여 = 콘솔 /admin/console/members서 닉네임 검색→"지도안 생성권 부여(30일10회)" 2클릭. 부여받은 지인은 결제 없이 지도안 생성(USER_REACHABLE). ※ 자동 부여는 대상 식별 정보(닉네임)가 소유자만 아는 값이라 미실행.
- **028 dry-run PASS**(운영스키마 apply→ROLLBACK, +4테이블+13함수, 잔여물0) + **ACL_028=PASS**(has_function_privilege 측정: private 헬퍼 anon/auth=F, svc는 service_role만, 관리RPC는 authenticated만).
- GPT R1·R2·R3A 완료. R3A에서 BLOCKER 2건 지적 → **둘 다 수정·재검증**(아래). R3BC 재검수 발송.
- 다음: GPT R3 최종 signoff → R4 배포계획 → 코드 배포(flag OFF, 경로지정 커밋) → **028 운영적용+지인 grant는 owner 몫**(1커맨드 준비).

## GPT R3 최종 판정 = PASS (P-20260723-ADMIN_CONSOLE_R3BC_REVIEW_01_REISSUE)
- **MIGRATION_028_SIGNOFF = PASS_BY_REPORTED_EVIDENCE.** CONSOLE_CODE = PASS_FOR_DORMANT_DEPLOYMENT. R4 배포 AUTHORIZED.
- BLOCKER 1·2 RESOLVED 확인. **활성화 blocker(request_id) 1건** 지적 → 수정 완료(아래).
- FORBIDDEN(유지): 028 운영적용·실사용자 grant·flag ON·role/grant/RLS 변경·제재/공지/광고 실제실행.
- NON_BLOCKING(활성화 전 처리): 장기 reserved reconciliation, auth.users 픽스처 cross-member 행위테스트, graceful fallback(✅ 완료).

## 활성화 blocker(request_id) 수정 완료
- `Date.now()` → **`crypto.randomUUID()`**(newRequestId 헬퍼). 같은 ms 동시요청도 서로 다른 id → 예약1·생성2 quota 우회 차단. entitlement·SR 양경로 모두.
- 테스트 +2: 20000개 대량생성 전부 유일 / 형식 prefix:uid:purpose:uuid. 총 **208/208**.
- graceful fallback: 028 미적용 시 members·entitlements가 오류 대신 "아직 활성화되지 않았어요" 표시(isNotActivated).

## GPT R3A BLOCKER 2건 → 수정 완료
- **BLOCKER_1 (private 헬퍼 PUBLIC EXECUTE)**: PostgreSQL 신규함수 기본 PUBLIC EXECUTE. private.actor_has_permission/require_permission/entitlement_effective에 명시 `revoke ... from public,anon,authenticated` 추가. ACL 측정으로 anon/auth=F 확인(scripts/manual/verify-028-acl.mjs).
- **BLOCKER_2 (request_id 신원 결속)**: reserve의 unique 흡수를 신원검증으로 교체 — member_id≠actor→request_id_conflict(fail-closed), 같은 actor&reserved→already_reserved(멱등), consumed/refunded→재실행 금지. 타인 원장 재사용·quota 우회 차단.

## analytics 콘솔 포함 (소유자 지시 2026-07-23)
- 콘솔 탭·허브에 "분석/이용통계" 진입점 추가 → 기존 라이브 `/admin/analytics` 링크. **그 페이지·구 세션 파일 무변경.** owner·operator만 노출.

## GPT 합의 (P-20260723-ADMIN_CONSOLE_R1/R2_REVIEW_01)
- 구조 = SAME_APP `/admin/console` + 서브라우트(members/entitlements/boards/moderation/sponsors/settings/audit). 별도 웹앱 X.
- 강퇴=app-level `banned`(복구가능)·정지=만료 `suspended`. auth.users·영구삭제 콘솔 제외.
- 권한 = 역할 서열이 아니라 **명시적 permission key**(member.read_basic, entitlement.manage_cost 등).
- 지도안 게이트 = owner OR 유효 entitlement. funding_source 요청당 하나: OWNER→FREE_ENTITLEMENT→PAID→DENY. entitlement면 SR·과금 0.
- entitlement 부여/회수 = owner(entitlement.manage_cost)만. operator는 조회만.
- 원장 독립(023 재사용 X, 패턴만). RESERVED+CONSUMED만 quota 점유.
- **PROD_DB_APPLICATION = NOT_AUTHORIZED**(R2). 028 운영적용·실사용자 grant는 owner 단계.

## 만든 것
### migration 028 (`supabase/migrations/pending/028_feature_entitlements.sql`) — 추가형·가역
- `private.role_permissions`(role→permission 시드) + `actor_has_permission()`·`require_permission()`.
- `private.entitlement_keys`(레지스트리: lesson_plan_generate).
- `private.entitlement_grants`(부여: grant_type quota|unlimited, quota_total, starts/expires, status active|revoked, 구조 CHECK).
- `private.entitlement_ledger`(원장: request_id UNIQUE, state reserved|consumed|refunded).
- 게이트 svc(service_role): `svc_lesson_plan_access_preview`(비변경)·`svc_reserve_lesson_plan_entitlement`(원자 예약, grant FOR UPDATE)·`svc_consume_entitlement`·`svc_refund_entitlement`.
- 관리 RPC(authenticated, require_permission): `grant_entitlement`/`revoke_entitlement`(owner)·`admin_list_members`(PII 미반환·cursor)·`admin_member_detail`·`admin_list_entitlements`·`my_admin_permissions`.
- 전부 `security definer set search_path=''`, RLS on, anon/authenticated EXECUTE revoke(관리 RPC만 authenticated grant).

### 지도안 라우트 (`app/api/lesson-plan/route.js`)
- 게이트를 funding_source 판정으로 교체. 순수 판정표 `app/lib/server/ai/lessonAccess.mjs`(`classifyFunding`).
- **028 미적용 시 preview RPC 없음→기존 owner-only 폴백(fail-closed).** 코드가 마이그레이션보다 먼저 배포돼도 안전.
- entitlement 경로: reserve→생성성공 consume→실패 refund. SR(aiCreditCharge)와 상호배타.

### 콘솔 UI (`app/admin/console/*`)
- `layout.js`(staff 게이트+탭)·`page.js`(현황 hub)·`members/`(검색·목록·상세·**이용권 부여/회수 = 핵심**)·`entitlements/`(현황).
- boards/moderation/sponsors/settings/audit = 정직한 "준비 중" 플레이스홀더(다음 배포).
- `app/lib/community/adminConsole.js`(RPC 래퍼 + 권한 미러). `/admin` 허브에 콘솔 카드 추가.

## 미해결/이연 (R3에서 GPT에 짚을 것)
- **직접 회원제재(강퇴/정지)**: 기존 `apply_sanction`은 **콘텐츠 case 기반**(content_author 조회)이라 콘텐츠 없는 회원 직접제재엔 그대로 못 씀. GPT Q9(a)는 "내부 case 자동생성+apply_sanction 재사용"이나 apply_sanction이 content 대상 요구 → member-target 경로 별도 설계 필요. **moderation 모듈 플레이스홀더로 이연.**
- board notice 작성·sponsor draft·flag 토글·audit 열람 RPC = 다음 배포.
- 장기 RESERVED reconciliation cron = 설계만, 이번 배포 미활성(GPT Q11).

## 안전
- 추가형·가역: 028 down = 이 파일 객체만 DROP. grant는 revoke로 즉시 회수.
- 보안경계 약화 아님: 게이트 미보유 시 deny(owner-only) fail-closed. 018 예산상한·aiCreditCharge 그대로.
- 배포=Deploy Hook POST. 직전 SHA 기록·smoke. 롤백기준 `153bf99`.
