-- ============================================================
-- 010_course_review.sql — 강의평가 모듈 (1단계) · v2
--
-- ⚠️ PENDING 초안. 운영은 물론 dev에도 적용하지 않는다.
--    적용 조건: ①GPT 재검수 통과 ②dev 클린 리허설 ③헌장·처리방침 확정 ④사용자 승인
--    동결 RC(001~009)는 재개봉하지 않는다.
--
-- 설계 근거: docs/COURSE_REVIEW_DESIGN.md · docs/DATA_AND_MODERATION_CHARTER.md
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

  -- 표본 중복 방지용 가명키. 대상(subject) 범위로만 안정적이라 과목을 넘나드는
  -- 추적에 쓸 수 없다. 탈퇴로 member_id가 null이 돼도 distinct 집계가 유지된다.
  -- ⚠️ 운영 승격 전 md5 → 서버 비밀키 HMAC으로 교체할 것(학번 HMAC과 동일 원칙).
  reviewer_key  text    not null,

  semester      text    not null check (semester ~ '^[0-9]{4}-[12]$'),  -- 내부 전용, 공개 금지

  status        text    not null default 'draft' check (status in (
                  'draft','submitted','published','corrected',
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
  check (supersedes_id is null or supersedes_id <> id)
);

-- 활성 슬롯 (REQUIRED-1)
--  포함: draft·submitted·published·hidden_by_moderation·preserved_for_case
--        └ hidden/preserved를 넣어야 제재된 평가를 새로 써서 우회하는 걸 막는다.
--  제외: corrected(구버전)·withdrawn_by_author·purged
--        └ corrected를 빼야 "구버전 corrected + 신버전 published" 공존이 가능하다.
create unique index if not exists course_reviews_one_active
  on private.course_reviews (subject_id, reviewer_key, semester)
  where status in ('draft','submitted','published','hidden_by_moderation','preserved_for_case');

-- 정정 분기 금지: 한 구버전을 두 신버전이 대체할 수 없다
create unique index if not exists course_reviews_supersedes_unique
  on private.course_reviews (supersedes_id) where supersedes_id is not null;

create index if not exists course_reviews_subject_published
  on private.course_reviews (subject_id) where status = 'published';

-- ------------------------------------------------------------
-- 3. 시험 경향·준비 팁 (족보 아님 — 첨부파일 컬럼 자체가 없다)
-- ------------------------------------------------------------
create table if not exists private.exam_tips (
  id           bigserial primary key,
  subject_id   bigint not null references private.course_review_subjects (id) on delete restrict,
  member_id    uuid   references private.members (id) on delete set null,
  reviewer_key text   not null,
  semester     text   not null check (semester ~ '^[0-9]{4}-[12]$'),
  status       text   not null default 'draft' check (status in (
                 'draft','submitted','published','withdrawn_by_author','hidden_by_moderation','purged')),
  exam_format  text   check (exam_format in ('객관식','서술형','논술형','실기','혼합')),
  question_count_approx smallint check (question_count_approx between 0 and 200),
  open_book    boolean,
  time_pressure text  check (time_pressure in ('여유','보통','촉박')),
  scope_note   text   check (scope_note is null or (btrim(scope_note) <> '' and char_length(scope_note) <= 500)),
  study_tip    text   check (study_tip  is null or (btrim(study_tip)  <> '' and char_length(study_tip)  <= 1000)),
  reviewed_at  timestamptz,
  published_at timestamptz,
  purge_after  timestamptz,
  created_at   timestamptz not null default now(),
  -- REQUIRED-5: scope_note·study_tip도 문제 원문·명예훼손이 들어올 수 있어
  --             강의평 자유서술과 동일하게 사전검토를 강제한다.
  check (status <> 'published' or published_at is not null),
  check (status <> 'published' or reviewed_at  is not null)
);

create unique index if not exists exam_tips_one_active
  on private.exam_tips (subject_id, reviewer_key, semester)
  where status in ('draft','submitted','published','hidden_by_moderation');

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
  if old.member_id is not null and new.member_id is null
     and new.id = old.id
     and new.delta = old.delta
     and new.reason = old.reason
     and new.idempotency_key = old.idempotency_key
     and new.reverses_entry_id is not distinct from old.reverses_entry_id
     and new.created_at = old.created_at then
    return new;   -- 탈퇴 가명화만 통과
  end if;
  raise exception 'ticket_ledger is append-only (금액·이유·키 수정 불가)';
end $$;
revoke execute on function private.ticket_ledger_append_only() from public, anon, authenticated;

drop trigger if exists ticket_ledger_no_mutate on private.ticket_ledger;
create trigger ticket_ledger_no_mutate
  before update or delete on private.ticket_ledger
  for each row execute function private.ticket_ledger_append_only();

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
  unlocked_at      timestamptz not null default now(),
  valid_until      timestamptz not null,
  primary key (member_id, subject_id)
);

