-- ============================================================
-- 032_lesson_plan_saves.sql — 지도안 저장/불러오기 + 잔여 이용권 조회
-- ============================================================
-- ⚠️ pending/. 추가형·가역. 028(이용권) 이후.
--
-- 소유자 지시(2026-07-23): 뽑은 약안·세안을 저장/불러오기(텍스트라 공간 문제 없음),
--   지도안 화면에 남은 이용권 횟수 표시.
--
-- 지도안은 텍스트(수 KB)라 DB 저장이 가볍다. private 스키마 + definer RPC 패턴.
--   회원당 저장 상한(50)으로 남용 방지.
-- ============================================================

begin;

create table if not exists private.lesson_plan_saves (
  id         bigint generated always as identity primary key,
  member_id  uuid not null references private.members (id) on delete cascade,
  plan_type  text not null check (plan_type in ('brief','full')),
  title      text not null check (char_length(title) between 1 and 120),
  body       text not null check (char_length(body) between 1 and 40000),
  created_at timestamptz not null default now()
);
alter table private.lesson_plan_saves enable row level security;
revoke all on private.lesson_plan_saves from anon, authenticated;
create index lesson_plan_saves_member on private.lesson_plan_saves (member_id, created_at desc);

-- 저장 — 회원당 50개 상한(초과 시 가장 오래된 것 밀어내지 않고 거부: 사용자가 정리하게).
create or replace function public.save_lesson_plan(p_plan_type text, p_title text, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v uuid := auth.uid(); v_n int; v_id bigint;
begin
  if v is null then return jsonb_build_object('ok', false, 'reason', 'unauthorized'); end if;
  if p_plan_type not in ('brief','full') then return jsonb_build_object('ok', false, 'reason', 'bad_type'); end if;
  if p_title is null or char_length(trim(p_title)) = 0 or char_length(p_title) > 120 then
    return jsonb_build_object('ok', false, 'reason', 'bad_title'); end if;
  if p_body is null or char_length(p_body) = 0 or char_length(p_body) > 40000 then
    return jsonb_build_object('ok', false, 'reason', 'bad_body'); end if;
  select count(*) into v_n from private.lesson_plan_saves where member_id = v;
  if v_n >= 50 then return jsonb_build_object('ok', false, 'reason', 'limit_reached'); end if;
  insert into private.lesson_plan_saves (member_id, plan_type, title, body)
  values (v, p_plan_type, trim(p_title), p_body) returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
revoke execute on function public.save_lesson_plan(text, text, text) from public, anon;
grant  execute on function public.save_lesson_plan(text, text, text) to authenticated;

-- 목록 — 본문 제외(가볍게). 내 것만.
create or replace function public.list_my_lesson_plans()
returns table (id bigint, plan_type text, title text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.id, s.plan_type, s.title, s.created_at
    from private.lesson_plan_saves s
   where s.member_id = auth.uid()
   order by s.created_at desc;
$$;
revoke execute on function public.list_my_lesson_plans() from public, anon;
grant  execute on function public.list_my_lesson_plans() to authenticated;

-- 한 건 불러오기 — 본문 포함. 내 것만(auth.uid 필터).
create or replace function public.get_my_lesson_plan(p_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', s.id, 'plan_type', s.plan_type, 'title', s.title,
                            'body', s.body, 'created_at', s.created_at)
    from private.lesson_plan_saves s
   where s.id = p_id and s.member_id = auth.uid();
$$;
revoke execute on function public.get_my_lesson_plan(bigint) from public, anon;
grant  execute on function public.get_my_lesson_plan(bigint) to authenticated;

-- 삭제 — 내 것만.
create or replace function public.delete_my_lesson_plan(p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  delete from private.lesson_plan_saves where id = p_id and member_id = auth.uid();
  get diagnostics v = row_count;
  return jsonb_build_object('ok', v > 0);
end $$;
revoke execute on function public.delete_my_lesson_plan(bigint) from public, anon;
grant  execute on function public.delete_my_lesson_plan(bigint) to authenticated;

-- 내 지도안 이용권 상태 (화면 표시용). owner / entitlement(remaining) / none.
--   028 의 svc_lesson_plan_access_preview 와 같은 판정을 auth.uid() 기준으로.
create or replace function public.my_lesson_plan_access()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v uuid := auth.uid(); v_grant private.entitlement_grants%rowtype; v_eff jsonb;
begin
  if v is null then return jsonb_build_object('allowed', false, 'source', 'none'); end if;
  if private.actor_has_permission(v, 'entitlement.manage_cost') then
    return jsonb_build_object('allowed', true, 'source', 'owner'); end if;
  for v_grant in
    select * from private.entitlement_grants
     where member_id = v and entitlement_key = 'lesson_plan_generate' and status = 'active'
     order by coalesce(expires_at, 'infinity'::timestamptz) asc, id asc
  loop
    v_eff := private.entitlement_effective(v_grant);
    if (v_eff->>'active')::boolean then
      return jsonb_build_object('allowed', true, 'source', 'entitlement',
        'grant_type', v_grant.grant_type, 'remaining', v_eff->'remaining');
    end if;
  end loop;
  return jsonb_build_object('allowed', false, 'source', 'none');
end $$;
revoke execute on function public.my_lesson_plan_access() from public, anon;
grant  execute on function public.my_lesson_plan_access() to authenticated;

commit;
