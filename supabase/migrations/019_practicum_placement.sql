-- ============================================================
-- 019_practicum_placement.sql — 학기별 실습학교 배정과 게시판 접근
-- ============================================================
-- ⚠️ pending. GPT 검수 전 적용하지 않는다.
--
-- 설계의 전제 (소유자 확인 2026-07-22)
--   서울교대는 2-1부터 4-1까지 **다섯 학기 연속** 실습이 있고, 학기마다
--   실습학교가 새로 바뀐다. 한 학기에 두 학교를 가는 경우는 없다.
--
--   그래서 "계정 → 학교" 가 아니라 **"회원 × 학기 → 학교"** 다.
--   처음에 계정당 1건으로 잡았다가 정정했다. 학교 변경은 예외가 아니라
--   학기마다 일어나는 정상 동작이다.
--
-- 게시판을 (학교 × 학기)로 나누는 이유
--   2026-1 개운초와 2027-1 개운초는 지도교사도 학생도 다른 집단이다.
--   뭉치면 정보가 아니라 소음이 된다. 대신 지난 학기를 **읽기 전용으로
--   남기면 그게 곧 선배 후기 아카이브**가 된다 — 별도 평가 시스템을
--   만들 필요가 없어진다.
--
-- 접근 정책 (GPT 검수 반영)
--   · 학생 인증 완료 회원만 배정을 설정할 수 있다
--   · **"학교 인증" 이 아니다.** 배정 자체를 검증할 방법은 없으므로
--     화면에도 "본인이 설정한 실습학교" 로 표시한다
--   · 최초 설정 후 **첫 글을 쓰기 전까지는 자유 수정**. 첫 게시 후 고정
--   · 정당한 재배정(휴학·학교 변경)은 사유를 남기고 **무료** 변경
--     → 변경을 유료화하지 않는다. 거짓 소속을 돈으로 바꿀 수 있게 되어
--       진실성은 안 오르고 정당한 재배정을 수익화한다는 반발만 남는다
--   · 쓰기는 현재 학기 배정 학교만. 읽기는 과거 학기도 허용
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. 학기별 배정
-- ------------------------------------------------------------
create table if not exists private.practicum_placements (
  id           bigint generated always as identity primary key,
  member_id    uuid not null references private.members (id) on delete cascade,
  semester     text not null check (semester ~ '^[0-9]{4}-[12]$'),
  -- 협력학교 목록의 축약명(개운초). 정식명·NEIS 코드는 앱 데이터가 갖고 있다.
  -- DB 가 학교 마스터를 들지 않는 이유: 목록이 매 학기 학사공지로 바뀌는데
  -- 그때마다 마이그레이션을 돌리는 것보다 앱 데이터 갱신이 가볍다.
  school_short text not null check (school_short ~ '^[가-힣A-Za-z0-9]{2,20}$'),
  -- 첫 게시 시각. 이게 찍히면 그 학기 배정은 고정된다.
  locked_at    timestamptz,
  -- 변경 이력을 남긴다. 재배정이 잦으면 운영자가 알아야 한다.
  changed_count integer not null default 0 check (changed_count >= 0),
  last_change_reason text check (last_change_reason is null
    or last_change_reason in ('mistake','reassigned','leave','other')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- 한 학기에 한 학교. 두 곳 가는 경우는 없다(소유자 확인).
  unique (member_id, semester)
);
create index if not exists practicum_placements_school
  on private.practicum_placements (semester, school_short);

alter table private.practicum_placements enable row level security;
revoke all on private.practicum_placements from anon, authenticated;

-- ------------------------------------------------------------
-- 2. 내 배정 조회
-- ------------------------------------------------------------
create or replace function public.get_my_placements()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'semester', p.semester, 'school', p.school_short,
           'locked', (p.locked_at is not null),
           'changed_count', p.changed_count) order by p.semester desc), '[]'::jsonb)
    from private.practicum_placements p
   where p.member_id = auth.uid();
$$;
revoke execute on function public.get_my_placements() from public, anon, authenticated;
grant execute on function public.get_my_placements() to authenticated;

