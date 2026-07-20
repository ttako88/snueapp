# Gate 3 — 커뮤니티 기반 설계 확정서

- 작성: 2026-07-20, Claude (Fable 5) / **v1.4** — Gate 4a dev 리허설 실측 반영: §4.1 학번 8자리 확정, §5.2 소프트 삭제를 definer RPC 경로로 전환(RLS UPDATE↔SELECT 가시성 충돌 해소), 마이그레이션 파일 001~008 순번. (v1.3: GPT 정오표 13건 + 탈퇴자 콘텐츠 유지 정책)
- 상위 문서: [ARCHITECTURE_AUDIT_PHASE1.md](ARCHITECTURE_AUDIT_PHASE1.md) v1.2 (Gate 1 승인본)
- **이 게이트의 산출물은 이 문서뿐** — 코드·DB·Storage·설정 변경 없음. 실린 SQL은 Gate 4a에서 dev 리허설 후 실행될 초안

## 0. 정책 상수표

| 상수 | 값 | 비고 |
|---|---|---|
| 미인증 계정 삭제 | 가입(auth 생성) 후 7일, submitted 중 정지 | |
| 반려 후 재제출 | 반려일+7일 | |
| 인증 원본 파기 | 최종 검토 후 7일 | Storage API로만 삭제 (§7) |
| **장기 미처리 심사** | 3일: owner 경고 / 7일: 재경고+사용자 지연 안내 / **30일: expired_unreviewed 자동 종료+원본 24h 내 파기(Storage API), member는 pending 복귀+deadline 7일 재부여.** 제재·반려 이력으로 기록하지 않음 — 단 재제출이라는 실제 부담이 발생하며 이는 운영자 미처리로 인한 것이므로, **운영 메시지에 사과·운영 지연 사유·재제출 안내를 명확히 포함** | **✅ 확정 (사용자 승인 2026-07-20)** |
| 비회원 미리보기 | 합산 3글/일(KST), 댓글은 최신 3개(B안) | 원자적 판정 (§8) |
| IP 백스톱 | env `PREVIEW_IP_DAILY_CAP` 기본 200 | 운영 조정값 |
| 미리보기 쿠키 | **일 단위** — KST 자정까지만 유효, 날짜 바뀌면 새 id | 1년 쿠키 폐기 (§8) |
| guest_reads 보존 | 48h TTL | |
| soft delete 보존 | 30일 (열린 사건 있으면 사건 종결까지) | |
| 제재 | write_restricted 1일 / community_suspended 7·30일 / banned 무기한(sanction_until null) | |
| 닉네임 | 2~16자, **대소문자 비구분 유일**, 변경 30일 1회 | §4.2 |
| enforcement hold | retention_until 미확정 시 **hold 생성 자체를 차단**(운영) — 기간 확정은 출시 전 법적 검토, **Gate 7 release blocker** | 부록 I-3 |
| **인증 업로드 유예** | begin 후 **24시간** 내 finalize 없으면 upload_expired + 고아 정리. uploading 상태는 member 상태·삭제 시계에 무영향 | §4.1 (v1.3) |
| **탈퇴자 콘텐츠** | **유지형 확정** — 본인이 삭제하지 않은 글·댓글은 내용 유지, 작성자 표시만 "탈퇴한 사용자"(전원 동일 문구, 연결 번호 금지), 신원 연결 전부 제거 | §13 (사용자 확정 2026-07-20) |
| 조회수 | 참고 통계 (탈퇴→재가입 재조회 시 중복 가능. 보안·회계 수치 아님) | |

## 1. 스키마 분리 원칙 (v1.1 신설)

**PostgREST 노출 스키마(public)와 내부 스키마(private)를 분리한다.** private의 테이블은 API에 존재 자체가 없다 — "RLS 정책 0개"에 더해 노출 표면을 원천 제거.

| 스키마 | 테이블 | 클라이언트 접근 |
|---|---|---|
| **public** | boards, posts, comments, post_owners, comment_owners, post_votes, bookmarks, operational_messages | RLS 하에 직접 CRUD (부록 C 표) |
| **private** | members, school_identities, verification_requests, enforcement_holds, member_status_history, anon_aliases, post_views, blocks, reports, moderation_cases, case_snapshots, moderation_actions, audit_logs, guest_reads, **guest_ip_daily** | **직접 접근 불가 — 지정된 RPC/서버 경유만** |

- private 테이블도 RLS✔ + 정책 0개 + `revoke all from anon, authenticated` **삼중 차단** ("RLS 없음"과 "테이블 권한 없음"을 모두 적용)
- **스키마 자체 권한 (v1.3)**: `revoke usage, create on schema private from public, anon, authenticated;` — 테이블 권한 이전에 스키마 USAGE부터 차단. USAGE·CREATE는 소유 역할·service_role·**스케줄 작업을 실제 실행하는 스케줄러 소유 역할**(역할명은 Gate 4a dev에서 확인)에만 명시 부여. `alter default privileges in schema private`도 동일하게 제한 (public 스키마와 같은 기본권한 제한을 private에도 적용)
- guest_ip_daily는 guest_reads와 동일 취급: 접근 경로는 `claim_guest_read`와 TTL 배치뿐, RLS✔+정책 0+revoke, 48h(당일+익일) 후 TTL 삭제, 인덱스는 §10
- members가 private로 간 결과: 클라이언트는 members를 직접 읽거나 쓸 수 없고, `get_my_member()`·`set_initial_nickname()`·`change_nickname()` RPC만 사용. **내부 UUID·타인 상태·역할이 API에 노출될 경로 자체가 없음**

## 2. SECURITY DEFINER 공통 템플릿 (v1.3 이원화 — 모든 함수는 두 트랙 중 하나)

**행위자 식별 규칙은 함수 트랙에 따라 다르다. 단일 규칙("auth.uid()만")은 service_role 함수에서 성립 불가하므로 이원화한다.**

