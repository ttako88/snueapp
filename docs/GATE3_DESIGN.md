# Gate 3 — 커뮤니티 기반 설계 확정서

- 작성: 2026-07-20, Claude (Fable 5) / **v1.2** — GPT 공동검수 30개 항목 반영 + 사용자 정책 결정 3건 확정 반영 (§0·§5.3·§12)
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
| 조회수 | 참고 통계 (탈퇴→재가입 재조회 시 중복 가능. 보안·회계 수치 아님) | |

## 1. 스키마 분리 원칙 (v1.1 신설)

**PostgREST 노출 스키마(public)와 내부 스키마(private)를 분리한다.** private의 테이블은 API에 존재 자체가 없다 — "RLS 정책 0개"에 더해 노출 표면을 원천 제거.

| 스키마 | 테이블 | 클라이언트 접근 |
|---|---|---|
| **public** | boards, posts, comments, post_owners, comment_owners, post_votes, bookmarks, operational_messages | RLS 하에 직접 CRUD (부록 C 표) |
| **private** | members, school_identities, verification_requests, enforcement_holds, member_status_history, anon_aliases, post_views, blocks, reports, moderation_cases, case_snapshots, moderation_actions, audit_logs, guest_reads | **직접 접근 불가 — 지정된 RPC/서버 경유만** |

- private 테이블도 RLS✔ + 정책 0개 + `revoke all from anon, authenticated` **삼중 차단** ("RLS 없음"과 "테이블 권한 없음"을 모두 적용)
- members가 private로 간 결과: 클라이언트는 members를 직접 읽거나 쓸 수 없고, `get_my_member()`·`set_initial_nickname()`·`change_nickname()` RPC만 사용. **내부 UUID·타인 상태·역할이 API에 노출될 경로 자체가 없음**

## 2. SECURITY DEFINER 공통 템플릿 (v1.1 신설 — 모든 함수 필수)

```sql
create or replace function public.fn_name(...)
returns table (col1 type, ...)            -- 반환 컬럼 명시. select * / composite 전체 반환 금지
language plpgsql security definer
set search_path = ''                      -- 필수: 빈 search_path
as $$
begin
  -- 모든 객체는 schema-qualified: private.members, public.posts, auth.uid()
  -- 행위자는 인자가 아니라 auth.uid()로만 결정
  -- 문자열 인자는 길이 검증, 동적 SQL 금지
end $$;
revoke execute on function public.fn_name from public, anon, authenticated;  -- 생성과 같은 트랜잭션
grant  execute on function public.fn_name to authenticated;                  -- 필요한 역할에만 명시적으로
```

- 마이그레이션 서두에 default privileges 제한: `alter default privileges in schema public revoke execute on functions from public;` + 테이블도 anon/authenticated 자동 전권이 생기지 않게 revoke 후 필요한 권한만 재부여
- **내부 전용 함수**(transition_member_status, register_verification, claim_guest_read, 배치 함수들)는 authenticated에도 execute를 주지 않음 — service_role 또는 다른 definer 함수에서만 호출. PostgREST 노출 최소화를 위해 가능하면 private 스키마에 배치
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

### 4.1 제출 경로 — 학번 원문은 DB RPC로 보내지 않는다

```
클라이언트 ──(HTTPS POST /api/verification/submit: 실명·학번·doc_type)──▶ Next 서버 라우트
  서버: ①학번 정규화 ②서버 env의 HMAC 키(현재+보존 중인 과거 버전 전부)로 HMAC 계산
       ③학번 원문 즉시 폐기(로그·오류·분석도구 기록 금지) ④storage 업로드 경로 생성
       ⑤service_role로 private 함수 register_verification(hmac[], key_ver[], real_name, doc_type) 호출
  DB(내부 함수): enforcement_holds·school_identities를 전 키버전으로 대조
       → 걸리면 "인증할 수 없는 학번" (기존 계정 정보 비노출) / 통과 시 request 생성+submitted 전이
  서버: 업로드용 단기 signed upload URL 반환 (경로는 서버가 결정: {uid}/{request_id}/{random})
```

- 학번 정규화 규칙: trim, 내부 공백·하이픈 제거, 숫자만 허용, **허용 길이는 실제 SNUE 학번 형식 확인 후 확정 (Gate 4a 이전 확인 항목 — 임의 확정하지 않음)**, 비정상 입력 거부
- HMAC 응답 비반환. student_no_hmac 자료형: **hex text + `check (char_length(student_no_hmac)=64)`** (bytea 대비 JS 서버와의 왕복 단순 — 근거 명시). school_identities·enforcement_holds 동일 자료형
- 유일성: **`unique (hmac_key_version, student_no_hmac)`** — 동시 승인 중복은 이 제약이 최종 차단(승인 트랜잭션 동시성 테스트 §10)

