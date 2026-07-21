-- ============================================================
-- 016_course_review_write_read.sql — 강의평가 쓰기·조회 (011 범위 밖 배치)
-- ============================================================
-- ⚠️ pending/. GPT 검수 전에는 적용하지 않는다.
--
-- 배경 (실측 2026-07-21)
--   011 은 통계·잠금해제·철회·정정만 만들고, 파일 끝 "다음 배치" 주석에서
--   제출 RPC·공개 목록 RPC를 명시적으로 범위 밖에 뒀다. 그래서 현재 운영에는
--   평가를 **쓸 수도 볼 수도 없다**. features.js 의 courseReview 가 OFF 인 것이
--   정확한 표현이었다. 과목 마스터 1,267건은 적재했으므로 남은 건 이 RPC 셋이다.
--
-- 이 배치의 범위 (의도적으로 좁힌다)
--   ① resolve_course_subject — 과목 해석. private 테이블이라 RPC 없이는
--      브라우저가 subject_id 를 알 방법이 아예 없다.
--   ② submit_course_review  — 객관식 항목만. 자유서술은 받지 않는다.
--   ③ list_course_reviews   — 잠금해제한 회원에게 개별 후기 목록.
--
-- 자유서술을 v1 에서 빼는 이유
--   011 의 CHECK 는 published + body not null 이면 body_reviewed_at 을 요구한다.
--   즉 자유서술은 사전 검토가 전제다. 검토자가 상주하지 않는 지금 그 큐를 열면
--   "제출했는데 영원히 안 올라오는" 상태가 쌓인다. 객관식만으로도 통계·분포는
--   완성되므로 먼저 그것부터 돌리고, 검토 운영이 준비되면 별도 배치로 연다.
--
-- 보상·과금 흐름 (011 과 일관)
--   평가 1건 공개 → +20, 과목 잠금해제 → -5. 철회 시 011 의
--   withdraw_course_review 가 실제 지급행을 역분개한다. 그래서 여기서는
--   지급행의 contribution_id·ref 를 011 이 찾는 모양 그대로 채워야 한다.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. 과목 해석
--    키는 app/lib/courseKey.js 가 만든다. DB 는 정규화하지 않는다 —
--    규칙이 두 곳에 있으면 반드시 어긋난다(011 §1 주석과 같은 원칙).
--
--    없는 과목과 평가 0건 과목을 구별해 주지 않는다: 둘 다 subject 는
--    돌려주되 통계는 course_review_stats 가 'none' 으로 수렴시킨다.
-- ------------------------------------------------------------
create or replace function public.resolve_course_subject(
  p_course_key text, p_professor_key text)
returns jsonb language plpgsql security definer set search_path='' stable as $$
declare v jsonb;
begin
  if not authz.is_active_member() then raise exception 'not allowed'; end if;

  -- 입력을 그대로 신뢰하되 모양은 본다. 형식이 어긋나면 조회 자체를 하지 않는다.
  if p_course_key    !~ '^[0-9a-z가-힣]{1,80}$' then return jsonb_build_object('status','not_found'); end if;
  if p_professor_key !~ '^[0-9a-z가-힣]{1,40}$' then return jsonb_build_object('status','not_found'); end if;

  select jsonb_build_object(
           'status','ok', 'subject_id', s.id,
           'course', s.course_name_display, 'professor', s.professor_display)
    into v
    from private.course_review_subjects s
   where s.course_key = p_course_key and s.professor_key = p_professor_key;

  return coalesce(v, jsonb_build_object('status','not_found'));
end $$;
revoke execute on function public.resolve_course_subject(text, text) from public, anon, authenticated;
grant  execute on function public.resolve_course_subject(text, text) to authenticated;

