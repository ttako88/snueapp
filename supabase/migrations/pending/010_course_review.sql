-- ============================================================
-- 010_course_review.sql — 강의평가 모듈 (1단계)
--
-- ⚠️ PENDING 초안. 운영은 물론 dev에도 아직 적용하지 않았다.
--    적용 조건: ①GPT 공동검수 ②dev 클린 리허설 ③헌장·처리방침 검수 ④사용자 승인
--    동결 RC(001~009)는 재개봉하지 않는다. 이 파일은 그 위에 얹는 증분이다.
--
-- 설계 근거: docs/COURSE_REVIEW_DESIGN.md (GPT 공동검수 확정본)
--            docs/DATA_AND_MODERATION_CHARTER.md (상위 규범)
--
-- 핵심 불변조건 (이 파일이 지켜야 하는 것)
--  1. 작성자 공개속성 0개. 학과·학년·분반·정확한 수강학기·작성일시는 공개 경로에 없다.
--     member_id·semester는 내부(private)에만 두고, 공개 RPC 반환에 절대 포함하지 않는다.
--  2. 통계는 k=10 미만이면 분포·평균을 내보내지 않는다. (서울교대는 수강생 10~20명 과목이
--     흔해서, 표본이 작을 때 통계를 공개하면 개인 응답이 역산된다.)
--  3. "수정·삭제 절대 불가"는 채택하지 않는다(개인정보보호법 정정·삭제 요구권과 충돌).
--     원문 덮어쓰기는 막되 정정본·철회를 허용하고, 이력은 불변으로 남긴다.
--  4. 포인트는 잔액 컬럼을 두지 않는다. 불변 원장(ledger) 합산으로만 계산하고,
--     회수는 삭제가 아니라 반대 거래로 한다. idempotency_key로 중복 지급을 막는다.
--  5. 첨부파일 컬럼을 만들지 않는다 — 족보(문제 원문·스캔) 유입 경로를 구조적으로 차단.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. 평가 대상 (과목 + 교수)
--    강의 데이터 자체는 app/data/courses.json(클라이언트)에 있으므로, DB에는
--    "평가가 달릴 대상"만 최소로 둔다. 학기는 대상 키에 넣지 않는다 —
--    같은 과목·교수의 평가가 학기별로 쪼개지면 표본이 k에 영원히 못 미친다.
-- ------------------------------------------------------------
create table if not exists private.course_review_subjects (
  id           bigserial primary key,
  course_name  text not null check (char_length(course_name) between 1 and 100),
  professor    text not null check (char_length(professor)   between 1 and 50),
  created_at   timestamptz not null default now(),
  unique (course_name, professor)
);

-- ------------------------------------------------------------
-- 2. 강의평가
--    status 상태기계 (COURSE_REVIEW_DESIGN §3):
--      draft → submitted → published
--                            ├→ corrected            (정정본이 새 행, 구버전은 비공개)
--                            ├→ withdrawn_by_author
--                            ├→ hidden_by_moderation
--                            └→ preserved_for_case → purged
-- ------------------------------------------------------------
create table if not exists private.course_reviews (
  id            bigserial primary key,
  subject_id    bigint  not null references private.course_review_subjects (id) on delete restrict,

  -- 내부 전용 식별자 — 공개 RPC 반환에 절대 포함 금지 (불변조건 1)
  member_id     uuid    not null references private.members (id) on delete cascade,
  semester      text    not null check (semester ~ '^[0-9]{4}-[12]$'),

  status        text    not null default 'draft' check (status in (
                  'draft','submitted','published','corrected',
                  'withdrawn_by_author','hidden_by_moderation','preserved_for_case','purged')),

  -- 구조화 평가 (통계 대상). 값 집합은 design.md §12.3 실측 기준.
  attendance    text    check (attendance   in ('복합적','전자출결','직접호명','지정좌석','반영안함')),
  exam_count    smallint check (exam_count between 0 and 4),
  assignment    text    check (assignment   in ('없음','보통','많음')),
  team_project  text    check (team_project in ('없음','보통','많음')),
  grading       text    check (grading      in ('너그러움','보통','깐깐함')),

  -- 자유서술: 사전검토(pending) 후에만 공개된다 (설계 §4 — 명예훼손 방어선)
  body              text check (body is null or char_length(body) <= 1000),
  body_reviewed_at  timestamptz,
  body_reviewed_by  uuid references private.members (id),

  -- 정정본이 대체하는 구버전
  supersedes_id bigint references private.course_reviews (id),

  published_at  timestamptz,
  withdrawn_at  timestamptz,

  -- 보존·파기 (헌장 §5). 모든 데이터는 보존등급과 파기예정 시각을 갖는다.
  retention_class text not null default 'course_review',
  purge_after     timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- 공개된 평가는 반드시 공개시각이 있고, 철회된 평가는 철회시각이 있다
  check (status <> 'published'           or published_at is not null),
  check (status <> 'withdrawn_by_author' or withdrawn_at is not null),
  -- 자유서술이 공개 상태라면 사전검토를 거쳤어야 한다 (§4-2)
  check (status <> 'published' or body is null or body_reviewed_at is not null)
);