### 트랙 A — authenticated RPC (클라이언트가 직접 호출)

```sql
create or replace function public.fn_name(...)
returns table (col1 type, ...)            -- 반환 컬럼 명시. select * / composite 전체 반환 금지
language plpgsql security definer
set search_path = ''                      -- 필수: 빈 search_path
as $$
begin
  -- 모든 객체는 schema-qualified: private.members, public.posts, auth.uid()
  -- 행위자 = auth.uid()로만 결정. member_id류 인자 금지
  -- 문자열 인자는 길이 검증, 동적 SQL 금지
end $$;
revoke execute on function public.fn_name from public, anon, authenticated;  -- 생성과 같은 트랜잭션
grant  execute on function public.fn_name to authenticated;                  -- 필요한 역할에만 명시적으로
```

### 트랙 B — service_role 전용 함수 (Next 서버 라우트·서버 Cron만 호출)

- service_role 세션에는 사용자 auth.uid()가 없으므로, **행위 대상 회원은 `p_member_id` 인자로 받는다. 단 이 값의 출처는 오직 "Next 서버가 사용자 토큰(세션)을 직접 검증해 얻은 subject"** — 요청 본문·쿼리스트링의 user_id는 절대 신뢰하지 않는다
- 서버 인증 절차 명시: 사용자 요청 처리 라우트는 ①사용자용 클라이언트(요청의 세션 토큰)로 `auth.getUser()` 검증 → ②검증된 `user.id`만 p_member_id로 전달 → ③DB 호출은 별도 service_role 클라이언트로. 두 클라이언트를 한 인스턴스로 혼용 금지, 로그에 토큰·학번·신원값 기록 금지
- 함수 내부는 p_member_id를 재검증: 존재·verification_status·sanction 확인 후 진행 (서버 버그로 잘못된 id가 와도 DB가 최종 방어)
- `EXECUTE`는 service_role에만: `revoke ... from public, anon, authenticated; grant execute ... to service_role;`
- 적용 대상: begin_verification / finalize_verification / claim_guest_read / 계정 삭제 파이프라인 / 배치 함수들. **배치 함수(대상 회원이 조건 검색으로 결정되는 것)는 p_member_id 자체가 없음**
- search_path=''·returns table·schema-qualified 규칙은 트랙 A와 동일

### 공통

- 마이그레이션 서두에 default privileges 제한: `alter default privileges in schema public revoke execute on functions from public;` + 테이블도 anon/authenticated 자동 전권이 생기지 않게 revoke 후 필요한 권한만 재부여 (§1: private 스키마에도 동일 적용)
- **내부 전용 함수**(transition_member_status, begin_verification, finalize_verification, claim_guest_read, 배치 함수들)는 authenticated에 execute를 주지 않음 — service_role 또는 다른 definer 함수에서만 호출. PostgREST 노출 최소화를 위해 가능하면 private 스키마에 배치
- 새 민감 컬럼이 생겨도 RPC 반환에 자동 포함되지 않도록 returns table로 고정

## 3. 회원 온보딩 (v1.1 전면 개정 — 직접 insert 폐기)

```
auth.users 생성 (가입)
  → [DB 트리거 on auth.users] private.members 행 자동 생성
      nickname=NULL, verification_status='pending',
      verification_deadline=now()+7일   ← 삭제 파이프라인 누락 불가능
  → 클라이언트: set_initial_nickname(nick) RPC → 온보딩 완료
```

- nickname은 **초기 NULL 허용**: `check (nickname is null or char_length(...) between 2 and 16)` + `create unique index on private.members (lower(nickname)) where nickname is not null`
- 온보딩 판정 = `nickname is not null` (별도 컬럼 불요). `is_active_member()`/`is_writable_member()`는 온보딩 완료도 요구
- 유일성: **`lower(nickname)` 함수 인덱스** 채택 (citext 확장 의존 회피 — 근거: 확장 하나를 줄이고 정규화 규칙을 코드로 명시). 검증 규칙(초기 설정·변경 공통 함수): trim 후 빈 문자열 금지, NFC 정규화, 연속 공백 1개로, 제어문자·줄바꿈 금지, 금칙어(운영자·관리자·공식·공지·admin 계열 사칭), unique 충돌은 "이미 사용 중인 닉네임" 일반 메시지
- nickname_changed_at: 최초 설정 시 null 유지, **변경 시에만** 기록 (최초/변경 구분)
- members에 대한 클라이언트 직접 insert/update/select 권한: **없음** (private + revoke)
- Auth 트리거 실패가 가입을 막을 수 있으므로 Gate 4a dev 리허설에 실패 케이스 테스트 포함

## 4. 학생 신원 (v1.1 개정)

### 4.1 제출 경로 — 2단계 분리 (v1.3) + 학번 원문은 DB RPC로 보내지 않는다

**v1.2까지의 단일 register_verification은 폐기.** signed URL만 받고 업로드하지 않아도 submitted가 되어 7일 시계가 정지되는 악용(빈 신청으로 기한 동결, 30일 연장 우회)이 가능했다. → begin/finalize 2단계로 분리하고, **불변조건: "파일이 서버 검증을 통과하기 전에는 어떤 경로로도 submitted가 되지 않는다"**.