-- ------------------------------------------------------------
-- 2. 제출
--    한 트랜잭션에서: 별칭 확보 → 평가 생성(published) → 보상 지급.
--
--    별칭을 여기서 만드는 이유: 011 의 guard_actor_alias 는 최초 INSERT 에
--    member_id 를 요구한다. definer 함수 안에서 auth.uid() 로 만들어야
--    "주인 없는 별칭" 이 생기지 않는다.
--
--    중복은 011 의 부분 유니크 인덱스(course_reviews_one_live)가 최종 차단한다.
--    미리 select 로 확인만 하면 동시 요청 두 개가 둘 다 통과한다 — 예외를
--    잡아서 사용자 말로 바꾸는 방식이 맞다.
-- ------------------------------------------------------------
create or replace function public.submit_course_review(
  p_subject_id   bigint,
  p_semester     text,
  p_attendance   text default null,
  p_exam_count   smallint default null,
  p_assignment   text default null,
  p_team_project text default null,
  p_grading      text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_alias  uuid;
  v_id     bigint;
  v_contrib uuid;
  v_answered int;
begin
  if not authz.is_active_member() then raise exception 'not allowed'; end if;

  if p_semester !~ '^[0-9]{4}-[12]$' then
    return jsonb_build_object('status','bad_semester');
  end if;

  -- 전부 비운 채 제출하면 표본만 늘고 정보는 0이다. 작성자 수(k)를 부풀려
  -- 공개 임계값을 뚫는 데 악용될 수 있으므로 최소 2개 항목을 요구한다.
  v_answered :=
      (p_attendance   is not null)::int + (p_exam_count   is not null)::int
    + (p_assignment   is not null)::int + (p_team_project is not null)::int
    + (p_grading      is not null)::int;
  if v_answered < 2 then
    return jsonb_build_object('status','too_few_answers','answered',v_answered);
  end if;

  -- 대상이 없으면 여기서 끝낸다. 존재 여부를 알려 주는 셈이지만, 과목 목록은
  -- 어차피 공개 정보(강의 검색)라 새로 새는 정보가 없다.
  perform 1 from private.course_review_subjects s where s.id = p_subject_id;
  if not found then return jsonb_build_object('status','no_subject'); end if;

  -- 회원 단위 직렬화 — 별칭 생성과 원장 기록이 같은 잠금 아래 있어야 한다
  -- (011 의 unlock 과 같은 이유: 동시 요청이 같은 상태를 읽는 것을 막는다).
  perform 1 from private.members m where m.id = auth.uid() for update;

  select a.id into v_alias
    from private.course_review_actor_aliases a
   where a.subject_id = p_subject_id and a.member_id = auth.uid();
  if v_alias is null then
    insert into private.course_review_actor_aliases (subject_id, member_id)
    values (p_subject_id, auth.uid())
    returning id into v_alias;
  end if;

  begin
    insert into private.course_reviews
      (subject_id, member_id, actor_alias_id, semester, status,
       attendance, exam_count, assignment, team_project, grading, published_at)
    values
      (p_subject_id, auth.uid(), v_alias, p_semester, 'published',
       p_attendance, p_exam_count, p_assignment, p_team_project, p_grading, now())
    returning id, contribution_id into v_id, v_contrib;
  exception when unique_violation then
    -- one_live 인덱스. 같은 과목·같은 학기는 한 번만.
    return jsonb_build_object('status','already_reviewed');
  end;

  -- 보상. 키에 회원 UUID 를 넣지 않는다(탈퇴 후에도 원장은 남는다).
  -- 011 의 withdraw 가 contribution_id 로 지급행을 찾으므로 반드시 채운다.
  insert into private.ticket_ledger
    (member_id, delta, reason, ref_type, ref_id, contribution_id, idempotency_key)
  values
    (auth.uid(), 20, 'review_published', 'course_review', v_id, v_contrib,
     'review_reward:' || v_contrib::text);

  return jsonb_build_object('status','published','review_id',v_id);
end $$;
revoke execute on function public.submit_course_review(bigint, text, text, smallint, text, text, text)
  from public, anon, authenticated;
grant  execute on function public.submit_course_review(bigint, text, text, smallint, text, text, text)
  to authenticated;

-- ------------------------------------------------------------
-- 3. 공개 목록
--    잠금해제한 회원만. 작성자 속성은 하나도 내보내지 않는다 —
--    member_id·actor_alias_id·semester 전부 비공개다.
--
--    semester 를 빼는 이유: 학기는 시간표·수강 이력과 대조하면 사람을
--    특정하는 준식별자다. 011 이 컬럼 주석에 "내부 전용, 공개 금지" 라고
--    못 박아 뒀다.
--
--    정렬에 id desc 를 함께 넣는다 — published_at 동률일 때 순서가
--    흔들리면 페이지네이션이 같은 행을 두 번 보여 준다.
-- ------------------------------------------------------------
create or replace function public.list_course_reviews(
  p_subject_id bigint, p_limit integer default 20, p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path='' stable as $$
declare
  v_ok    boolean;
  v_lim   integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_off   integer := greatest(coalesce(p_offset, 0), 0);
  v_rows  jsonb;
begin
  if not authz.is_active_member() then raise exception 'not allowed'; end if;

  select (u.valid_until is not null and u.valid_until > now()) into v_ok
    from private.review_unlocks u
   where u.member_id = auth.uid() and u.subject_id = p_subject_id;

  if not coalesce(v_ok, false) then
    return jsonb_build_object('status','locked');
  end if;

  -- 작성자별 최신 1건으로 접는다. 정정본이 있으면 구버전은 corrected 라
  -- published 필터에서 이미 빠지지만, 같은 사람이 학기를 달리해 쓴 건은
  -- 각각 유효한 후기이므로 접지 않는다 — 통계(stats)와 다른 지점이다.
  select coalesce(jsonb_agg(t order by t->>'published_at' desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
               'id', r.id,
               'attendance', r.attendance,
               'exam_count', r.exam_count,
               'assignment', r.assignment,
               'team_project', r.team_project,
               'grading', r.grading,
               -- 본문은 검토를 통과한 것만 (011 CHECK 와 같은 조건)
               'body', case when r.body_reviewed_at is not null then r.body end,
               'published_at', r.published_at,
               -- 내 후기인지만 알려 준다. 남의 작성자 식별값은 주지 않는다.
               'is_mine', (r.member_id = auth.uid())) t
        from private.course_reviews r
       where r.subject_id = p_subject_id and r.status = 'published'
       order by r.published_at desc, r.id desc
       limit v_lim offset v_off) s;

  return jsonb_build_object('status','ok','reviews',v_rows);
end $$;
revoke execute on function public.list_course_reviews(bigint, integer, integer)
  from public, anon, authenticated;
grant  execute on function public.list_course_reviews(bigint, integer, integer)
  to authenticated;

-- ------------------------------------------------------------
-- 4. 내가 이 과목에 쓴 적 있는지
--    제출 화면이 "이미 썼음" 을 미리 알려 주려면 필요하다. 남의 정보는 없다.
-- ------------------------------------------------------------
create or replace function public.my_course_review(p_subject_id bigint)
returns jsonb language plpgsql security definer set search_path='' stable as $$
begin
  if not authz.is_active_member() then raise exception 'not allowed'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'semester', r.semester, 'status', r.status,
             'published_at', r.published_at))
      from private.course_reviews r
     where r.subject_id = p_subject_id
       and r.member_id = auth.uid()
       and r.status in ('draft','submitted','published')), '[]'::jsonb);
end $$;
revoke execute on function public.my_course_review(bigint) from public, anon, authenticated;
grant  execute on function public.my_course_review(bigint) to authenticated;

commit;

-- ============================================================
-- 이 배치에서 뺀 것 (다음 배치)
--   · 자유서술 제출 + operator 사전검토 큐 (위 사유 참조)
--   · 도움됨 집계와 후기당 상한 +6
--   · 신고 연결 (private.reports ↔ course_reviews)
--   · exam_tips 쓰기·조회
-- ============================================================