-- 한 "수강 건"(대상+회원+학기)당 활성 평가는 1개. 철회·숨김·파기된 건은 제외하므로
-- 철회 후 재작성은 가능하다. (에타식 "1인 1회 영구 고정"과 다른 지점 — 설계 §3)
create unique index if not exists course_reviews_one_active
  on private.course_reviews (subject_id, member_id, semester)
  where status in ('draft','submitted','published','corrected');

create index if not exists course_reviews_subject_published
  on private.course_reviews (subject_id) where status = 'published';

-- ------------------------------------------------------------
-- 3. 시험 경향·준비 팁 (족보 아님)
--    저작권법 32조 예외는 "시험 시행을 위한 복제"이지 공중 공개 면허가 아니다.
--    → 문제 원문·첨부파일을 담을 컬럼 자체를 만들지 않는다 (불변조건 5).
-- ------------------------------------------------------------
create table if not exists private.exam_tips (
  id           bigserial primary key,
  subject_id   bigint not null references private.course_review_subjects (id) on delete restrict,
  member_id    uuid   not null references private.members (id) on delete cascade,
  semester     text   not null check (semester ~ '^[0-9]{4}-[12]$'),
  status       text   not null default 'draft' check (status in (
                 'draft','submitted','published','withdrawn_by_author','hidden_by_moderation','purged')),
  exam_format  text   check (exam_format in ('객관식','서술형','논술형','실기','혼합')),
  question_count_approx smallint check (question_count_approx between 0 and 200),
  open_book    boolean,
  time_pressure text  check (time_pressure in ('여유','보통','촉박')),
  scope_note   text   check (scope_note is null or char_length(scope_note) <= 500),
  study_tip    text   check (study_tip  is null or char_length(study_tip)  <= 1000),
  reviewed_at  timestamptz,
  published_at timestamptz,
  purge_after  timestamptz,
  created_at   timestamptz not null default now(),
  check (status <> 'published' or published_at is not null)
);

create unique index if not exists exam_tips_one_active
  on private.exam_tips (subject_id, member_id, semester)
  where status in ('draft','submitted','published');