-- ------------------------------------------------------------
-- 6. RLS — 정책 0개 = definer 외 전면 거부
-- ------------------------------------------------------------
alter table private.course_review_subjects        enable row level security;
alter table private.course_review_subject_aliases enable row level security;
alter table private.course_reviews                enable row level security;
alter table private.exam_tips                     enable row level security;
alter table private.ticket_ledger                 enable row level security;
alter table private.review_unlocks                enable row level security;

revoke all on private.course_review_subjects, private.course_review_subject_aliases,
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

  select count(*), count(distinct r.reviewer_key)
    into v_reviews, v_reviewers
    from private.course_reviews r
   where r.subject_id = p_subject_id and r.status = 'published';

  if v_reviewers >= 10 then
    return (
      with latest as (
        select distinct on (r.reviewer_key) r.*
          from private.course_reviews r
         where r.subject_id = p_subject_id and r.status = 'published'
         order by r.reviewer_key, r.published_at desc
      )
      select jsonb_build_object(
        'n_reviews', v_reviews, 'n_reviewers', v_reviewers, 'disclosure', 'full',
        'assignment',   (select jsonb_object_agg(a, c) from (select assignment a, count(*) c from latest where assignment is not null group by 1) t),
        'team_project', (select jsonb_object_agg(a, c) from (select team_project a, count(*) c from latest where team_project is not null group by 1) t),
        'grading',      (select jsonb_object_agg(a, c) from (select grading a, count(*) c from latest where grading is not null group by 1) t),
        'attendance',   (select jsonb_object_agg(a, c) from (select attendance a, count(*) c from latest where attendance is not null group by 1) t))
    );
  end if;

  if v_reviewers >= 5 then
    -- 작성자별 최신 1건으로 접은 뒤 최빈값을 구한다
    select g.grading, g.c into v_top, v_top_cnt
      from (
        select l.grading, count(*) c
          from (select distinct on (r.reviewer_key) r.reviewer_key, r.grading, r.published_at
                  from private.course_reviews r
                 where r.subject_id = p_subject_id and r.status = 'published'
                   and r.grading is not null
                 order by r.reviewer_key, r.published_at desc) l
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
begin
  if not authz.is_active_member() then raise exception 'not allowed'; end if;

  -- 존재하지 않는 subject에 과금하지 않는다. 응답은 존재 여부를 드러내지 않게 수렴.
  select exists (select 1 from private.course_review_subjects s where s.id = p_subject_id) into v_exists;
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

  insert into private.ticket_ledger (member_id, delta, reason, ref_type, ref_id, idempotency_key)
  values (auth.uid(), -5, 'unlock_subject', 'subject', p_subject_id,
          'unlock:' || auth.uid()::text || ':' || p_subject_id::text || ':' || v_gen::text);

  insert into private.review_unlocks (member_id, subject_id, unlock_generation, valid_until)
  values (auth.uid(), p_subject_id, v_gen, now() + interval '6 months')
  on conflict (member_id, subject_id) do update
    set unlock_generation = excluded.unlock_generation,
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
declare v_hit boolean;
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
  returning true into v_hit;

  if v_hit is null then return; end if;  -- 없거나 타인 것이면 no-op (존재 정보 비노출)

  -- 이 수강 건으로 지급된 원장 행들을 각각 역분개
  perform 1 from private.members m where m.id = auth.uid() for update;
  insert into private.ticket_ledger (member_id, delta, reason, ref_type, ref_id,
                                     reverses_entry_id, idempotency_key)
  select l.member_id, -l.delta, 'clawback', l.ref_type, l.ref_id,
         l.id, 'reverse:ledger:' || l.id::text
    from private.ticket_ledger l
   where l.member_id = auth.uid()
     and l.ref_type = 'course_review' and l.ref_id = p_review_id
     and l.delta > 0
     and not exists (select 1 from private.ticket_ledger x where x.reverses_entry_id = l.id);
end $$;
revoke execute on function public.withdraw_course_review(bigint) from public, anon, authenticated;
grant  execute on function public.withdraw_course_review(bigint) to authenticated;

commit;

-- ============================================================
-- 다음 배치 (이 초안의 범위 밖)
--  · submit/correct RPC — 구버전 corrected 전환 + 신버전 생성을 한 트랜잭션으로.
--    supersedes는 같은 subject/reviewer_key/semester만 허용해야 한다.
--  · operator 승인 RPC (자유서술 사전검토 → published + 지급).
--    지급 idempotency_key는 review id가 아니라 수강 건 귀속:
--    'review_reward:<reviewer_key>:<subject>:<semester>' — 정정본 재지급 방지.
--  · 신고 연결(private.reports·moderation_cases ↔ course_reviews)
--  · preserved_for_case ↔ purge 배치 (009 서버잡 패턴 재사용)
--  · 도움됨 집계와 후기당 상한 +6
--  · 공개 목록 RPC (작성자 속성 0개, 성적확정 후 묶음 공개 지연)
--  · reviewer_key를 md5 → 서버 비밀키 HMAC으로 교체 (학번 HMAC과 동일 원칙)
-- ============================================================