-- ------------------------------------------------------------
-- 3. 배정 설정·변경
--    인증 완료 회원만. 잠긴 학기는 사유가 있어야 바꿀 수 있다.
-- ------------------------------------------------------------
create or replace function public.set_practicum_placement(
  p_semester text, p_school text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cur private.practicum_placements%rowtype;
begin
  -- 인증 완료 회원만. 게시판 분탕을 막는 실질적 장벽이 여기다.
  if not authz.is_active_member() then raise exception 'not allowed'; end if;

  if p_semester !~ '^[0-9]{4}-[12]$' then
    return jsonb_build_object('status','bad_semester');
  end if;
  if p_school !~ '^[가-힣A-Za-z0-9]{2,20}$' then
    return jsonb_build_object('status','bad_school');
  end if;

  select * into v_cur from private.practicum_placements
   where member_id = auth.uid() and semester = p_semester for update;

  if not found then
    insert into private.practicum_placements (member_id, semester, school_short)
    values (auth.uid(), p_semester, p_school);
    return jsonb_build_object('status','set','school',p_school,'locked',false);
  end if;

  if v_cur.school_short = p_school then
    return jsonb_build_object('status','unchanged','school',p_school,
                              'locked',(v_cur.locked_at is not null));
  end if;

  -- 첫 글을 쓰기 전이면 자유롭게 바꾼다 — 오설정을 벌하지 않는다.
  if v_cur.locked_at is null then
    update private.practicum_placements
       set school_short = p_school, changed_count = changed_count + 1,
           last_change_reason = coalesce(p_reason,'mistake'), updated_at = now()
     where id = v_cur.id;
    return jsonb_build_object('status','changed','school',p_school,'locked',false);
  end if;

  -- 잠긴 뒤에도 정당한 재배정은 **무료**로 바꾼다. 사유만 남긴다.
  if p_reason is null or p_reason not in ('reassigned','leave','other') then
    return jsonb_build_object('status','locked_needs_reason');
  end if;
  update private.practicum_placements
     set school_short = p_school, changed_count = changed_count + 1,
         last_change_reason = p_reason, updated_at = now()
   where id = v_cur.id;
  insert into private.audit_logs (actor_id, action, target_type, target_id, reason)
  values (auth.uid(), 'practicum_placement_changed', 'placement',
          v_cur.id::text, p_reason);
  return jsonb_build_object('status','changed','school',p_school,'locked',true);
end $$;
revoke execute on function public.set_practicum_placement(text, text, text)
  from public, anon, authenticated;
grant execute on function public.set_practicum_placement(text, text, text) to authenticated;

-- ------------------------------------------------------------
-- 4. 이 학기·학교에 글을 쓸 수 있는가
--    글쓰기 시점에 배정을 고정한다 — 쓰고 나서 학교를 바꾸면
--    남의 학교 게시판에 글이 남는다.
-- ------------------------------------------------------------
create or replace function public.can_post_practicum(p_semester text, p_school text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_ok boolean;
begin
  if not authz.is_active_member() then return false; end if;
  select true into v_ok from private.practicum_placements
   where member_id = auth.uid() and semester = p_semester and school_short = p_school;
  if not coalesce(v_ok, false) then return false; end if;

  -- 첫 글이면 여기서 잠근다
  update private.practicum_placements set locked_at = coalesce(locked_at, now())
   where member_id = auth.uid() and semester = p_semester;
  return true;
end $$;
revoke execute on function public.can_post_practicum(text, text)
  from public, anon, authenticated;
grant execute on function public.can_post_practicum(text, text) to authenticated;

-- ------------------------------------------------------------
-- 5. 학교·학기별 참여 인원 (읽기 가치 판단용)
--    누가 있는지는 안 준다. 몇 명인지만 — 그것도 **3명 미만은 정확 수를
--    노출하지 않는다**(GPT 019 MUST: 소수 학교의 정확 인원 노출 금지). 1~2명
--    학교는 "<3" 으로 익명화한다. k=3 미만은 특정 개인을 지목할 위험이 크다.
-- ------------------------------------------------------------
create or replace function public.practicum_school_counts(p_semester text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(
           school_short,
           case when n >= 3 then to_jsonb(n) else to_jsonb('<3'::text) end), '{}'::jsonb)
    from (select school_short, count(*)::int n
            from private.practicum_placements
           where semester = p_semester
           group by school_short) t;
$$;
revoke execute on function public.practicum_school_counts(text)
  from public, anon, authenticated;
grant execute on function public.practicum_school_counts(text) to authenticated;

commit;