### 4.2 키 교체·유출 (재계산 불가를 정직하게)

- **원문을 저장하지 않으므로 기존 HMAC을 새 키로 일괄 재계산하는 것은 불가능하다.** "무중단 재계산"이라 쓰지 않는다
- 정상 교체: 새 키 버전 발급 → 신규 인증은 새 버전으로 저장, **중복 대조는 보존 중인 전 버전 키로 각각 계산해 전 버전 행과 대조** → 과거 버전 데이터가 남아 있는 동안 과거 키를 안전 보관
- 유출 시: 유출 버전 폐기 → 해당 버전 인증자는 **재인증 캠페인**으로만 새 HMAC 확보 → 캠페인 기간 동안 해당 버전의 중복 방지 공백을 운영 리스크로 문서화

### 4.3 verification_requests 접근 (직접 select/insert 폐기)

- 본인 조회: `get_my_verification_requests()` → **id, doc_type, status, submitted_at, reviewed_at, reject_reason_code, purged 여부만** 반환 (hmac·key_version·storage_path·reviewer_id 미반환)
- status: submitted / approved / rejected / **withdrawn** / **expired_unreviewed**. 파기 추적은 별도 컬럼: purge_after, purge_started_at, purged_at, purge_attempts, purge_last_error
- 동시 submitted 요청: 회원당 1건 (`unique (member_id) where status='submitted'`)
- 업로드 파일 정책: JPEG/PNG/WebP/PDF만(SVG·HTML 금지), 요청당 1파일, 최대 10MB, 서버가 magic bytes로 실검증(확장자·Content-Type 불신), 비공개 버킷, 심사 열람은 60초 signed URL(이미지 inline·PDF는 브라우저 내장 뷰어 — 허용 형식이 안전 타입뿐), storage_path는 클라이언트 입력 불가(서버 생성 경로만 연결, 업로드 완료 후 서버가 bucket·경로 소유·크기·MIME 재검증)

### 4.4 파기 상태 전이표 (부록 E와 동일 — 6사유)

| 사유 | request | member | Storage | 비고 |
|---|---|---|---|---|
| 승인 후 7일 | approved 유지 | verified 유지 | API 삭제→성공 후 path·real_name null | school_identities는 정책대로 유지 |
| 반려 후 7일 | rejected 유지 | rejected, deadline=반려일+7일 | 동일 | 재제출은 새 request |
| 본인 철회 | withdrawn | pending, deadline=철회+7일 | 즉시 파기 대기 | 철회↔새 제출 경합은 submitted unique가 차단 |
| 계정 삭제 | (계정과 함께) | deleting | **hold 필요 판정·생성 → Storage 삭제 → 성공 확인 → Auth Admin 삭제 → cascade** | hold가 cascade보다 반드시 먼저 (§9) |
| 고아 객체 | 행 없음 | — | 생성 24h 경과+정상 request 미참조+verification 버킷 확인 후 삭제 | |
| 장기 미처리 30일 | expired_unreviewed | pending 복귀, deadline+7일 | 24h 내 파기 | 제재·반려 이력 미부여. 운영 메시지 발송 |

공통: **Storage API 삭제 성공을 확인한 뒤에만 DB 참조를 지운다** — 실패 시 path 유지+재시도(attempts·last_error 기록), 반복 실패 시 owner 운영 메시지, 파일 이미 없음은 성공 수렴, 배치는 idempotent+페이지네이션.

## 5. 커뮤니티 테이블 상세 (v1.1 개정분)

### 5.1 boards — hidden 비노출

- RLS select: `access='preview'` (anon 포함 모두) OR `access='members' and is_active_member()`. **hidden 행은 어떤 일반 조회에도 미반환** — owner 전용 RPC/마이그레이션만. 시드·access 변경은 마이그레이션으로

### 5.2 posts / comments — 작업별 RLS 명세

posts SELECT (USING): `is_active_member() and deleted_at is null and board_access_ok(board_id) and not is_blocked_author(id)`
posts INSERT (WITH CHECK): `is_writable_member() and board_writable(board_id)` + 트리거(닉네임 강제 기입·owners 기록은 auth.uid() 기준·별칭 0 부여)
posts UPDATE (USING+WITH CHECK 모두): `is_writable_member() and exists(post_owners: auth.uid())` + 트리거가 board_id·카운터·author 표시·created_at 변경 거부. soft delete(deleted_at 설정)는 같은 update 경로, 일반 수정과 함께 작성자 본인만
posts DELETE: 정책 없음 (hard delete 불가)

