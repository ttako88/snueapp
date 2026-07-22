-- ============================================================
-- 033_member_notes_and_messages.sql — 운영자 회원메모 + 알림함(운영 메시지) 목록
-- ============================================================
-- ⚠️ pending/. 추가형·가역. 031(콘솔 항목) 이후.
--
-- 소유자 지시(2026-07-23):
--   ① 콘솔에서 운영자가 회원별 메모. 목록에 회색 작은 글씨로 미리보기.
--   ② (숨겨진 기능) 사용자가 받은 운영 메시지(제재 안내 등)를 볼 알림함 — 목록 RPC 신설.
--
-- admin_list_members/admin_member_detail 는 메모를 포함하도록 재정의(031 위에).
-- ============================================================

begin;

-- 1. 회원 메모 (운영자용, 회원당 1개) --------------------------------------
create table if not exists private.member_notes (
  member_id   uuid primary key references private.members (id) on delete cascade,
  note        text not null check (char_length(note) <= 1000),
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);
alter table private.member_notes enable row level security;
revoke all on private.member_notes from anon, authenticated;

-- 메모 저장/삭제 — member.detail 권한. 빈 문자열이면 삭제.
create or replace function public.set_member_note(p_member_id uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;
begin
  v_actor := private.require_permission('member.detail');
  if not exists (select 1 from private.members where id = p_member_id) then
    raise exception 'no member'; end if;
  if p_note is null or char_length(trim(p_note)) = 0 then
    delete from private.member_notes where member_id = p_member_id;
    return jsonb_build_object('ok', true, 'note', null);
  end if;
  if char_length(p_note) > 1000 then raise exception 'note too long'; end if;
  insert into private.member_notes (member_id, note, updated_by)
  values (p_member_id, p_note, v_actor)
  on conflict (member_id) do update set note = excluded.note, updated_by = v_actor, updated_at = now();
  return jsonb_build_object('ok', true, 'note', p_note);
end $$;
revoke execute on function public.set_member_note(uuid, text) from public, anon, authenticated;
grant  execute on function public.set_member_note(uuid, text) to authenticated;

-- 2. 콘솔 목록/상세에 메모 포함 (031 위에 재정의) --------------------------
drop function if exists public.admin_list_members(text, text, text, timestamptz, uuid, int);
create function public.admin_list_members(
  p_search text default null, p_status text default null, p_role text default null,
  p_cursor timestamptz default null, p_cursor_id uuid default null, p_limit int default 30)
returns table (
  member_id uuid, nickname text, username text, role text, verification_status text,
  sanction text, sanction_until timestamptz, hakbeon_verified boolean,
  analytics_consent boolean, note text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_lim int := least(greatest(coalesce(p_limit,30),1),50);
begin
  perform private.require_permission('member.read_basic');
  return query
    select m.id, m.nickname, m.username, m.role, m.verification_status,
           m.sanction, m.sanction_until,
           exists (select 1 from private.account_identity a where a.member_id = m.id),
           coalesce((select c.granted from private.member_consents c
                       where c.member_id = m.id and c.purpose = 'product_analytics'), false),
           (select n.note from private.member_notes n where n.member_id = m.id),
           m.created_at
      from private.members m
     where (p_search is null
             or m.nickname ilike '%' || p_search || '%'
             or m.username ilike '%' || p_search || '%')
       and (p_status is null or m.verification_status = p_status)
       and (p_role   is null or m.role = p_role)
       and (p_cursor is null
             or m.created_at < p_cursor
             or (m.created_at = p_cursor and p_cursor_id is not null and m.id < p_cursor_id))
     order by m.created_at desc, m.id desc
     limit v_lim;
end $$;
revoke execute on function public.admin_list_members(text, text, text, timestamptz, uuid, int)
  from public, anon, authenticated;
grant  execute on function public.admin_list_members(text, text, text, timestamptz, uuid, int)
  to authenticated;

create or replace function public.admin_member_detail(p_member_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform private.require_permission('member.detail');
  select jsonb_build_object(
    'member_id', m.id, 'nickname', m.nickname, 'username', m.username, 'role', m.role,
    'email', (select u.email from auth.users u where u.id = m.id),
    'verification_status', m.verification_status,
    'sanction', m.sanction, 'sanction_until', m.sanction_until,
    'created_at', m.created_at,
    'hakbeon_verified', exists (select 1 from private.account_identity a where a.member_id = m.id),
    'analytics_consent', coalesce((select c.granted from private.member_consents c
                                     where c.member_id = m.id and c.purpose = 'product_analytics'), false),
    'note', (select n.note from private.member_notes n where n.member_id = m.id),
    'entitlements', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'grant_id', g.id, 'key', g.entitlement_key, 'grant_type', g.grant_type,
        'quota_total', g.quota_total, 'status', g.status,
        'starts_at', g.starts_at, 'expires_at', g.expires_at,
        'used', (select count(*) from private.entitlement_ledger l
                  where l.grant_id = g.id and l.state in ('reserved','consumed')),
        'reason', g.reason, 'created_at', g.created_at
      ) order by g.created_at desc), '[]'::jsonb)
      from private.entitlement_grants g where g.member_id = m.id
    )
  ) into v from private.members m where m.id = p_member_id;
  if v is null then raise exception 'no member'; end if;
  return v;
end $$;
revoke execute on function public.admin_member_detail(uuid) from public, anon, authenticated;
grant  execute on function public.admin_member_detail(uuid) to authenticated;

-- 3. 알림함 — 내가 받은 운영 메시지 목록(제재 안내 등). 내 것만. ------------
create or replace function public.list_my_messages(p_limit int default 50)
returns table (id bigint, kind text, title text, body text, created_at timestamptz, read_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select m.id, m.kind, m.title, m.body, m.created_at, m.read_at
    from public.operational_messages m
   where m.member_id = auth.uid()
   order by m.created_at desc
   limit least(greatest(coalesce(p_limit,50),1),100);
$$;
revoke execute on function public.list_my_messages(int) from public, anon;
grant  execute on function public.list_my_messages(int) to authenticated;

-- 안 읽은 알림 수(뱃지용).
create or replace function public.my_unread_message_count()
returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.operational_messages
   where member_id = auth.uid() and read_at is null;
$$;
revoke execute on function public.my_unread_message_count() from public, anon;
grant  execute on function public.my_unread_message_count() to authenticated;

commit;
