-- ============================================================
-- 010_course_review.sql — 강의평가 모듈 (1단계) · v6
--
-- ⚠️ PENDING 초안. 운영은 물론 dev에도 적용하지 않는다.
--    적용 조건: ①GPT 재검수 통과 ②dev 클린 리허설 ③헌장·처리방침 확정 ④사용자 승인
--    동결 RC(001~009)는 재개봉하지 않는다.
--
-- 설계 근거: docs/COURSE_REVIEW_DESIGN.md · docs/DATA_AND_MODERATION_CHARTER.md
--
-- v4 변경 = GPT 3차 검수 REQUIRED 반영:
--   · reviewer_key(HMAC) 폐기 → subject 범위 **무작위 별칭 테이블**.
--     HMAC은 키를 교체하면 같은 사람이 v1/v2 두 값을 갖게 되어 n_reviewers가
--     부풀고 같은 학기 중복 평가까지 뚫린다. 무작위 별칭은 교체할 키가 없다.
--   · 역분개 행이 원 지급행의 ref_type/ref_id/contribution_id를 그대로 복사하도록 강제
--   · 신규 원장 INSERT는 member_id 필수 (주인 없는 지급행 생성 차단)
--   · 공개된 평가가 0건인 페이지에 잠금해제 과금 금지
--   · latest 정렬에 id desc 추가(동률 시 결정성), exam_tips 서술 필드도 제어문자 거부
--
-- v2 변경 = GPT 공동검수 REQUIRED 6건 + Q1~Q4 반영. 고친 결함들:
--   · 두 과목을 동시에 잠금해제하면 두 요청이 같은 잔액을 읽어 음수가 됨 → 회원 행 FOR UPDATE
--   · 활성 슬롯에 corrected가 있어 정정본을 만들 수 없었음(구버전·신버전 유니크 충돌)
--   · 반대로 hidden/preserved가 활성에서 빠져 있어 제재 회원이 새 평가로 우회 가능했음
--   · 철회에 is_active_member를 요구해 정지·banned 회원이 자기 평가를 못 지웠음
--     (개인정보 정정·삭제권은 커뮤니티 활동 권한과 분리해야 한다)
--   · 통계 표본을 count(*)로 세어 한 사람이 여러 학기 평가하면 혼자 k=10을 채울 수 있었음
--   · 탈퇴 시 ON DELETE CASCADE로 강의평이 통째로 사라졌음(익명 존속 정책과 불일치)
--   · 철회 회수액이 -20 고정이라 지급액 정책이 바뀌면 어긋났음 → 실제 원장 행을 역분개
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. 평가 대상 (과목 + 교수)
--    학기는 대상 키에 넣지 않는다(GPT 승인) — 넣으면 표본이 학기별로 쪼개져
--    k=10에 영원히 못 미친다.
--
--    ★ 정규화 키를 별도로 둔다. 원본 courses.json의 교수 필드가 지저분해서
--      (강의실이 섞여 들어간 행이 실재) 같은 교수가 다른 문자열로 중복 등록된다.
--      key는 **검증된 파서가 생성**하고 DB는 그대로 저장한다 — DB 함수가 dirty 원문을
--      임의로 정규화하면 규칙이 두 곳에 생겨 어긋난다.
-- ------------------------------------------------------------
create table if not exists private.course_review_subjects (
  id                    bigserial primary key,
  course_key            text not null check (course_key    ~ '^[0-9a-z가-힣]{1,80}$'),
  professor_key         text not null check (professor_key ~ '^[0-9a-z가-힣]{1,40}$'),
  course_name_display   text not null check (char_length(course_name_display) between 1 and 100),
  professor_display     text not null check (char_length(professor_display)   between 1 and 50),
  created_at            timestamptz not null default now(),
  unique (course_key, professor_key)
);

-- ------------------------------------------------------------
-- 1-2. 작성자 별칭 (subject 범위)
--   HMAC 기반 reviewer_key 방식을 폐기하고 **무작위 별칭**으로 간다.
--   HMAC은 키를 교체하는 순간 같은 사람이 v1/v2 두 값을 갖게 되어
--   n_reviewers가 부풀고 같은 학기 중복 평가까지 가능해진다(GPT 지적).
--   무작위 별칭은 교체할 키가 아예 없고, 과목을 넘는 추적도 불가능하다.
--   탈퇴 시 member_id만 비우면 과거 평가의 "동일 작성자" 집계는 그대로 유지된다.
-- ------------------------------------------------------------
create table if not exists private.course_review_actor_aliases (
  id          uuid primary key default gen_random_uuid(),
  subject_id  bigint not null references private.course_review_subjects (id) on delete cascade,
  member_id   uuid references private.members (id) on delete set null,
  created_at  timestamptz not null default now(),
  detached_at timestamptz,
  -- 별칭이 어느 과목 것인지를 복합 FK로 못 박기 위한 대상 (REQUIRED-010-2)
  unique (id, subject_id)
);
-- 한 과목에서 한 회원은 별칭 1개 (탈퇴로 member_id가 비면 유니크 대상에서 빠진다)
create unique index if not exists course_review_actor_aliases_one
  on private.course_review_actor_aliases (subject_id, member_id) where member_id is not null;