```
[1단계] POST /api/verification/begin (실명·학번·doc_type)
  서버: ①학번 정규화 ②서버 env의 HMAC 키(현재+보존 중인 과거 버전 전부)로 HMAC 계산
       ③학번 원문 즉시 폐기(로그·오류·분석도구 기록 금지) ④storage 업로드 경로 생성
       ⑤(트랙 B) begin_verification(p_member_id, hmac[], key_ver[], real_name, doc_type) 호출
  DB: enforcement_holds·school_identities를 전 키버전으로 대조
       → 걸리면 "인증할 수 없는 학번" (기존 계정 정보 비노출)
       → 통과 시 request 생성 status='uploading'. **member 상태 불변·삭제 시계 계속 진행**
  서버: 업로드용 단기 signed upload URL 반환 (경로는 서버가 결정: {uid}/{request_id}/{random})

[2단계] POST /api/verification/finalize (request_id)  ← 클라이언트가 업로드 완료 후 호출
  서버: Storage에서 해당 object를 직접 재검증 — 존재·버킷·경로가 request와 일치·
       소유 경로({uid}/ prefix)·크기 10MB 이하·magic bytes 실검증(확장자·Content-Type 불신)
       → 실패 시 submitted 전이 없음 (파일 삭제·안내)
       → 성공 시 (트랙 B) finalize_verification(p_member_id, request_id):
         한 트랜잭션으로 request uploading→submitted + member submitted 전이(삭제 시계 정지)
```

- uploading 24시간 경과 시 finalize 미호출이면 **upload_expired** 전환 + 고아 객체 정리 (배치, §9)
- 동시 제한: **uploading+submitted 합산 회원당 1건** (`unique (member_id) where status in ('uploading','submitted')`)
- finalize ↔ 계정삭제·철회 경합: finalize와 삭제 파이프라인 모두 **member 행을 `for update` 잠금** 후 진행 — 삭제 중 finalize 불가, finalize 중 삭제 대기

- 학번 정규화 규칙 (✅ 사용자 확인 2026-07-20): SNUE 학번 = **8자리 숫자** — 입학년도 4 + 학과코드 2 + 개인번호 2 (예: 20251423). 규칙: trim, 내부 공백·하이픈 제거, `^\d{8}$` 강제, 연도부(앞 4자리)는 1980~현재+1 범위 sanity check, 비정상 입력 거부
- HMAC 응답 비반환. student_no_hmac 자료형: **hex text + `check (char_length(student_no_hmac)=64)`** (bytea 대비 JS 서버와의 왕복 단순 — 근거 명시). school_identities·enforcement_holds 동일 자료형
- 유일성: **`unique (hmac_key_version, student_no_hmac)`** — 동시 승인 중복은 이 제약이 최종 차단(승인 트랜잭션 동시성 테스트 §10)

### 4.2 키 교체·유출 (재계산 불가를 정직하게)

- **원문을 저장하지 않으므로 기존 HMAC을 새 키로 일괄 재계산하는 것은 불가능하다.** "무중단 재계산"이라 쓰지 않는다
- 정상 교체: 새 키 버전 발급 → 신규 인증은 새 버전으로 저장, **중복 대조는 보존 중인 전 버전 키로 각각 계산해 전 버전 행과 대조** → 과거 버전 데이터가 남아 있는 동안 과거 키를 안전 보관
- 유출 시: 유출 버전 폐기 → 해당 버전 인증자는 **재인증 캠페인**으로만 새 HMAC 확보 → 캠페인 기간 동안 해당 버전의 중복 방지 공백을 운영 리스크로 문서화

### 4.3 verification_requests 접근 (직접 select/insert 폐기)

- 본인 조회: `get_my_verification_requests()` → **7필드만** 반환: id, doc_type, status, submitted_at, reviewed_at, reject_reason_code, purged 여부 (hmac·key_version·storage_path·reviewer_id 미반환)
- status 확정 (v1.3): **uploading** / submitted / approved / rejected / **withdrawn** / **upload_expired** / **expired_unreviewed**. 파기 추적은 별도 컬럼: purge_after, purge_started_at, purged_at, purge_attempts, purge_last_error
- 동시 요청 제한: uploading+submitted 합산 회원당 1건 (§4.1)
- 업로드 파일 정책: JPEG/PNG/WebP/PDF만(SVG·HTML 금지), 요청당 1파일, 최대 10MB, 서버가 magic bytes로 실검증(확장자·Content-Type 불신), 비공개 버킷, 심사 열람은 60초 signed URL(이미지 inline·PDF는 브라우저 내장 뷰어 — 허용 형식이 안전 타입뿐), storage_path는 클라이언트 입력 불가(서버 생성 경로만 연결, 업로드 완료 후 서버가 bucket·경로 소유·크기·MIME 재검증)

### 4.4 파기 상태 전이표 (7사유 — v1.3에서 upload_expired 추가)

| 사유 | request | member | Storage | purge_after (큐 진입 시 설정) |
|---|---|---|---|---|
| 승인 후 7일 | approved 유지 | verified 유지 | API 삭제→성공 후 path·real_name null | reviewed_at + 7일 |
| 반려 후 7일 | rejected 유지 | rejected, deadline=반려일+7일 | 동일. 재제출은 새 request | reviewed_at + 7일 |
| 본인 철회 | withdrawn | (uploading 철회면 불변 / submitted 철회면) pending, deadline=철회+7일 | 즉시 파기 대기 | now() |
| 계정 삭제 | (계정과 함께) | deleting | **hold 필요 판정·생성 → Storage 삭제 → 성공 확인 → Auth Admin 삭제 → cascade** (§9 14단계) | now() |
| 업로드 미완 24h | upload_expired | 불변 (uploading은 member 무영향) | 미완·부분 업로드 객체 정리 | begin + 24h |
| 고아 객체 | 행 없음 | — | 생성 24h 경과+정상 request 미참조+verification 버킷 확인 후 삭제 | (request 없음 — **작업 규칙으로만**, CHECK 아님) |
| 장기 미처리 30일 | expired_unreviewed | pending 복귀, deadline+7일 | 24h 내 파기 | now() |