comments: 위와 동일 원칙 + SELECT/INSERT에 **부모 post 열람 가능 조건**(부모가 삭제·숨김·비공개 게시판이면 불가) + 차단 필터.

- `is_blocked_author(content_id)`: **security definer stable 함수 — RLS USING에 포함**해 Supabase 직접 호출로도 차단 우회 불가 (화면 필터가 아니라 DB 집행). blocks(blocker_id) 인덱스로 비용 관리. **선택 근거**: 원본 select 유지+RLS 필터 (RPC 전면 전환 대비 현행 클라이언트 패턴 보존, 집행 지점은 동일하게 DB)
- 숨김(hide_content): `hidden_at` 컬럼 추가 — deleted_at(작성자 삭제)과 구분. SELECT 조건에 `hidden_at is null` 포함, 운영 조회는 definer 경유

### 5.3 blocks — 익명성·해제·한계 (부록 I-2)

```sql
-- private.blocks
id uuid default gen_random_uuid(),  -- 외부 노출용 opaque id
blocker_id uuid references private.members on delete cascade,
blocked_id uuid references private.members on delete cascade,
created_at, primary key (blocker_id, blocked_id), check (blocker_id <> blocked_id)
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

| 함수 | 행위자 | 대상 상한 | 추가 불변조건 |
|---|---|---|---|
| moderate_content (숨김/복구/경고/1일 제한) | moderator+ | **member만** | 대상 회원 id는 내부 해석·미반환 |
| apply_sanction (7/30일 정지) | operator+ | member·moderator까지 | 더 강한 제재를 약한 것으로 덮어쓰기 금지. 만료 전 해제도 권한+감사 |
| apply_sanction (banned) | owner | operator까지 | owner 제재는 금지(정책) |
| grant_role / revoke_role | owner | — | **마지막 owner 강등·삭제 금지**(count 검사). 역할 변경 시 최근 로그인/재인증 검토(Gate 4b) |
| admin_reveal_author | operator+ | — | case_id 실재+`case.target = 함수 인자` 일치 검증(무관 사건 차용 차단), 사건 상태 적절성, reason 비공백·길이 검증, 조회+audit 한 트랜잭션 |

- moderate_content와 apply_sanction의 책임 경계: 전자=moderator의 경량 조치 전담, 후자=operator+의 정지·정지 이상 전담 (혼용 서술 금지)

## 7. Storage 파기 — SQL 삭제 전면 폐기 (v1.1 정정)

- **초안의 "storage.objects를 pg_cron으로 delete" 방침은 폐기한다.** 공식 문서상 storage 스키마는 read-only 메타데이터이며 SQL 행 삭제는 실제 파일을 지우지 못하고 고아 객체를 만든다 (supabase.com/docs/guides/storage/schema/design, /management/delete-objects)
- 인증원본 파기·계정 삭제의 Storage 정리는 **서버 스케줄 작업(Vercel Cron → 서버 라우트, service_role) + Storage API `remove()`**로만. 삭제 성공 확인 → path null → 민감 메타 제거. 실패 시 재시도(§4.4 공통 규칙)
- 미인증 계정 삭제와 원본 파기는 **공통 Storage 삭제 모듈**을 공유
- 버킷 프로비저닝: "대시보드/SQL 택일" 폐기 → **Gate 4a 절차에 명시적 단계로**: 서버 프로비저닝 스크립트(Storage API `createBucket`: private, file_size_limit 10MB, allowed_mime_types 지정) + Storage RLS 정책은 SQL 마이그레이션으로. dev·운영 동일 스크립트, 생성 후 public=false 검증

## 8. 비회원 미리보기 (v1.1 개정 — 원자성·쿠키·캐시)

### 원자적 판정
- Route Handler는 검사·기록을 분리 실행하지 않는다. **`private.claim_guest_read(cookie_hmac, ip_hmac, post_id, read_date)`** 단일 definer 함수(execute는 service_role만)가 한 트랜잭션으로: 재열람이면 차감·카운트 없이 허용 반환 / 신규면 쿠키 3글+IP 캡을 잠금 하에 원자 확인 → guest_reads insert(+일별 IP 카운터 원자 upsert) → view_count 증가. unique 충돌은 재열람 성공으로 수렴. **동시 4탭 테스트에서 최대 3글만 통과** (§10)
- IP 카운터: `guest_ip_daily (ip_hmac, read_date, count)` 원자 upsert 채택 (advisory lock 대비 단순·경합 좁음 — 근거 명시)

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
| holds 만료 | pg_cron 일 1회 | `release_expired_holds()` | 전량 | 동일 |
| guest_reads·ip 카운터 TTL | pg_cron 일 1회 | `purge_expired_guest_reads()` | 전량 | 동일 |
| **인증원본 파기** | **서버 Cron 일 1회** | Storage API remove → 성공 시 메타 정리 | 50파일+페이지네이션 | attempts·last_error, idempotent |
| **미인증 계정 삭제** | **서버 Cron 일 1회** | 7단계 파이프라인 — **①hold 필요 판정·생성(cascade 전!)** ②deleting 마킹 ③Storage 삭제 ④메타 정리 ⑤Auth Admin 삭제 ⑥세션 차단 검증 ⑦비식별 로그 | 20계정 | 실패 단계부터 재시도 |
| 장기 미처리 처리 | 서버 Cron 일 1회 | 3/7일 경고 메시지, 30일 expired_unreviewed 전환+파기 대기열 | — | 동일 |

- pg_cron에는 DB 내부 작업만. Storage/Auth API가 필요한 작업은 전부 서버 스케줄 (§7)
- 모든 배치: idempotent(재실행 안전), 마지막 성공 시각 기록, `CRON_SECRET` 헤더 검증(서버 Cron)

## 10. 인덱스·구조 CHECK·보안 테스트

### 최소 인덱스 (FK는 자동 인덱스가 아님)
`members(verification_status, verification_deadline)` `members(sanction, sanction_until)` `verification_requests(status, purge_after)` `(member_id, submitted_at desc)` `enforcement_holds(retention_until)` `posts(board_id, deleted_at, id desc)` `comments(post_id, deleted_at, id)` `post_owners(user_id)` `comment_owners(user_id)` `blocks(blocker_id)` `blocks(blocked_id)` `moderation_cases(status, opened_at)` `reports(case_id)` `moderation_actions(case_id, created_at)` `operational_messages(member_id, created_at desc)` `guest_reads(expires_at)` `guest_ip_daily(read_date)`

### 구조 CHECK (시각의 "미래 여부"는 함수에서 — CHECK엔 컬럼 간 구조만)
- sanction='none' → sanction_until null / write_restricted·community_suspended → not null / banned → null
- approved → reject_reason_code null·reviewed_at not null / rejected → code not null
- purged_at은 purge_after 이후 / blocker≠blocked / 카운터 ≥ 0 / slug 형식 `^[a-z0-9-]+$`

### Gate 4a 진입 전 필수 보안 테스트 (dev에서 전 항목 통과가 완료 조건)
- **함수**: anon·member의 관리/내부 함수 실행 전부 실패, 역할별 허용 함수만 성공, PUBLIC execute 잔존 0개(`information_schema` 검사 쿼리 포함), 전 definer 함수 search_path='' 확인
- **members**: 타인 행·UUID 조회 불가, 보호컬럼 직접 변경 실패, 직접 insert 실패, auth 가입 시 자동 생성, 온보딩 미완료 권한 false
- **RLS**: 미인증·정지·banned의 원본 조회 실패, hidden 게시판 차단, 삭제·숨김 글 차단, 타인 글 수정 실패, write_restricted 작성·추천 실패, 차단 대상 콘텐츠 직접 조회 제외
- **신원**: 요청 응답에 hmac/path/reviewer 미노출, 학번 원문 무로그, 전 키버전 중복 차단, 동시 승인 중복 차단, hold 재인증 차단
- **모더레이션**: moderator 응답에 대상 id 없음, 역할 상한 위반 실패, 무관 case 신원조회 실패, 신고자 미노출, 동시 신고 단일 open 수렴, resolved 다건 가능
- **익명·차단**: block 응답 무정보·동일성, 동시 별칭 충돌 없음, 탈퇴 후 별칭 연결 삭제·표시 유지
- **미리보기**: 동시 4요청 3글 상한, 재열람 조회수 1회, 4글째 무본문, 캐시 우회 불가, 오류 응답 동일성, 날짜 전환 시 초기화
- **파기**: API 삭제 성공 후에만 참조 제거, 실패 재시도, 고아·철회·30일 정리, 삭제 계정 hold 선생성, 잔존 JWT 차단

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

*이 게이트에서 실제로 변경한 것: 이 문서 1건 외 없음.*