-- 별칭 불변조건 (REQUIRED-010-3)
--  · 최초 INSERT에는 member_id가 반드시 있어야 한다. 처음부터 주인 없는 별칭을
--    만들 수 있으면 definer 함수 결함 하나로 **가짜 작성자 수를 늘려** k=10 게이트를
--    통과시킬 수 있다.
--  · 허용되는 UPDATE는 "탈퇴로 인한 member_id non-null → null" 뿐이고,
--    그때 detached_at을 자동 기록한다. subject_id·id는 불변.
-- (REQUIRED-010-N1) 컬럼을 하나씩 비교하면 created_at 단독 변경, detached_at 임의 설정,
-- "member_id를 null로 만들면서 다른 컬럼도 같이 바꾸기"가 전부 통과한다.
-- 주석이 말하는 만큼 실제로 좁히려면 행 전체를 비교해야 한다(원장과 같은 방식).
create or replace function private.guard_actor_alias()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op = 'INSERT' then
    if new.member_id is null then
      raise exception 'actor alias must be created with a member';
    end if;
    if new.detached_at is not null then
      raise exception 'detached_at is set by withdrawal only';
    end if;
    return new;
  end if;

  -- 탈퇴 전이: member_id와 detached_at 외에는 아무것도 바뀌면 안 된다
  if old.member_id is not null and new.member_id is null then
    if (to_jsonb(new) - 'member_id' - 'detached_at') is distinct from
       (to_jsonb(old) - 'member_id' - 'detached_at') then
      raise exception 'withdrawal may only clear member_id';
    end if;
    new.detached_at := clock_timestamp();   -- 값은 함수가 직접 정한다
    return new;
  end if;

  -- 그 밖에는 완전한 no-op만 허용
  if to_jsonb(new) is distinct from to_jsonb(old) then
    raise exception 'actor alias is immutable (only withdrawal may clear member_id)';
  end if;
  return new;
end $$;
revoke execute on function private.guard_actor_alias() from public, anon, authenticated;

drop trigger if exists course_review_actor_aliases_guard on private.course_review_actor_aliases;
create trigger course_review_actor_aliases_guard
  before insert or update on private.course_review_actor_aliases
  for each row execute function private.guard_actor_alias();

-- (REQUIRED-010-N2) 복합 FK는 "같은 과목 별칭인가"만 본다. 아직 리뷰의 member_id가 A인데
-- 별칭의 member_id는 B인 행이 만들어질 수 있고, 그러면 A가 B의 별칭으로 쓴 셈이 되어
-- 철회·보상 귀속이 어긋난다. 콘텐츠와 별칭의 소유자가 항상 같아야 한다.
-- 회원 삭제 시 두 테이블의 SET NULL 순서가 보장되지 않으므로 **DEFERRABLE**로 둔다
-- (트랜잭션 끝에 한 번만 본다 → 중간의 한쪽만 null인 상태를 허용).
create or replace function private.check_alias_owner_match()
returns trigger language plpgsql set search_path='' as $$
declare v_alias uuid; v_owner uuid; v_content uuid;
begin
  if tg_table_name = 'course_review_actor_aliases' then
    -- 별칭 쪽이 바뀌면 그 별칭을 쓰는 콘텐츠를 전부 재검사
    if exists (select 1 from private.course_reviews r
                where r.actor_alias_id = new.id and r.member_id is distinct from new.member_id)
       or exists (select 1 from private.exam_tips t
                where t.actor_alias_id = new.id and t.member_id is distinct from new.member_id) then
      raise exception 'alias owner must match its content owner';
    end if;
    return null;
  end if;

  v_alias := new.actor_alias_id;
  v_content := new.member_id;
  select a.member_id into v_owner
    from private.course_review_actor_aliases a where a.id = v_alias;
  if v_owner is distinct from v_content then
    raise exception 'content owner must match alias owner';
  end if;
  return null;
end $$;
revoke execute on function private.check_alias_owner_match() from public, anon, authenticated;

-- (트리거 부착은 course_reviews·exam_tips가 만들어진 뒤에 — 파일 아래쪽 참조)

-- 원문 → canonical 매핑 보존 (표기 흔들림 추적용)
create table if not exists private.course_review_subject_aliases (
  subject_id      bigint not null references private.course_review_subjects (id) on delete cascade,
  raw_course      text   not null,
  raw_professor   text   not null,
  first_seen_at   timestamptz not null default now(),
  primary key (subject_id, raw_course, raw_professor)
);

-- ------------------------------------------------------------
-- 2. 강의평가
-- ------------------------------------------------------------
create table if not exists private.course_reviews (
  id            bigserial primary key,
  subject_id    bigint  not null references private.course_review_subjects (id) on delete restrict,

  -- 탈퇴해도 콘텐츠는 익명으로 남긴다 → nullable + SET NULL (REQUIRED-4)
  member_id     uuid    references private.members (id) on delete set null,
  author_withdrawn_at timestamptz,

  -- 작성자 별칭(subject 범위 무작위). 서버만 만들고 클라이언트는 만들거나 입력할 수 없으며,
  -- 일반 RPC·로그·오류 응답에 노출하지 않는다. 탈퇴로 member_id가 비어도 distinct 집계는 유지된다.
  -- FK는 아래에서 (actor_alias_id, subject_id) 복합으로 건다 — 단일 FK만 걸면
  -- 과목 B의 리뷰에 과목 A의 별칭을 넣어도 통과해 과목 간 연결 금지가 깨진다.
  actor_alias_id uuid not null,

  -- ★ 기여(contribution) 식별자 — 최초본과 모든 정정본이 **같은 값**을 공유한다.
  --   보상·도움됨·철회·신고는 리뷰 행 id가 아니라 여기에 귀속시킨다.
  --   이게 없으면: 구버전 100에 +20 지급 → 정정본 101 공개 → 101을 철회할 때
  --   ref_id=101로 지급행을 찾아 **회수가 0건**이 된다(GPT가 잡은 실제 구멍).
  contribution_id uuid not null default gen_random_uuid(),

  semester      text    not null check (semester ~ '^[0-9]{4}-[12]$'),  -- 내부 전용, 공개 금지

  status        text    not null default 'draft' check (status in (
                  'draft','submitted','published','corrected','rejected',
                  'withdrawn_by_author','hidden_by_moderation','preserved_for_case','purged')),

  attendance    text    check (attendance   in ('복합적','전자출결','직접호명','지정좌석','반영안함')),
  exam_count    smallint check (exam_count between 0 and 4),
  assignment    text    check (assignment   in ('없음','보통','많음')),
  team_project  text    check (team_project in ('없음','보통','많음')),
  grading       text    check (grading      in ('너그러움','보통','깐깐함')),

  -- 자유서술: 공백만 있는 값·제어문자 거부 (FOLLOW-UP)
  body              text check (
                      body is null or
                      (btrim(body) <> '' and char_length(body) <= 1000 and body !~ E'[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]')),
  body_reviewed_at  timestamptz,
  -- 운영자 탈퇴가 회원 삭제를 막지 않도록 SET NULL (REQUIRED-4)
  body_reviewed_by  uuid references private.members (id) on delete set null,

  -- 정정 체인: 자기 자신 금지 + 분기 금지(아래 UNIQUE) (REQUIRED-3)
  supersedes_id bigint references private.course_reviews (id),

  published_at  timestamptz,
  withdrawn_at  timestamptz,

  retention_class text not null default 'course_review'
    check (retention_class in ('course_review','case_evidence','legal_hold')),
  purge_after     timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  check (status <> 'published'           or published_at is not null),
  check (status <> 'withdrawn_by_author' or withdrawn_at is not null),
  check (status <> 'published' or body is null or body_reviewed_at is not null),
  check (supersedes_id is null or supersedes_id <> id),

  -- 별칭은 반드시 **같은 과목**의 것이어야 한다 (REQUIRED-010-2)
  foreign key (actor_alias_id, subject_id)
    references private.course_review_actor_aliases (id, subject_id) on delete restrict
);