- **purge_after 의미 (v1.3 정정)**: "검토+7일" 고정이 아니라 **큐 진입 시점에 계산된 실제 파기 가능 시각**. 즉시 파기 사유(철회·계정삭제·장기미처리)는 now()로 설정 — "purged_at ≥ purge_after" 류의 사유별 시차 CHECK는 두지 않는다
- CHECK는 구조만 (§10): `purged_at ≥ purge_started_at`, `purged_at not null → storage_path is null`

공통: **Storage API 삭제 성공을 확인한 뒤에만 DB 참조를 지운다** — 실패 시 path 유지+재시도(attempts·last_error 기록), 반복 실패 시 owner 운영 메시지, 파일 이미 없음은 성공 수렴, 배치는 idempotent+페이지네이션.

## 5. 커뮤니티 테이블 상세 (v1.1 개정분)

### 5.1 boards — hidden 비노출 + 역할별 정책 분리 (v1.3)

- **단일 OR 정책 폐기** — anon이 `is_active_member()` 실행 권한 문제를 만나지 않도록 역할별 정책 2개로 분리 (anon에 함수 EXECUTE를 부여하는 해법 금지):
  - `to anon using (access = 'preview')` — 함수 호출 없음
  - `to authenticated using (access = 'preview' or (access = 'members' and public.is_active_member()))`
- **hidden 행은 어떤 일반 조회에도 미반환** — owner 전용 RPC/마이그레이션만. 시드·access 변경은 마이그레이션으로

### 5.2 posts / comments — 작업별 RLS 명세

posts SELECT (USING): `is_active_member() and deleted_at is null and hidden_at is null and board_access_ok(board_id) and not is_blocked_author('post', id)`
posts INSERT (WITH CHECK): `is_writable_member() and board_writable(board_id)` + 트리거(닉네임 강제 기입·owners 기록은 auth.uid() 기준·별칭 0 부여)
posts UPDATE (USING+WITH CHECK 모두): `is_writable_member() and exists(post_owners: auth.uid())`. **클라이언트 직접 UPDATE 대상은 title·body만** (컬럼 grant로 제한). 트리거는 title/body 수정 시 updated_at만 갱신
posts DELETE: 정책 없음 (hard delete 불가)

**⚠️ 소프트 삭제 = definer RPC (v1.4 — dev 실측 결함 수정)**: `deleted_at` 설정을 authenticated UPDATE로 하면, posts_select 정책의 `deleted_at is null` 때문에 **결과 행이 SELECT 가시성을 잃어** PostgreSQL RLS UPDATE(결과 행이 SELECT 정책으로도 보이길 요구)가 "new row violates RLS"로 거부한다 — 작성자가 자기 글을 삭제할 수 없는 결함. 따라서 **soft delete는 `soft_delete_post(post_id)`·`soft_delete_comment(comment_id)` definer RPC로만** (007_soft_delete_rpc.sql). 불변식: authenticated EXECUTE, auth.uid() 판정, is_writable+소유권 검증, `deleted_at is null` 행만, 삭제시각 clock_timestamp(), 존재하지않음·타인·이미삭제는 동일 no-op(존재정보 비노출), comment_count는 실제 1행 삭제 시만 1회 감소. 클라이언트 deleted_at UPDATE 권한 제거. (v1.3의 "soft delete=같은 update 경로"를 대체)

comments: 위와 동일 원칙 + SELECT/INSERT에 **부모 post 열람 가능 조건**(부모가 삭제·숨김·비공개 게시판이면 불가) + 차단 필터.

- `is_blocked_author(content_type, content_id)`: **security definer stable 함수 — RLS USING에 포함**해 Supabase 직접 호출로도 차단 우회 불가 (화면 필터가 아니라 DB 집행). **content_type('post'|'comment')을 시그니처에 포함 (v1.3)** — post_owners/comment_owners 중 어느 표를 해석할지 함수가 인자로 판단. blocks(blocker_id) 인덱스로 비용 관리. **선택 근거**: 원본 select 유지+RLS 필터 (RPC 전면 전환 대비 현행 클라이언트 패턴 보존, 집행 지점은 동일하게 DB)
- 콘텐츠 상태 3+1 구분 (v1.3): `deleted_at`(작성자 삭제) / `hidden_at`(운영 숨김) / **`author_withdrawn_at`(작성자 탈퇴 — §13)**. author_withdrawn_at만 있는 콘텐츠는 **정상 노출**되며 작성자 표시만 "탈퇴한 사용자"로 대체. SELECT 조건은 기존대로 `deleted_at is null and hidden_at is null`만 검사 (withdrawn은 노출 조건에 무관)

### 5.3 blocks — 익명성·해제·한계 (부록 I-2)

```sql
-- private.blocks (v1.3: opaque id를 PK로 승격 — not null·유일성을 DDL로 보장)
id uuid primary key default gen_random_uuid(),   -- 외부 노출용 opaque id
blocker_id uuid not null references private.members on delete cascade,
blocked_id uuid not null references private.members on delete cascade,
created_at timestamptz not null default now(),
unique (blocker_id, blocked_id), check (blocker_id <> blocked_id)
```
- `block_author(type, content_id)`: 자기 자신 차단 거부, **이미 차단·신규 차단 모두 동일한 일반 성공 응답**(unique 충돌 비구분). `list_my_blocks()`: block id·"차단한 사용자"·시각만(blocked_id 미반환). `unblock_author(block_id)`: blocker=auth.uid() 내부 확인
- **제품 한계 (✅ 수용 확정 — 사용자 승인 2026-07-20)**: 사용자 단위 차단은 "차단 후 다른 글이 사라짐"을 통해 차단한 본인에게 콘텐츠 간 제한적 연결 추론을 허용한다. 내부 id·신원은 노출하지 않지만 이 기능적 한계는 제거 불가. 유지되는 안전장치: ①내부 member_id·실제 신원 절대 비노출 ②block_author는 중복 여부 무관 동일 성공 응답 ③차단 목록은 opaque block id+시각만(blocked_id 미노출) ④차단 필터는 RLS/강제된 DB 조회 경계에서 집행 ⑤**두 콘텐츠의 작성자가 같은지 직접 확인해 주는 API는 어떤 형태로도 만들지 않음**