-- ------------------------------------------------------------
-- 4. 티켓 원장 (불변)
--    잔액 컬럼은 만들지 않는다. 잔액 = sum(delta).
--    회수는 행 삭제·수정이 아니라 반대 부호 거래를 "추가"하는 것으로만 한다.
-- ------------------------------------------------------------
create table if not exists private.ticket_ledger (
  id         bigserial primary key,
  member_id  uuid    not null references private.members (id) on delete cascade,
  delta      integer not null check (delta <> 0),
  reason     text    not null check (reason in (
               'verification_bonus',    -- +15 학생 인증 완료
               'review_published',      -- +20 강의평가 승인·공개
               'exam_tip_published',    -- +10 시험 경향 승인·공개
               'helpful_bonus',         -- +2  도움됨 3개 달성 (후기당 상한 +6)
               'unlock_subject',        -- -5  과목+교수 페이지 잠금해제
               'clawback')),            -- 철회·중복·조작·정책위반 시 회수(반대 거래)
  ref_type   text,
  ref_id     bigint,
  -- 중복 지급 방지의 핵심. 같은 사건은 같은 키를 갖는다.
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists ticket_ledger_member on private.ticket_ledger (member_id);

-- 원장은 append-only. UPDATE·DELETE를 트리거로 막는다(권한 실수까지 방어).
create or replace function private.ticket_ledger_append_only()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception 'ticket_ledger is append-only (회수는 반대 거래를 추가할 것)';
end $$;

drop trigger if exists ticket_ledger_no_mutate on private.ticket_ledger;
create trigger ticket_ledger_no_mutate
  before update or delete on private.ticket_ledger
  for each row execute function private.ticket_ledger_append_only();

-- ------------------------------------------------------------
-- 5. 잠금해제 기록
--    잠금은 후기 1건이 아니라 "과목+교수 페이지 전체"에 걸리고,
--    최소 한 학기 동안 재과금하지 않는다 (설계 §6).
-- ------------------------------------------------------------
create table if not exists private.review_unlocks (
  member_id   uuid   not null references private.members (id) on delete cascade,
  subject_id  bigint not null references private.course_review_subjects (id) on delete cascade,
  unlocked_at timestamptz not null default now(),
  valid_until timestamptz not null,
  primary key (member_id, subject_id)
);

-- ------------------------------------------------------------
-- 6. RLS — 전 테이블 차단이 기본. 접근은 definer RPC로만.
--    private 스키마는 PostgREST에 미노출이지만, 노출 설정 실수에 대비해
--    테이블 차원에서도 잠근다(심층 방어).
-- ------------------------------------------------------------
alter table private.course_review_subjects enable row level security;
alter table private.course_reviews         enable row level security;
alter table private.exam_tips              enable row level security;
alter table private.ticket_ledger          enable row level security;
alter table private.review_unlocks         enable row level security;
-- 정책을 하나도 만들지 않는다 = 소유자/definer 외 전부 거부.

revoke all on private.course_review_subjects, private.course_reviews, private.exam_tips,
              private.ticket_ledger, private.review_unlocks
  from anon, authenticated;

-- ------------------------------------------------------------
-- 7. 잔액 조회 (본인 것만)
-- ------------------------------------------------------------
create or replace function public.my_ticket_balance()
returns integer language sql security definer set search_path='' stable as $$
  select coalesce(sum(l.delta), 0)::integer
    from private.ticket_ledger l
   where l.member_id = auth.uid();
$$;
revoke execute on function public.my_ticket_balance() from public, anon, authenticated;
grant  execute on function public.my_ticket_balance() to authenticated;

-- ------------------------------------------------------------
-- 8. 통계 조회 — k=10 게이트
--    표본이 임계 미만이면 분포·평균을 **아예 계산해서 내보내지 않는다**.
--    (프런트에서 가리는 방식 금지 — 응답에 값이 들어가는 순간 유출이다.)
--    5~9 구간의 '초기 경향'은 최빈 응답이 60% 이상이고 3명 이상일 때만.
-- ------------------------------------------------------------
create or replace function public.course_review_stats(p_subject_id bigint)
returns jsonb language plpgsql security definer set search_path='' stable as $$
declare
  v_n         integer;
  v_result    jsonb;
  v_top       text;
  v_top_cnt   integer;
begin
  if not authz.is_active_member() then raise exception 'not allowed'; end if;

  select count(*) into v_n
    from private.course_reviews r
   where r.subject_id = p_subject_id and r.status = 'published';

  if v_n >= 10 then
    select jsonb_build_object(
      'n', v_n,
      'disclosure', 'full',
      'assignment',   (select jsonb_object_agg(x.assignment,   x.c) from
                        (select r.assignment, count(*) c from private.course_reviews r
                          where r.subject_id = p_subject_id and r.status='published'
                            and r.assignment is not null group by r.assignment) x),
      'team_project', (select jsonb_object_agg(x.team_project, x.c) from
                        (select r.team_project, count(*) c from private.course_reviews r
                          where r.subject_id = p_subject_id and r.status='published'
                            and r.team_project is not null group by r.team_project) x),
      'grading',      (select jsonb_object_agg(x.grading,      x.c) from
                        (select r.grading, count(*) c from private.course_reviews r
                          where r.subject_id = p_subject_id and r.status='published'
                            and r.grading is not null group by r.grading) x),
      'attendance',   (select jsonb_object_agg(x.attendance,   x.c) from
                        (select r.attendance, count(*) c from private.course_reviews r
                          where r.subject_id = p_subject_id and r.status='published'
                            and r.attendance is not null group by r.attendance) x)
    ) into v_result;
    return v_result;
  end if;

  if v_n >= 5 then
    -- 초기 경향 1문장만: 최빈값이 60% 이상 & 3명 이상일 때. 아니면 "의견이 갈립니다".
    select r.grading, count(*) into v_top, v_top_cnt
      from private.course_reviews r
     where r.subject_id = p_subject_id and r.status='published' and r.grading is not null
     group by r.grading order by count(*) desc limit 1;

    if v_top_cnt >= 3 and v_top_cnt::numeric / v_n >= 0.6 then
      return jsonb_build_object('n', v_n, 'disclosure', 'early', 'trend', v_top);
    end if;
    return jsonb_build_object('n', v_n, 'disclosure', 'early', 'trend', null);
  end if;

  -- 1~4: 개별 후기만. 평균·최빈값·순위 없음.
  return jsonb_build_object('n', v_n, 'disclosure', 'none');
end $$;
revoke execute on function public.course_review_stats(bigint) from public, anon, authenticated;
grant  execute on function public.course_review_stats(bigint) to authenticated;

-- ------------------------------------------------------------
-- 9. 잠금해제 (-5, 한 학기 재과금 없음)
--    잔액이 모자라면 거래를 만들지 않는다 — 음수 잔액 금지.
-- ------------------------------------------------------------
create or replace function public.unlock_course_reviews(p_subject_id bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_balance integer;
  v_existing timestamptz;
begin
  if not authz.is_active_member() then raise exception 'not allowed'; end if;

  select u.valid_until into v_existing
    from private.review_unlocks u
   where u.member_id = auth.uid() and u.subject_id = p_subject_id;
  if v_existing is not null and v_existing > now() then
    return jsonb_build_object('status','already_unlocked','valid_until',v_existing);
  end if;

  select coalesce(sum(l.delta),0) into v_balance
    from private.ticket_ledger l where l.member_id = auth.uid();
  if v_balance < 5 then
    return jsonb_build_object('status','insufficient','balance',v_balance);
  end if;

  insert into private.ticket_ledger (member_id, delta, reason, ref_type, ref_id, idempotency_key)
  values (auth.uid(), -5, 'unlock_subject', 'subject', p_subject_id,
          'unlock:' || auth.uid()::text || ':' || p_subject_id::text || ':' ||
          to_char(now(), 'YYYY') || case when extract(month from now()) <= 6 then '-1' else '-2' end);

  insert into private.review_unlocks (member_id, subject_id, valid_until)
  values (auth.uid(), p_subject_id, now() + interval '6 months')
  on conflict (member_id, subject_id)
    do update set unlocked_at = now(), valid_until = excluded.valid_until;

  return jsonb_build_object('status','unlocked');
end $$;
revoke execute on function public.unlock_course_reviews(bigint) from public, anon, authenticated;
grant  execute on function public.unlock_course_reviews(bigint) to authenticated;

-- ------------------------------------------------------------
-- 10. 철회 — 작성자 본인. 지급 포인트는 반대 거래로 회수한다.
-- ------------------------------------------------------------
create or replace function public.withdraw_course_review(p_review_id bigint)
returns void language plpgsql security definer set search_path='' as $$
declare v_was_published boolean;
begin
  if not authz.is_active_member() then raise exception 'not allowed'; end if;

  update private.course_reviews r
     set status = 'withdrawn_by_author',
         withdrawn_at = clock_timestamp(),
         updated_at   = clock_timestamp(),
         -- 사건이 없으면 짧은 유예 후 본문·작성자 연결을 파기한다 (설계 §3)
         purge_after  = clock_timestamp() + interval '30 days'
   where r.id = p_review_id
     and r.member_id = auth.uid()
     and r.status in ('draft','submitted','published','corrected')
  returning (r.published_at is not null) into v_was_published;

  -- 존재하지 않거나 타인 것이면 no-op (존재 정보 비노출)
  if v_was_published is null then return; end if;

  if v_was_published then
    insert into private.ticket_ledger (member_id, delta, reason, ref_type, ref_id, idempotency_key)
    values (auth.uid(), -20, 'clawback', 'course_review', p_review_id,
            'clawback:review:' || p_review_id::text)
    on conflict (idempotency_key) do nothing;   -- 두 번 회수하지 않는다
  end if;
end $$;
revoke execute on function public.withdraw_course_review(bigint) from public, anon, authenticated;
grant  execute on function public.withdraw_course_review(bigint) to authenticated;

commit;

-- ============================================================
-- 아직 남은 것 (이 초안의 범위 밖 — 다음 배치에서)
--  · submit/correct RPC (정정본 생성 + supersedes 연결)
--  · operator 승인 RPC (자유서술 사전검토 → published + '+20' 지급)
--  · 신고 연결: 기존 private.reports·moderation_cases와 course_reviews 연결 테이블
--  · preserved_for_case ↔ purge 배치 (009 서버잡 패턴 재사용)
--  · helpful(도움됨) 집계와 후기당 상한 +6
--  · 공개 목록 RPC (작성자 속성 0개, 성적확정 후 묶음 공개 지연 반영)
-- ============================================================