-- 활성 슬롯을 **둘로 나눈다** (GPT: 정정 심사 중 기존 평가가 사라지면 안 됨)
--   ① 공개/보류 슬롯 1개 — draft·published·hidden·preserved
--      hidden/preserved를 포함해야 제재된 평가를 새로 써서 우회하는 걸 막는다.
--      corrected(구버전)·withdrawn·purged·rejected는 제외.
--   ② 심사 대기 슬롯 1개 — submitted
--      기존 공개본을 유지한 채 정정본이 심사를 기다릴 수 있게 분리했다.
--      한 수강 건에 대기본은 최대 1개.
create unique index if not exists course_reviews_one_live
  on private.course_reviews (subject_id, actor_alias_id, semester)
  where status in ('draft','published','hidden_by_moderation','preserved_for_case');

create unique index if not exists course_reviews_one_pending
  on private.course_reviews (subject_id, actor_alias_id, semester)
  where status = 'submitted';

-- 정정 분기 금지: 한 구버전을 **살아있는** 두 신버전이 대체할 수 없다.
-- 단 반려·철회·파기된 정정본은 제외한다 — 안 그러면 정정이 한 번 반려되면
-- 그 버전은 영영 다시 고칠 수 없게 된다(행동검증에서 실제로 막혔음).
create unique index if not exists course_reviews_supersedes_unique
  on private.course_reviews (supersedes_id)
  where supersedes_id is not null
    and status not in ('rejected','withdrawn_by_author','purged');

create index if not exists course_reviews_subject_published
  on private.course_reviews (subject_id) where status = 'published';

-- ------------------------------------------------------------
-- 3. 시험 경향·준비 팁 (족보 아님 — 첨부파일 컬럼 자체가 없다)
-- ------------------------------------------------------------
create table if not exists private.exam_tips (
  id           bigserial primary key,
  subject_id   bigint not null references private.course_review_subjects (id) on delete restrict,
  member_id    uuid   references private.members (id) on delete set null,
  author_withdrawn_at timestamptz,
  actor_alias_id uuid not null,
  contribution_id uuid not null default gen_random_uuid(),
  semester     text   not null check (semester ~ '^[0-9]{4}-[12]$'),
  status       text   not null default 'draft' check (status in (
                 'draft','submitted','published','withdrawn_by_author','hidden_by_moderation','purged')),
  exam_format  text   check (exam_format in ('객관식','서술형','논술형','실기','혼합')),
  question_count_approx smallint check (question_count_approx between 0 and 200),
  open_book    boolean,
  time_pressure text  check (time_pressure in ('여유','보통','촉박')),
  scope_note   text   check (scope_note is null or (btrim(scope_note) <> '' and char_length(scope_note) <= 500 and scope_note !~ E'[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]')),
  study_tip    text   check (study_tip  is null or (btrim(study_tip)  <> '' and char_length(study_tip)  <= 1000 and study_tip !~ E'[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]')),
  reviewed_at  timestamptz,
  published_at timestamptz,
  purge_after  timestamptz,
  created_at   timestamptz not null default now(),
  -- REQUIRED-5: scope_note·study_tip도 문제 원문·명예훼손이 들어올 수 있어
  --             강의평 자유서술과 동일하게 사전검토를 강제한다.
  check (status <> 'published' or published_at is not null),
  check (status <> 'published' or reviewed_at  is not null),
  foreign key (actor_alias_id, subject_id)
    references private.course_review_actor_aliases (id, subject_id) on delete restrict
);

create unique index if not exists exam_tips_one_active
  on private.exam_tips (subject_id, actor_alias_id, semester)
  where status in ('draft','submitted','published','hidden_by_moderation');

-- 콘텐츠 소유자 = 별칭 소유자 (REQUIRED-010-N2). 두 테이블이 만들어진 뒤 부착한다.
drop trigger if exists course_reviews_alias_owner on private.course_reviews;
create constraint trigger course_reviews_alias_owner
  after insert or update on private.course_reviews
  deferrable initially deferred
  for each row execute function private.check_alias_owner_match();