### 5.4 anon_aliases — FK·동시성 확정

- `member_id uuid not null references private.members (id) on delete cascade` (탈퇴 시 연결 삭제, comments.anon_alias_no 표시는 유지 — 화면 영향 없음)
- 번호 부여: 트리거가 **부모 posts 행을 `select … for update`로 잠근 뒤** max+1 부여 — 동시 첫 댓글의 경쟁 상태 제거. (글별 카운터 컬럼 대비: 테이블 하나 덜 만들고 잠금 범위가 글 단위로 자연스러움)

### 5.5 moderation — unique 수정·신고자 보존·스냅샷 축소

```sql
create unique index moderation_cases_one_open_target
  on private.moderation_cases (target_type, target_id) where status = 'open';
```
- (기존 `unique(target_type, target_id, status)` 폐기 — resolved/dismissed 다건이 정상이므로.) 사건 재개는 "기존 open 종결 → 새 open 생성" 순서. `submit_report` 동시 호출의 unique 충돌은 기존 open 사건 조회로 재시도·병합
- reports: `reporter_id uuid references private.members on delete set null` (**cascade 폐기** — 신고자 탈퇴에도 사건 증거·사유 보존, reporter만 익명화). report_count는 사건 함수가 일관 유지
- case_snapshots: **신고 대상 콘텐츠 자체 + 제한 문맥만** — post 신고: title·body / comment 신고: 해당 댓글 body+부모 post title. comments_json 전체 저장 폐기. 최대 100KB, 작성자 내부 id·실명·이메일 미포함. 사건 종결 후 스냅샷 보존기간은 출시 전 정책(개인정보처리방침)에 포함
- moderation_actions: moderator 직접 select 없음 — `get_case()` projection(조치 이력 중 필요 필드만, target_member_id 제외)으로만

### 5.6 operational_messages

- kind에 **'warning' 추가**: verification_approved / verification_rejected / deletion_notice / **warning** / sanction_notice / report_result / system

## 6. 관리자 함수 불변조건 (v1.1 신설 — 대상 역할 상한)

모든 관리 함수 공통: 행위자 verified+sanction none, 행위자=auth.uid()(인자 불신), self-target 금지, 감사 필수.

**대상 상한은 함수가 아니라 호출자 역할이 결정한다 (v1.3)** — 공통 매트릭스 (모든 관리 함수가 동일 적용):

| 호출자 | 조치·조회 가능한 대상 작성자/회원 |
|---|---|
| moderator | member만 |
| operator | member·moderator까지 |
| owner | member·moderator·operator까지 |

- **owner 작성 콘텐츠·owner 계정에 대한 자동 조치는 어떤 함수도 수행하지 않음** — owner 관련 사안은 별도 owner 확인/break-glass 절차로만
- ⚠️ **1인 owner 환경의 구조적 한계 (정직하게 문서화)**: owner 본인이 작성한 콘텐츠에 대한 독립적 심사는 현 인력 구조에서 불가능하다. 신고는 접수·기록되지만 처리 주체가 본인이므로 이해충돌이 존재하며, 이는 운영 인력 확보 전까지 해소 불가

| 함수 | 행위자 | 추가 불변조건 |
|---|---|---|
| moderate_content (숨김/복구/경고/1일 제한) | moderator+ | 대상 회원 id는 내부 해석·미반환. 대상 상한은 위 매트릭스 |
| apply_sanction (7/30일 정지) | operator+ | 더 강한 제재를 약한 것으로 덮어쓰기 금지. 만료 전 해제도 권한+감사. 대상 상한 매트릭스 |
| apply_sanction (banned) | owner | 대상 상한 매트릭스 (owner 제재 금지) |
| grant_role / revoke_role | owner | **마지막 owner 강등·삭제 금지**(count 검사). 역할 변경 시 최근 로그인/재인증 검토(Gate 4b) |
| admin_reveal_author | operator+ | case_id 실재+`case.target = 함수 인자` 일치 검증(무관 사건 차용 차단), 사건 상태 적절성, reason 비공백·길이 검증, 조회+audit 한 트랜잭션. **대상 상한 매트릭스 동일 적용** — operator는 owner 작성 콘텐츠 신원조회 불가 |

- moderate_content와 apply_sanction의 책임 경계: 전자=moderator의 경량 조치 전담, 후자=operator+의 정지·정지 이상 전담 (혼용 서술 금지)

## 7. Storage 파기 — SQL 삭제 전면 폐기 (v1.1 정정)

- **초안의 "storage.objects를 pg_cron으로 delete" 방침은 폐기한다.** 공식 문서상 storage 스키마는 read-only 메타데이터이며 SQL 행 삭제는 실제 파일을 지우지 못하고 고아 객체를 만든다 (supabase.com/docs/guides/storage/schema/design, /management/delete-objects)
- 인증원본 파기·계정 삭제의 Storage 정리는 **서버 스케줄 작업(Vercel Cron → 서버 라우트, service_role) + Storage API `remove()`**로만. 삭제 성공 확인 → path null → 민감 메타 제거. 실패 시 재시도(§4.4 공통 규칙)
- 미인증 계정 삭제와 원본 파기는 **공통 Storage 삭제 모듈**을 공유
- 버킷 프로비저닝: "대시보드/SQL 택일" 폐기 → **Gate 4a 절차에 명시적 단계로**: 서버 프로비저닝 스크립트(Storage API `createBucket`: private, file_size_limit 10MB, allowed_mime_types 지정) + Storage RLS 정책은 SQL 마이그레이션으로. dev·운영 동일 스크립트, 생성 후 public=false 검증

