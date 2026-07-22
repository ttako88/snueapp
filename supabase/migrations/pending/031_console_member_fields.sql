-- ============================================================
-- 031_console_member_fields.sql — 콘솔 회원목록/상세에 신규 항목
-- ============================================================
-- ⚠️ pending/. 추가형·가역. 028·030 적용 후.
--
-- 소유자 지시(2026-07-23): 회원가입 재설계로 생긴 정보를 콘솔에서 보이게.
--   추가: 아이디(username)·학번 인증여부(O/X)·통계 동의여부 → 목록+상세.
--         이메일 → **상세만**(개인정보라 대량 노출 방지, member.detail 권한).
--   학번 원문은 저장 안 함(HMAC) → 표시 불가. 인증여부(bool)만.
--
-- admin_list_members 는 반환 컬럼이 바뀌므로 DROP 후 재생성(replace 로는 반환형
--   변경 불가). admin_member_detail 은 jsonb 라 키 추가만(호환).
-- ============================================================

begin;

-- 1. 목록 — username · 학번인증여부 추가 (이메일 제외). username 검색도 지원.
drop function if exists public.admin_list_members(text, text, text, timestamptz, uuid, int);
create function public.admin_list_members(
  p_search text default null, p_status text default null, p_role text default null,
  p_cursor timestamptz default null, p_cursor_id uuid default null, p_limit int default 30)
returns table (
  member_id uuid, nickname text, username text, role text, verification_status text,
  sanction text, sanction_until timestamptz, hakbeon_verified boolean,
  analytics_consent boolean, created_at timestamptz)
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

-- 2. 상세 — username · email(개인정보) · 학번인증여부 · 통계동의 추가.
--    email 은 auth.users 에서(정의자 권한). member.detail 권한 필요.
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

commit;