drop trigger if exists exam_tips_alias_owner on private.exam_tips;
create constraint trigger exam_tips_alias_owner
  after insert or update on private.exam_tips
  deferrable initially deferred
  for each row execute function private.check_alias_owner_match();

drop trigger if exists actor_aliases_owner_match on private.course_review_actor_aliases;
create constraint trigger actor_aliases_owner_match
  after update on private.course_review_actor_aliases
  deferrable initially deferred
  for each row execute function private.check_alias_owner_match();

-- ------------------------------------------------------------
-- 4. 티켓 원장 (불변)
--    잔액 컬럼 없음. 잔액 = sum(delta). 회수는 반대 거래 "추가"로만.
--
--    ★ 음수에 대한 정확한 표현 (GPT 지적):
--      일반 사용자의 소비로는 음수가 될 수 없다(소비 시 잔액 검사 + 회원 행 잠금).
--      다만 운영 역분개(clawback)로는 음수 부채가 생길 수 있고, 이후 적립이
--      먼저 이를 상계한다. 그래서 "쓸 수 있는 잔액"은 greatest(sum,0)이다.
-- ------------------------------------------------------------
create table if not exists private.ticket_ledger (
  id         bigserial primary key,
  -- ⚠️ CASCADE로 두면 안 된다. append-only 트리거가 DELETE를 막기 때문에,
  --    회원 탈퇴 시 cascade DELETE가 트리거에 걸려 **탈퇴 자체가 실패한다**
  --    (§13 계정삭제 배치가 통째로 막힘). dev 행동검증에서 실제로 재현됨.
  --    → 연결만 끊고 원장 행은 가명 상태로 남긴다.
  member_id  uuid    references private.members (id) on delete set null,
  delta      integer not null check (delta <> 0),
  reason     text    not null check (reason in (
               'verification_bonus','review_published','exam_tip_published',
               'helpful_bonus','unlock_subject','clawback')),
  ref_type   text,
  ref_id     bigint,
  -- 강의평 보상은 리뷰 행이 아니라 기여(contribution)에 귀속시킨다 — 정정본이
  -- 생겨도 지급·회수가 같은 대상을 가리키게 하기 위함.
  contribution_id uuid,
  -- 역분개 대상 (REQUIRED / Q4): 어떤 지급을 되돌린 것인지 1:1로 남긴다.
  reverses_entry_id bigint references private.ticket_ledger (id),
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 200),
  created_at timestamptz not null default now(),

  -- REQUIRED-6: 이유와 부호가 어긋나지 않게 못 박는다
  check (
    (reason in ('verification_bonus','review_published','exam_tip_published','helpful_bonus') and delta > 0)
    or (reason in ('unlock_subject','clawback') and delta < 0)
  ),
  check ((reason = 'clawback') = (reverses_entry_id is not null))
);
create index if not exists ticket_ledger_member on private.ticket_ledger (member_id);
-- 한 지급행은 한 번만 역분개된다
create unique index if not exists ticket_ledger_reverse_once
  on private.ticket_ledger (reverses_entry_id) where reverses_entry_id is not null;

-- append-only. 단 **탈퇴에 의한 가명화(member_id → null)** 한 가지만 허용한다.
-- on delete set null은 UPDATE로 수행되므로, 이걸 막으면 회원 탈퇴가 실패한다
-- (dev 행동검증에서 실제로 재현). 금액·이유·키 등 회계 정보는 여전히 불변.
create or replace function private.ticket_ledger_append_only()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ticket_ledger is append-only (회수는 반대 거래를 추가할 것)';
  end if;
  -- member_id를 **제외한 모든 컬럼**이 동일할 때만 통과시킨다.
  -- 컬럼을 하나씩 나열하면 빠뜨린 컬럼(ref_type·ref_id처럼)이 생기고,
  -- "member_id를 null로 만들면서 ref_id도 바꾸는" UPDATE가 통과한다(GPT 지적).
  -- to_jsonb 비교로 두면 나중에 컬럼이 추가돼도 자동으로 보호된다.
  if old.member_id is not null and new.member_id is null
     and (to_jsonb(new) - 'member_id') = (to_jsonb(old) - 'member_id') then
    return new;   -- 탈퇴 가명화만 통과
  end if;
  raise exception 'ticket_ledger is append-only (금액·이유·키·참조 수정 불가)';
end $$;
revoke execute on function private.ticket_ledger_append_only() from public, anon, authenticated;

drop trigger if exists ticket_ledger_no_mutate on private.ticket_ledger;
create trigger ticket_ledger_no_mutate
  before update or delete on private.ticket_ledger
  for each row execute function private.ticket_ledger_append_only();

-- 역분개 정합성 (REQUIRED). UNIQUE는 "중복 역분개"만 막는다. 아래는 DB가
-- 아직 못 막던 것들 — 남의 지급 회수, 금액 불일치, 소비행/회수행의 재역분개.
create or replace function private.validate_ticket_clawback()
returns trigger language plpgsql set search_path='' as $$
declare o private.ticket_ledger%rowtype;
begin
  -- 신규 원장 행은 반드시 회원에 귀속된다. member_id=null 행은 오직 "탈퇴 가명화
  -- UPDATE"로만 만들어져야 한다(처음부터 주인 없는 지급행이 생기면 추적이 끊긴다).
  if new.member_id is null then
    raise exception 'ledger entries must belong to a member at insert time';
  end if;

  if new.reason <> 'clawback' then return new; end if;
  select * into o from private.ticket_ledger l where l.id = new.reverses_entry_id;
  if o.id is null            then raise exception 'reversal target not found'; end if;
  if o.delta <= 0            then raise exception 'can only reverse a positive entry'; end if;
  if o.reason = 'clawback'   then raise exception 'cannot reverse a clawback'; end if;
  if o.member_id is distinct from new.member_id then
    raise exception 'reversal must belong to the same member';
  end if;
  if new.delta <> -o.delta   then raise exception 'reversal must exactly negate the original'; end if;
  -- 역분개 행은 원 지급행의 참조정보를 그대로 복사해야 한다 (계보 보존)
  if new.contribution_id is distinct from o.contribution_id
     or new.ref_type is distinct from o.ref_type
     or new.ref_id   is distinct from o.ref_id then
    raise exception 'reversal must copy ref_type/ref_id/contribution_id of the original';
  end if;
  return new;