## 8. 비회원 미리보기 (v1.1 개정 — 원자성·쿠키·캐시)

### 원자적 판정 + 콘텐츠 접근조건 검증 (v1.3 통합)
- Route Handler는 검사·기록을 분리 실행하지 않는다. **`claim_guest_read(cookie_hmac, ip_hmac, post_id)`** 단일 definer 함수(트랙 B)가 **quota 판정과 안전한 미리보기 payload 반환까지 한 트랜잭션으로** 수행 — Route가 service_role로 posts를 자유 조회하는 경로를 만들지 않는다
- **호출 경로 (v1.3 보완)**: private 스키마는 PostgREST 미노출이므로 서버 supabase-js RPC가 private 함수를 직접 못 부른다 → **public.claim_guest_read SECURITY DEFINER 래퍼**(EXECUTE는 service_role만)를 노출점으로 두고, 실제 트랜잭션 로직은 private 내부 함수로 분리
- **service_role은 RLS를 우회하므로 함수가 접근조건을 직접 검증 (v1.3)**: ①post 존재 ②`deleted_at is null` ③`hidden_at is null` ④게시판 `access='preview'` ⑤반환하는 최신 댓글 3개도 삭제·숨김 아닌 것만 ⑥반환 필드 allowlist(title·body·표시명·시각·카운트·댓글 3개 — 내부 id·owners·member UUID·HMAC·실명 절대 미포함, 탈퇴 작성자는 "탈퇴한 사용자") — 조건 미충족이면 quota 미차감·미기록으로 즉시 거부
- 판정 순서: 재열람이면 차감·카운트 없이 payload 반환 / 신규면 쿠키 3글+IP 캡을 잠금 하에 원자 확인 → guest_reads insert(+guest_ip_daily 원자 upsert) → view_count 증가 → payload 반환. unique 충돌은 재열람 성공으로 수렴. claim 실패 시 view_count 불변. 숨김 처리와의 경합에도 숨김 콘텐츠 미반환(같은 트랜잭션에서 조건 재확인). **동시 4탭 테스트에서 최대 3글만 통과** (§10)
- **read_date는 인자가 아니라 함수 내부에서 Asia/Seoul 기준으로 결정 (v1.3)** — 클라이언트·서버 시각 불신. IP 캡 값은 서버가 전달하되 함수가 허용범위(양의 정수·상한) 검증
- IP 카운터: `private.guest_ip_daily (ip_hmac, read_date, count)` 원자 upsert 채택 (advisory lock 대비 단순·경합 좁음 — 근거 명시)

### 쿠키 (1년 → 1일)
- `gp=<KST일자>.<128bit id>.<HMAC서명>` — 해당 일자만 유효, 자정 후 새 id 발급. 장기 추적 식별자 제거
- DB에는 쿠키 원 id가 아니라 **서버 HMAC(cookie_hmac)** 저장
- **키 분리**: 쿠키 서명 키 / IP HMAC 키 / 학번 HMAC 키는 서로 다른 키 (목적별 domain separation)

### 응답·캐시
- 상세 Route: `Cache-Control: private, no-store` (본문·quota를 공유 캐시에 남기지 않음). 목록 Route만 짧은 공개 캐시 별도 검토
- quota 초과: **429** + `resetAt`(다음 KST 자정). 쿠키 제한인지 IP 제한인지 **응답에서 구분 비노출**, 오류 응답에 본문·댓글 미포함
- IP 추출: **Vercel 직접 배포 전제 확인 후 Vercel 보장 헤더 사용**(x-vercel-forwarded-for 우선 검토 — vercel.com/docs/headers/request-headers). 상단 프록시 추가 시 신뢰경계 재검토. **파싱 실패 시 IP 백스톱만 생략**(미리보기 전체 거부 아님)+일반 rate limit 별도. 헤더 위조 테스트는 Gate 5
- 정직한 한계: 로그인된 제재 계정의 세션에서는 preview 차단하지만, **로그아웃·다른 브라우저 우회는 공개 미리보기 특성상 완전 방지 불가** (기기 지문 등 과도한 추적 미도입 — 권한표에 이 문구로 기재)

## 9. 스케줄 작업 명세 (v1.1 확장)

| 작업 | 주체 | 함수 | 배치 | 재시도·실패 |
|---|---|---|---|---|
| sanction 만료 | pg_cron 시간당 | `expire_sanctions()` — sanction·until 재확인→none→history→운영메시지를 한 트랜잭션 | 500행 | 실패 로그, 3연속 실패 시 owner 메시지 |
| soft delete 30일 정리 | pg_cron 일 1회 | `purge_soft_deleted_content()` (열린 사건 제외) | 500행 | 동일 |
| **holds 만료 = 식별값 파기** | pg_cron 일 1회 | `purge_expired_holds()` (v1.3 개명) — retention_until 경과 행을 **hard delete** (released_at만 남기고 HMAC을 보관하는 방식 폐기 — 보존기간의 목적이 식별값 파기이므로). 비식별 집계 로그만 | 전량 | 동일 |
| guest_reads·guest_ip_daily TTL | pg_cron 일 1회 | `purge_expired_guest_reads()` | 전량 | 동일 |
| **인증원본 파기** | **서버 Cron 일 1회** | Storage API remove → 성공 시 메타 정리 | 50파일+페이지네이션 | attempts·last_error, idempotent |
| **미인증 계정 삭제** | **서버 Cron 일 1회** | §13 계정 삭제 파이프라인 공용 (미인증 계정은 공개 콘텐츠가 없어 일부 단계가 no-op으로 수렴) | 20계정 | 실패 단계부터 재시도 |
| **업로드 미완 정리** | 서버 Cron 일 1회 | uploading 24h 경과 → upload_expired 전환 + 미완 객체 정리 (v1.3) | 전량 | 동일 |
| 장기 미처리 처리 | 서버 Cron 일 1회 | 3/7일 경고 메시지, 30일 expired_unreviewed 전환+파기 대기열 | — | 동일 |

- pg_cron에는 DB 내부 작업만. Storage/Auth API가 필요한 작업은 전부 서버 스케줄 (§7)
- 모든 배치: idempotent(재실행 안전), 마지막 성공 시각 기록, `CRON_SECRET` 헤더 검증(서버 Cron)

## 10. 인덱스·구조 CHECK·보안 테스트

### 최소 인덱스 (FK는 자동 인덱스가 아님)
`members(verification_status, verification_deadline)` `members(sanction, sanction_until)` `verification_requests(status, purge_after)` `(member_id, submitted_at desc)` `enforcement_holds(retention_until)` `posts(board_id, deleted_at, id desc)` `comments(post_id, deleted_at, id)` `post_owners(user_id)` `comment_owners(user_id)` `blocks(blocker_id)` `blocks(blocked_id)` `moderation_cases(status, opened_at)` `reports(case_id)` `moderation_actions(case_id, created_at)` `operational_messages(member_id, created_at desc)` `guest_reads(expires_at)` `guest_ip_daily(read_date)`

### 구조 CHECK (시각의 "미래 여부"는 함수에서 — CHECK엔 컬럼 간 구조만)
- sanction='none' → sanction_until null / write_restricted·community_suspended → not null / banned → null
- approved → reject_reason_code null·reviewed_at not null / rejected → code not null
- **(v1.3 정정)** `purged_at ≥ purge_started_at` / `purged_at not null → storage_path is null` — "purged_at ≥ purge_after"는 폐기 (즉시 파기 사유와 충돌, §4.4). 고아 객체는 request 행이 없으므로 CHECK가 아니라 배치 작업 규칙으로만
- blocker≠blocked / 카운터 ≥ 0 / slug 형식 `^[a-z0-9-]+$`
- **(v1.3 추가)** posts·comments: `author_withdrawn_at not null → author_nickname is null` (탈퇴 콘텐츠에 원 닉네임 잔존 불가)

### Gate 4a 보안 테스트 (v1.3 — 시점 표현 정정)

**테이블이 Gate 4a에서 생성되므로 "진입 전 테스트"는 성립하지 않는다.** 정확한 시점: Gate 3 완료=본 명세 확정 → 4a 초반=dev 적용 → 4a 중반=dev에서 전 항목 실행 → **운영 초기화 직전=전 항목 통과 보고(통과 없이는 운영 진행 금지)** → 4a 완료=dev 통과+운영 적용+운영 smoke 테스트.
- **함수**: anon·member의 관리/내부 함수 실행 전부 실패, 역할별 허용 함수만 성공, PUBLIC execute 잔존 0개(`information_schema` 검사 쿼리 포함), 전 definer 함수 search_path='' 확인
- **members**: 타인 행·UUID 조회 불가, 보호컬럼 직접 변경 실패, 직접 insert 실패, auth 가입 시 자동 생성, 온보딩 미완료 권한 false
- **RLS**: 미인증·정지·banned의 원본 조회 실패, hidden 게시판 차단, 삭제·숨김 글 차단, 타인 글 수정 실패, write_restricted 작성·추천 실패, 차단 대상 콘텐츠 직접 조회 제외
- **신원**: 요청 응답에 hmac/path/reviewer 미노출, 학번 원문 무로그, 전 키버전 중복 차단, 동시 승인 중복 차단, hold 재인증 차단
- **2단계 제출 (v1.3)**: begin만 하고 업로드 안 하면 member 불변·시계 계속, 빈/타인 경로/초과 크기/위조 magic bytes로 finalize 실패, finalize 성공 시에만 submitted+시계 정지, 24h 후 upload_expired+객체 정리, uploading+submitted 합산 1건 강제, finalize↔삭제 경합 잠금
- **모더레이션**: moderator 응답에 대상 id 없음, 역할 상한 위반 실패, 무관 case 신원조회 실패, 신고자 미노출, 동시 신고 단일 open 수렴, resolved 다건 가능
- **익명·차단**: block 응답 무정보·동일성, 동시 별칭 충돌 없음, 탈퇴 후 별칭 연결 삭제·표시 유지
- **미리보기**: 동시 4요청 3글 상한, 재열람 조회수 1회, 4글째 무본문, 캐시 우회 불가, 오류 응답 동일성, 날짜 전환 시 초기화
- **파기**: API 삭제 성공 후에만 참조 제거, 실패 재시도, 고아·철회·30일 정리, 삭제 계정 hold 선생성, 잔존 JWT 차단, **hold 만료 시 행 hard delete 확인 (v1.3)**
- **탈퇴 콘텐츠 13종 (v1.3 — §13)**: ①비삭제 글·댓글 내용 유지 ②작성자 표시 전원 동일 "탈퇴한 사용자" ③응답에 원 닉네임·member_id·UUID 등 식별자 0건 ④owners·anon_aliases 연결 행 삭제 확인 ⑤탈퇴 전 본인 삭제분 부활 없음 ⑥hidden 유지 ⑦미리보기에서도 "탈퇴한 사용자" 표시 ⑧hold·snapshot이 cascade보다 선행 ⑨연결 제거 실패 시 Auth 삭제 미진행 ⑩실패 단계부터 재시도 멱등 ⑪타인의 댓글·추천·신고·북마크 계속 동작 ⑫30일 hard delete는 기존 정책대로 ⑬탈퇴 글 간 연결 추론 가능한 식별자 부재

## 11. 마이그레이션 구성 (Gate 4a)