end $$;
revoke execute on function private.validate_ticket_clawback() from public, anon, authenticated;

drop trigger if exists ticket_ledger_validate_clawback on private.ticket_ledger;
create trigger ticket_ledger_validate_clawback
  before insert on private.ticket_ledger
  for each row execute function private.validate_ticket_clawback();

-- 탈퇴로 member_id가 비워질 때 author_withdrawn_at을 함께 남긴다.
-- "member_id는 null인데 탈퇴 시각은 모름" 상태를 만들지 않기 위함(REQUIRED-5).
create or replace function private.mark_author_withdrawn()
returns trigger language plpgsql set search_path='' as $$
begin
  if old.member_id is not null and new.member_id is null and new.author_withdrawn_at is null then
    new.author_withdrawn_at := clock_timestamp();
  end if;
  return new;
end $$;
revoke execute on function private.mark_author_withdrawn() from public, anon, authenticated;

drop trigger if exists course_reviews_mark_withdrawn on private.course_reviews;
create trigger course_reviews_mark_withdrawn
  before update on private.course_reviews
  for each row execute function private.mark_author_withdrawn();

drop trigger if exists exam_tips_mark_withdrawn on private.exam_tips;
create trigger exam_tips_mark_withdrawn
  before update on private.exam_tips
  for each row execute function private.mark_author_withdrawn();

-- ------------------------------------------------------------
-- 5. 잠금해제 기록
--    "해제 시점부터 6개월" 유지(GPT 승인). 학사학기로 묶으면 8/31 결제자가
--    9/1에 재과금되어 "최소 한 학기" 원칙이 깨진다.
--    generation으로 재과금 회차를 세어 idempotency_key를 만든다.
-- ------------------------------------------------------------
create table if not exists private.review_unlocks (
  member_id        uuid   not null references private.members (id) on delete cascade,
  subject_id       bigint not null references private.course_review_subjects (id) on delete cascade,
  unlock_generation integer not null default 1 check (unlock_generation >= 1),
  -- ★ 원장 키에 회원 UUID를 넣지 않기 위한 무작위 이벤트 id.
  --   예전 키는 'unlock:<회원UUID>:<subject>:<gen>' 이었는데, 탈퇴로 member_id를
  --   null로 바꿔도 **키 문자열에 원래 Auth UUID가 그대로 남아 가명화가 완성되지
  --   않았다**(GPT 지적). 이제 원장에는 event_id만 남고, 회원과의 연결은 이 표에만
  --   있으므로 탈퇴 시 이 표가 cascade 삭제되면 복원이 불가능해진다.
  unlock_event_id  uuid   not null default gen_random_uuid(),
  unlocked_at      timestamptz not null default now(),
  valid_until      timestamptz not null,
  primary key (member_id, subject_id)
);

-- ------------------------------------------------------------
-- 6. RLS — 정책 0개 = definer 외 전면 거부
-- ------------------------------------------------------------
alter table private.course_review_subjects        enable row level security;
alter table private.course_review_actor_aliases   enable row level security;
alter table private.course_review_subject_aliases enable row level security;
alter table private.course_reviews                enable row level security;
alter table private.exam_tips                     enable row level security;
alter table private.ticket_ledger                 enable row level security;
alter table private.review_unlocks                enable row level security;

revoke all on private.course_review_subjects, private.course_review_actor_aliases,
              private.course_review_subject_aliases,
              private.course_reviews, private.exam_tips,
              private.ticket_ledger, private.review_unlocks
  from anon, authenticated;

-- ------------------------------------------------------------
-- 7. 잔액
--    balance        = 실제 합계(운영 역분개로 음수 가능)
--    spendable      = greatest(balance, 0)  ← 화면·소비 판정은 이걸 쓴다
-- ------------------------------------------------------------
create or replace function public.my_ticket_balance()
returns jsonb language sql security definer set search_path='' stable as $$
  select jsonb_build_object(
    'balance',   coalesce(sum(l.delta), 0)::bigint,
    'spendable', greatest(coalesce(sum(l.delta), 0), 0)::bigint)
    from private.ticket_ledger l
   where l.member_id = auth.uid();
$$;
revoke execute on function public.my_ticket_balance() from public, anon, authenticated;
grant  execute on function public.my_ticket_balance() to authenticated;

-- ------------------------------------------------------------
-- 8. 통계 — k=10 게이트 (표본 = **서로 다른 작성자 수**)
--    count(*)로 세면 한 사람이 여러 학기 평가해 혼자 k를 채울 수 있다(GPT 지적).
--    분포도 작성자별 최신 1건만 반영한다.
-- ------------------------------------------------------------
create or replace function public.course_review_stats(p_subject_id bigint)
returns jsonb language plpgsql security definer set search_path='' stable as $$
declare
  v_reviews   integer;
  v_reviewers integer;
  v_top       text;
  v_top_cnt   integer;