0. (서버 스크립트) Storage 버킷 프로비저닝 — §7 방식
1. `001_schemas_roles.sql` — private 스키마, default privileges 제한
2. `002_foundation.sql` — 테이블·인덱스·CHECK·RLS·컬럼 권한·boards 시드
3. `003_functions_triggers.sql` — §2 템플릿 준수 함수·트리거 (+revoke/grant 동일 트랜잭션)
4. `004_schedules.sql` — pg_cron (DB 내부 작업만)
5. Vercel Cron 설정 (서버 작업 3종)
- 기존 `migrations/002_snue_email_restriction.sql` → `archive/`

## 12. 정책 결정 현황 (v1.2 — 사용자 승인 2026-07-20)

1. ✅ **장기 미처리 30일 자동 종료·파기** — 채택 확정. §0 참조 (사과·재제출 안내 포함 조건)
2. ✅ **사용자 단위 차단의 연결 추론 한계** — 수용 확정. §5.3의 안전장치 5종 유지 조건
3. ✅ **enforcement hold 보존기간 유보 방침** — 승인 확정: Gate 4a는 nullable 스키마+짧은 dev 테스트 기한만 / **보존기간 확정 전 production hold 생성 금지**(함수가 거부) / NULL=실질 무기한임을 문서에 유지 / 미확정 상태는 **Gate 7 출시 차단 조건** / 법률 검토 전 영구 보존 기본값 금지
4. (운영 조정값 — 진행 비차단) PREVIEW_IP_DAILY_CAP 최종값, 학번 형식 확인(Gate 4a 전)
5. ✅ **탈퇴자 콘텐츠 유지형** — 사용자 확정 (2026-07-20). 전문은 §13
6. **보존기간 확정 대상 목록 (v1.3 — 전부 Gate 7 출시 차단 조건)**: enforcement_holds에 더해 다음 각각의 **보존 목적·기산점·기간·열린 사건 중 예외·파기 방식·이용자 고지·법적 검토**를 출시 전 개인정보처리방침과 함께 확정해야 한다 —
   ① reports.detail(신고 사유 서술) ② case_snapshots(사건 증거) ③ moderation_actions(조치 이력의 대상 참조) ④ audit_logs ⑤ member_status_history(actor 참조 포함) ⑥ operational_messages ⑦ soft-deleted 콘텐츠(30일 원칙의 사건 예외 상한)

*이 게이트에서 실제로 변경한 것: 이 문서 1건 외 없음.*

## 13. 탈퇴자 콘텐츠 정책 (v1.3 신설 — 사용자 최종 확정, tombstone 삭제형 철회)

### 원칙: 유지형
- **탈퇴해도 본인이 삭제하지 않은 글·댓글은 내용을 유지한다** (커뮤니티 정보 축적 우선). 작성자 표시만 "탈퇴한 사용자"로 대체
- 유지: title·body·created_at·댓글 관계·추천/조회/댓글 수·목록/검색/미리보기 노출. 타인의 댓글·추천·신고·북마크도 계속 동작
- 제거 (신원 연결 일체): nickname(null)·member_id·Auth UUID·이메일·실명·**학번 HMAC(school_identities 및 콘텐츠 연결에서)**·OAuth identity·글 간 연결 식별자. post_owners/comment_owners·anon_aliases 연결 행 삭제
- **예외 (기존 재가입 방지 정책과의 정합)**: banned·활성 제재·열린 사건으로 적법한 hold가 필요한 탈퇴는 enforcement_holds의 HMAC이 **확정된 보존기간 동안** 별도로 남는다 (§0·부록 I-3). hold에는 원문 학번·실명·이메일 비보존 원칙 유지
- **"탈퇴한 사용자 1, 2" 같은 연결 번호 금지** — 전원 동일한 "탈퇴한 사용자" (탈퇴자 글 간 동일인 추론 차단)

### 데이터 모델
- posts·comments에 `author_withdrawn_at timestamptz` 신설 — deleted_at(작성자 삭제)·hidden_at(운영 숨김)과 3상태 구분. withdrawn만 있으면 정상 노출+표시 대체, 어떤 응답에서도 원 nickname 반환 금지
- 탈퇴 전 본인이 삭제한 것: deleted_at 유지·부활 금지·30일 hard delete(열린 사건 예외). hidden도 유지 — **위반 콘텐츠는 탈퇴로 부활하지 않는다**
- 탈퇴자 글 속에 남은 개인정보(본문에 스스로 적은 것)는 신고·삭제요청 경로로 처리

### 계정 삭제 파이프라인 (14단계 — 미인증 삭제·자발 탈퇴 공용)
①deleting 전이(활동 차단) → ②열린 사건·활성 제재 확인 → ③hold 필요 판정·생성(**cascade 전!**) → ④사건 스냅샷 생성 → ⑤본인 삭제분/공개 콘텐츠 구분 → ⑥공개분 author_nickname null+author_withdrawn_at 기록 → ⑦owners·anon_aliases 연결 행 삭제 → ⑧본인 삭제분은 기존 30일 정책 유지 → ⑨Storage API 삭제 → ⑩성공 확인 후 메타 정리 → ⑪Auth Admin 삭제 → ⑫cascade 결과 확인 → ⑬세션 차단 검증 → ⑭비식별 로그
- **⑥⑦(연결 제거) 실패 시 Auth 삭제(⑪) 진행 금지** — 해당 단계부터 재시도. 전 단계 idempotent
- finalize_verification·탈퇴 경합은 member 행 잠금 (§4.1)

### 탈퇴 UX (Gate 5~6 구현)
- 사전 고지: "작성한 글·댓글은 '탈퇴한 사용자' 표시로 유지됩니다. 남기고 싶지 않은 글은 탈퇴 전에 직접 삭제하세요" + 내 글/댓글 목록 확인·개별 삭제 동선 + 정책 확인 체크박스 + 최종 확인 2단계
- 약관·개인정보처리방침에 명시 (법률 검토 대상 — Gate 7)