begin
  if not authz.is_active_member() then raise exception 'not allowed'; end if;

  select count(*), count(distinct r.actor_alias_id)
    into v_reviews, v_reviewers
    from private.course_reviews r
   where r.subject_id = p_subject_id and r.status = 'published';

  if v_reviewers >= 10 then
    return (
      with latest as (
        select distinct on (r.actor_alias_id) r.*
          from private.course_reviews r
         where r.subject_id = p_subject_id and r.status = 'published'
         order by r.actor_alias_id, r.published_at desc, r.id desc
      )
      -- ★ 희소 셀 억제 (REQUIRED-4): 작성자가 10명이어도 "보통 9 / 깐깐함 1" 같은
      --   분포는 그 1명의 응답을 사실상 노출한다. 항목 안에 3명 미만인 셀이
      --   하나라도 있으면 **그 항목 전체를 비공개**로 한다. 한 셀만 가리면
      --   총합으로 역산되기 때문(complementary suppression).
      select jsonb_build_object(
        'n_reviews', v_reviews, 'n_reviewers', v_reviewers, 'disclosure', 'full',
        'min_cell', 3,
        'assignment',   (select case when min(c) >= 3 then jsonb_object_agg(a, c) end from (select assignment a, count(*) c from latest where assignment is not null group by 1) t),
        'team_project', (select case when min(c) >= 3 then jsonb_object_agg(a, c) end from (select team_project a, count(*) c from latest where team_project is not null group by 1) t),
        'grading',      (select case when min(c) >= 3 then jsonb_object_agg(a, c) end from (select grading a, count(*) c from latest where grading is not null group by 1) t),
        'attendance',   (select case when min(c) >= 3 then jsonb_object_agg(a, c) end from (select attendance a, count(*) c from latest where attendance is not null group by 1) t))
    );
  end if;

  if v_reviewers >= 5 then
    -- 작성자별 최신 1건으로 접은 뒤 최빈값을 구한다
    select g.grading, g.c into v_top, v_top_cnt
      from (
        select l.grading, count(*) c
          from (select distinct on (r.actor_alias_id) r.actor_alias_id, r.grading, r.published_at
                  from private.course_reviews r
                 where r.subject_id = p_subject_id and r.status = 'published'
                   and r.grading is not null
                 order by r.actor_alias_id, r.published_at desc, r.id desc) l
         group by l.grading
         order by count(*) desc
         limit 1) g;
    -- 최빈값 60% 이상 & 3명 이상일 때만 한 문장
    if v_top_cnt >= 3 and v_top_cnt::numeric / v_reviewers >= 0.6 then
      return jsonb_build_object('n_reviewers', v_reviewers, 'disclosure', 'early', 'trend', v_top);
    end if;
    return jsonb_build_object('n_reviewers', v_reviewers, 'disclosure', 'early', 'trend', null);
  end if;

  -- 1~4명: 개별 후기만. 없는 subject와 0건 subject를 구별하지 않는다(존재 정보 비노출).
  return jsonb_build_object('n_reviewers', v_reviewers, 'disclosure', 'none');
end $$;
revoke execute on function public.course_review_stats(bigint) from public, anon, authenticated;
grant  execute on function public.course_review_stats(bigint) to authenticated;

-- ------------------------------------------------------------
-- 9. 잠금해제 (-5)
--    ★ 회원 행을 FOR UPDATE로 잠근 뒤 잔액 재계산 → 원장 기록 → 해제 갱신을
--      한 트랜잭션으로. 이게 없으면 두 과목을 동시에 해제할 때 두 요청이 같은
--      잔액을 읽어 음수가 된다(GPT가 잡은 실제 경합).
-- ------------------------------------------------------------
create or replace function public.unlock_course_reviews(p_subject_id bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_balance  bigint;
  v_until    timestamptz;
  v_gen      integer;
  v_exists   boolean;
  v_event    uuid;
begin
  if not authz.is_active_member() then raise exception 'not allowed'; end if;

  -- 빈 페이지에 과금하지 않는다 (REQUIRED-6): 대상이 없거나 **공개된 평가가 0건**이면
  -- 원장·해제행을 만들지 않고, 두 경우를 같은 응답으로 수렴시킨다(존재 정보 비노출).
  select exists (
    select 1 from private.course_review_subjects s
     where s.id = p_subject_id
       and exists (select 1 from private.course_reviews r
                    where r.subject_id = s.id and r.status = 'published')
  ) into v_exists;
  if not v_exists then return jsonb_build_object('status','unavailable'); end if;

  -- 회원 단위 직렬화
  perform 1 from private.members m where m.id = auth.uid() for update;

  select u.valid_until, u.unlock_generation into v_until, v_gen
    from private.review_unlocks u
   where u.member_id = auth.uid() and u.subject_id = p_subject_id;

  if v_until is not null and v_until > now() then
    return jsonb_build_object('status','already_unlocked','valid_until',v_until);
  end if;

  select coalesce(sum(l.delta),0) into v_balance
    from private.ticket_ledger l where l.member_id = auth.uid();
  if greatest(v_balance, 0) < 5 then
    return jsonb_build_object('status','insufficient','spendable',greatest(v_balance,0));
  end if;

  v_gen := coalesce(v_gen, 0) + 1;
  v_event := gen_random_uuid();

  -- 원장 키에는 회원 UUID를 넣지 않는다 (탈퇴 후에도 남기 때문)
  insert into private.ticket_ledger (member_id, delta, reason, ref_type, ref_id, idempotency_key)
  values (auth.uid(), -5, 'unlock_subject', 'subject', p_subject_id,
          'unlock:' || v_event::text);

  insert into private.review_unlocks (member_id, subject_id, unlock_generation, unlock_event_id, valid_until)
  values (auth.uid(), p_subject_id, v_gen, v_event, now() + interval '6 months')
  on conflict (member_id, subject_id) do update
    set unlock_generation = excluded.unlock_generation,
        unlock_event_id = excluded.unlock_event_id,
        unlocked_at = now(), valid_until = excluded.valid_until;

  return jsonb_build_object('status','unlocked','valid_until', now() + interval '6 months');
end $$;
revoke execute on function public.unlock_course_reviews(bigint) from public, anon, authenticated;
grant  execute on function public.unlock_course_reviews(bigint) to authenticated;

-- ------------------------------------------------------------
-- 10. 철회 — 작성자 본인
--     ★ is_active_member를 요구하지 않는다 (REQUIRED-2).
--       개인정보 정정·삭제권 행사는 커뮤니티 활동 권한과 분리해야 한다.
--       정지·banned 회원도 자기 평가는 내릴 수 있어야 한다.
--     ★ 회수는 고정값이 아니라 **실제 지급 원장 행을 역분개**한다 (Q4).
--       지급행마다 1건씩 만들어 무엇을 되돌렸는지 감사 가능하게 한다.
-- ------------------------------------------------------------
create or replace function public.withdraw_course_review(p_review_id bigint)
returns void language plpgsql security definer set search_path='' as $$
declare v_contrib uuid;
begin
  if auth.uid() is null then raise exception 'not allowed'; end if;

  -- 현재 활성 버전만 철회 가능 (REQUIRED-3: 이미 corrected된 구버전은 대상 아님)
  update private.course_reviews r
     set status = 'withdrawn_by_author',
         withdrawn_at = clock_timestamp(),
         updated_at   = clock_timestamp(),
         purge_after  = clock_timestamp() + interval '30 days'
   where r.id = p_review_id
     and r.member_id = auth.uid()
     and r.status in ('draft','submitted','published')
  returning r.contribution_id into v_contrib;

  if v_contrib is null then return; end if;  -- 없거나 타인 것이면 no-op (존재 정보 비노출)

  -- ★ 지급행은 **기여(contribution) 단위**로 찾는다. 리뷰 행 id로 찾으면
  --   "구버전에 지급 → 정정본을 철회" 시 회수가 0건이 된다(GPT가 잡은 구멍).
  perform 1 from private.members m where m.id = auth.uid() for update;
  insert into private.ticket_ledger (member_id, delta, reason, ref_type, ref_id,
                                     contribution_id, reverses_entry_id, idempotency_key)
  select l.member_id, -l.delta, 'clawback', l.ref_type, l.ref_id,
         l.contribution_id, l.id, 'reverse:ledger:' || l.id::text
    from private.ticket_ledger l
   where l.member_id = auth.uid()
     and l.contribution_id = v_contrib
     and l.delta > 0
     and not exists (select 1 from private.ticket_ledger x where x.reverses_entry_id = l.id);
end $$;
revoke execute on function public.withdraw_course_review(bigint) from public, anon, authenticated;
grant  execute on function public.withdraw_course_review(bigint) to authenticated;

-- ------------------------------------------------------------
-- 11. 정정본 생성 (correction)
--     "게시 후 원문 덮어쓰기 금지, 대신 정정본"의 실제 경로.
--     구버전 corrected 전환과 신버전 생성이 **한 트랜잭션**이어야 한다.
--
--     ⚠️ 알려진 트레이드오프: 활성 슬롯이 (subject, alias, semester) 하나뿐이라
--     구버전을 내리는 순간 신버전이 검토 대기(submitted)면 그 사이 공개 콘텐츠가
--     없다. 자유서술을 고치는 정정은 재검토가 필요하므로 불가피하다.
--     구조화 항목만 고치는 정정은 body가 없으므로 바로 published로 간다.
--     (검토 중에도 구버전을 보여주려면 활성 슬롯 설계를 바꿔야 하므로 다음 배치 논의)
-- ------------------------------------------------------------
-- p_body_is_set: 자유서술을 "건드리지 않음"과 "비우기"를 구분하기 위한 플래그.
--   coalesce(p_body, old.body)만 쓰면 사용자가 본문을 지울 방법이 없다.
--   false면 기존 본문 유지, true면 p_body 값으로 교체(null이면 삭제).
create or replace function public.correct_course_review(
  p_review_id   bigint,
  p_attendance  text default null,
  p_exam_count  smallint default null,
  p_assignment  text default null,
  p_team_project text default null,
  p_grading     text default null,
  p_body        text default null,
  p_body_is_set boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_old  private.course_reviews%rowtype;
  v_new  bigint;
  v_body text;
  v_body_changed boolean;
begin
  if not authz.is_writable_member() then raise exception 'not allowed'; end if;

  -- 대상 잠금 — 동시에 두 번 정정하면 하나만 성공해야 한다
  select * into v_old from private.course_reviews r
   where r.id = p_review_id for update;
  if v_old.id is null then raise exception 'not found'; end if;
  if v_old.member_id is distinct from auth.uid() then raise exception 'not found'; end if;

  -- 공개 중인 버전만 정정 대상. hidden_by_moderation·preserved_for_case는 차단.
  if v_old.status <> 'published' then
    return jsonb_build_object('status','not_correctable','current',v_old.status);
  end if;

  v_body := case when p_body_is_set then p_body else v_old.body end;
  v_body_changed := v_body is distinct from v_old.body;

  if not v_body_changed then
    -- 구조화 항목만 고치는 정정: 재검토가 필요 없으므로 **원자 교체**.
    update private.course_reviews r
       set status = 'corrected', updated_at = clock_timestamp()
     where r.id = p_review_id;

    insert into private.course_reviews (
      subject_id, member_id, actor_alias_id, contribution_id, semester, status,
      attendance, exam_count, assignment, team_project, grading,
      body, body_reviewed_at, body_reviewed_by, supersedes_id, published_at)
    values (
      v_old.subject_id, v_old.member_id, v_old.actor_alias_id, v_old.contribution_id,
      v_old.semester, 'published',
      coalesce(p_attendance, v_old.attendance),
      coalesce(p_exam_count, v_old.exam_count),
      coalesce(p_assignment, v_old.assignment),
      coalesce(p_team_project, v_old.team_project),
      coalesce(p_grading, v_old.grading),
      v_old.body, v_old.body_reviewed_at, v_old.body_reviewed_by,
      v_old.id, clock_timestamp())
    returning id into v_new;

    return jsonb_build_object('status','ok','mode','swapped','new_review_id',v_new,'new_status','published');
  end if;

  -- ★ 자유서술이 바뀌면 재검토가 필요하다. 이때 기존 공개본을 내리지 않는다 —
  --   심사하는 동안 정상적인 평가가 사라지면 안 되기 때문(GPT 지적).
  --   정정본만 submitted로 대기시키고, 승인 시점에 원자 교체한다.
  insert into private.course_reviews (
    subject_id, member_id, actor_alias_id, contribution_id, semester, status,
    attendance, exam_count, assignment, team_project, grading, body, supersedes_id)
  values (
    v_old.subject_id, v_old.member_id, v_old.actor_alias_id, v_old.contribution_id,
    v_old.semester, 'submitted',
    coalesce(p_attendance, v_old.attendance),
    coalesce(p_exam_count, v_old.exam_count),
    coalesce(p_assignment, v_old.assignment),
    coalesce(p_team_project, v_old.team_project),
    coalesce(p_grading, v_old.grading),
    v_body, v_old.id)
  returning id into v_new;

  -- 정정에는 보상을 다시 주지 않는다 (원장에 아무것도 넣지 않음)
  return jsonb_build_object('status','ok','mode','pending_review',
                            'new_review_id',v_new,'new_status','submitted');
end $$;
revoke execute on function public.correct_course_review(bigint, text, smallint, text, text, text, text, boolean)
  from public, anon, authenticated;
grant  execute on function public.correct_course_review(bigint, text, smallint, text, text, text, text, boolean)
  to authenticated;

-- ------------------------------------------------------------
-- 12. 정정본 심사 (operator) — 승인 시 원자 교체, 반려 시 기존본 유지
-- ------------------------------------------------------------
create or replace function public.review_course_correction(
  p_review_id bigint, p_approve boolean, p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_role text; v_pending private.course_reviews%rowtype; v_live bigint;
begin
  v_role := private.actor_role_check('operator');
  if p_approve is null then raise exception 'decision required'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'reason required'; end if;
  if char_length(btrim(p_reason)) > 500 then raise exception 'reason too long'; end if;

  select * into v_pending from private.course_reviews r
   where r.id = p_review_id and r.status = 'submitted' for update;
  if v_pending.id is null then
    return jsonb_build_object('status','not_pending');
  end if;

  -- 자기 정정본을 스스로 승인·반려할 수 없다. 사전검토의 의미가 없어진다.
  -- (1인 owner의 자유서술 정정은 다른 심사자가 생길 때까지 기존 공개본을 유지하거나
  --  본인이 철회하는 것으로 수렴한다 — 자동 승인 경로를 만들지 않는다.)
  if v_pending.member_id is not null and v_pending.member_id = auth.uid() then
    raise exception 'cannot review your own correction';
  end if;

  if p_approve then
    -- 기존 공개본을 내리고 정정본을 올린다 — 같은 트랜잭션
    update private.course_reviews r
       set status = 'corrected', updated_at = clock_timestamp()
     where r.subject_id = v_pending.subject_id
       and r.actor_alias_id = v_pending.actor_alias_id
       and r.semester = v_pending.semester
       and r.status = 'published'
    returning r.id into v_live;

    update private.course_reviews r
       set status = 'published',
           published_at = clock_timestamp(),
           body_reviewed_at = case when r.body is not null then clock_timestamp() end,
           body_reviewed_by = case when r.body is not null then auth.uid() end,
           updated_at = clock_timestamp()
     where r.id = p_review_id;
  else
    -- 반려: 기존 공개본은 그대로 두고 정정본만 내린다
    update private.course_reviews r
       set status = 'rejected', updated_at = clock_timestamp()
     where r.id = p_review_id;
  end if;

  insert into private.audit_logs (actor_id, action, target_type, target_id, reason)
  values (auth.uid(), 'course_correction:' || case when p_approve then 'approve' else 'reject' end,
          'course_review', p_review_id::text, p_reason);

  -- ★ 승인해도 보상을 다시 주지 않는다 (contribution당 1회)
  return jsonb_build_object('status','ok','approved',p_approve,'replaced_review_id',v_live);
end $$;
revoke execute on function public.review_course_correction(bigint, boolean, text)
  from public, anon, authenticated;
grant  execute on function public.review_course_correction(bigint, boolean, text) to authenticated;

commit;

-- ============================================================
-- 다음 배치 (이 초안의 범위 밖)
--  · submit/correct RPC — 구버전 corrected 전환 + 신버전 생성을 한 트랜잭션으로.
--    supersedes는 같은 subject/actor_alias_id/semester만 허용해야 한다.
--  · operator 승인 RPC (자유서술 사전검토 → published + 지급).
--    지급 idempotency_key는 review id가 아니라 수강 건 귀속:
--    'review_reward:<contribution_id>' — 별칭을 키 문자열에 넣지 않는다(식별자 분리).
--  · 신고 연결(private.reports·moderation_cases ↔ course_reviews)
--  · preserved_for_case ↔ purge 배치 (009 서버잡 패턴 재사용)
--  · 도움됨 집계와 후기당 상한 +6
--  · 공개 목록 RPC (작성자 속성 0개, 성적확정 후 묶음 공개 지연)
--  -- ============================================================
