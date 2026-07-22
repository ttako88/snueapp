-- ============================================================
-- 028_feature_entitlements.sql — 관리자 콘솔: 세분 권한 + 기능 이용권(entitlement)
-- ============================================================
-- ⚠️ pending/. GPT 검수(R3) + 소유자 승인 전에는 운영 적용하지 않는다.
-- ⚠️ 추가형(additive)·가역(reversible) 전용. 기존 테이블/함수/RLS 를 바꾸지 않는다.
--    down 은 이 파일이 만든 객체만 DROP 하면 원상복구된다.
--
-- 왜 필요한가 (2026-07-23 소유자 지시)
--   · 지금 지도안 생성은 lessonPlanPublic OFF 라 role=owner 만 가능하다(서버 게이트).
--     베타테스터 지인이 로그인해도 owner 가 아니라 아무것도 못 한다.
--   · 결제 없이 **특정 회원에게만** 지도안 생성권을 열어주고 싶다 → per-user 이용권.
--   · 남용/비용은 quota(횟수·기간)로 막는다. owner 지갑 보호는 유지한다.
--
-- 설계 (GPT R1/R2 합의: P-20260723-ADMIN_CONSOLE_R1/R2_REVIEW_01)
--   Q2  entitlement = role 과 별개의 2층. 임의 문자열 역할 금지, 등록된 key 만.
--   Q3  게이트: owner OR 유효 entitlement. 무료 quota 기본 30일/10회.
--   Q7  조회(preview)와 예약(reserve)을 분리. funding_source 는 요청당 하나:
--         OWNER_BYPASS → FREE_ENTITLEMENT → NORMAL_PAID_PATH_IF_ENABLED → DENY
--       entitlement 로 처리되면 aiCreditCharge·SR 잔액은 0 변경.
--   Q8  회원목록 RPC 는 member.read_basic 권한 + PII 미반환 + cursor pagination.
--   Q10 grant/revoke_entitlement 는 owner(=entitlement.manage_cost) 만. operator 는 조회만.
--   Q11 독립 원장. 023 을 재사용하지 않고 entitlement_grants + entitlement_ledger 를 둔다.
--       023 의 request_id·원자전이·멱등 패턴만 재사용. RESERVED+CONSUMED 만 quota 점유.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. 세분 권한 레이어 (permission key)
--    기존 actor_role_check(min_role) 는 역할 서열만 본다. GPT R2 는
--    "역할 서열이 아니라 명시적 permission key 로 각 RPC 를 제한하라" 했다.
--    역할→권한 매핑을 DB 에 두고, 판정 함수 하나로 통일한다. 기존 함수는
--    건드리지 않는다(추가형).
-- ------------------------------------------------------------
create table if not exists private.role_permissions (
  role        text not null check (role in ('member','moderator','operator','owner')),
  permission  text not null,
  primary key (role, permission)
);
alter table private.role_permissions enable row level security;
revoke all on private.role_permissions from anon, authenticated;

-- 등록된 권한만 매핑에 넣는다. 오타로 권한이 새로 생기는 사고 방지.
--   member.read_basic     : 회원 목록/요약 조회(PII 제외)
--   member.detail         : 단일 회원 상세(제재·이용권 이력 포함, PII 제외)
--   moderation.sanction   : 직접 제재(정지/강퇴/해제)
--   board.notice          : 게시판 공지 작성/고정
--   sponsor.manage        : 광고 소재/슬롯 draft 관리
--   flag.manage           : DB 런타임 flag 토글
--   entitlement.read      : 이용권 조회
--   entitlement.manage_cost : 무료 이용권 부여/회수(owner 지갑 지출 유발 → owner 전용)
--   audit.read            : 관리자 행위 로그 열람
insert into private.role_permissions (role, permission) values
  ('owner','member.read_basic'), ('owner','member.detail'),
  ('owner','moderation.sanction'), ('owner','board.notice'),
  ('owner','sponsor.manage'), ('owner','flag.manage'),
  ('owner','entitlement.read'), ('owner','entitlement.manage_cost'),
  ('owner','audit.read'),
  ('operator','member.read_basic'), ('operator','member.detail'),
  ('operator','moderation.sanction'), ('operator','board.notice'),
  ('operator','sponsor.manage'),
  ('operator','entitlement.read'), ('operator','audit.read')
  -- moderator 는 회원 전체목록/이용권을 기본 부여하지 않는다(GPT R2 Q8 PROPOSE).
on conflict do nothing;

-- 판정 헬퍼. auth.uid() 판(클라이언트 authenticated RPC 용)과
-- actor_id 인자판(service_role svc_ 함수 용) 둘 다 제공한다.
--   자격: nickname 있음 + verified + 제재 없음 + 역할이 해당 권한 보유.
create or replace function private.actor_has_permission(p_actor uuid, p_perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from private.members m
      join private.role_permissions rp on rp.role = m.role
     where m.id = p_actor
       and m.nickname is not null
       and m.verification_status = 'verified'
       and m.sanction = 'none'
       and rp.permission = p_perm
  );
$$;
-- ⚠️ PostgreSQL 은 신규 함수에 기본 PUBLIC EXECUTE 를 준다. private 헬퍼는
--    정의자(definer) 내부 호출 전용이므로 외부 role 의 EXECUTE 를 명시적으로
--    회수한다. (private 스키마 USAGE 도 없지만 방어심층으로 이중 차단.)
revoke execute on function private.actor_has_permission(uuid, text)
  from public, anon, authenticated;

-- auth.uid() 기반 요구 헬퍼 — 없으면 예외. (authenticated definer RPC 에서 사용)
create or replace function private.require_permission(p_perm text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v uuid := auth.uid();
begin
  if v is null or not private.actor_has_permission(v, p_perm) then
    raise exception 'not allowed';
  end if;
  return v;
end $$;
revoke execute on function private.require_permission(text)
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. 이용권 종류 레지스트리 (등록된 key 만 부여 가능)
-- ------------------------------------------------------------
create table if not exists private.entitlement_keys (
  key    text primary key,
  label  text not null,
  -- 이 이용권이 대체하는 과금 경로. lesson_plan_generate 는 지도안 생성비를 대체한다.
  covers text
);
alter table private.entitlement_keys enable row level security;
revoke all on private.entitlement_keys from anon, authenticated;

insert into private.entitlement_keys (key, label, covers) values
  ('lesson_plan_generate', '지도안 생성', 'ai_lesson_plan')
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- 3. 이용권 부여 (grants)
--    status 는 active/revoked 두 값만 저장한다. expired/exhausted 는
--    시각·소진량에서 파생 판정한다 — 저장하면 실제와 어긋날 수 있다(drift).
-- ------------------------------------------------------------
create table if not exists private.entitlement_grants (
  id           bigint generated always as identity primary key,
  member_id    uuid not null references private.members (id) on delete cascade,
  entitlement_key text not null references private.entitlement_keys (key),
  grant_type   text not null check (grant_type in ('quota','unlimited')),
  -- quota 면 총 허용 횟수(>0). unlimited 면 null.
  quota_total  integer check (quota_total is null or quota_total > 0),
  starts_at    timestamptz not null default now(),
  expires_at   timestamptz,
  status       text not null default 'active' check (status in ('active','revoked')),
  reason       text,
  granted_by   uuid,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  revoked_by   uuid,
  -- 구조 CHECK: quota 면 quota_total 필수, unlimited 면 null.
  constraint entitlement_grants_quota_shape check (
    (grant_type = 'quota'     and quota_total is not null) or
    (grant_type = 'unlimited' and quota_total is null)
  ),
  -- 구조 CHECK: revoked 면 revoked_at 존재, active 면 null.
  constraint entitlement_grants_revoke_shape check (
    (status = 'active'  and revoked_at is null) or
    (status = 'revoked' and revoked_at is not null)
  )
);
alter table private.entitlement_grants enable row level security;
revoke all on private.entitlement_grants from anon, authenticated;
create index entitlement_grants_member on private.entitlement_grants (member_id, entitlement_key, status);

-- ------------------------------------------------------------
-- 4. 이용 원장 (ledger — reserve/consume/refund)
--    append 전이가 아니라 상태 전이 원장이다. request_id 로 멱등하게 예약하고,
--    성공하면 consumed, 실패하면 refunded 로 전이한다. RESERVED+CONSUMED 만
--    quota 를 점유한다(REFUNDED 는 점유 해제).
-- ------------------------------------------------------------
create table if not exists private.entitlement_ledger (
  id          bigint generated always as identity primary key,
  grant_id    bigint not null references private.entitlement_grants (id) on delete cascade,
  member_id   uuid not null references private.members (id) on delete cascade,
  request_id  text not null,
  state       text not null check (state in ('reserved','consumed','refunded')),
  created_at  timestamptz not null default now(),
  settled_at  timestamptz,
  -- 같은 요청은 한 번만 점유한다(멱등). 재시도가 이중 차감되지 않는다.
  unique (request_id)
);
alter table private.entitlement_ledger enable row level security;
revoke all on private.entitlement_ledger from anon, authenticated;
create index entitlement_ledger_grant on private.entitlement_ledger (grant_id, state);

-- 유효 grant 판정(내부): 활성 + 기간 내 + (unlimited 또는 잔여>0).
--   잔여 = quota_total - (reserved+consumed 점유 수). 잠금 없이 읽기 판정용.
create or replace function private.entitlement_effective(p_grant private.entitlement_grants)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'grant_id', p_grant.id,
    'active', (
      p_grant.status = 'active'
      and now() >= p_grant.starts_at
      and (p_grant.expires_at is null or now() < p_grant.expires_at)
      and (
        p_grant.grant_type = 'unlimited'
        or p_grant.quota_total > (
          select count(*) from private.entitlement_ledger l
           where l.grant_id = p_grant.id and l.state in ('reserved','consumed')
        )
      )
    ),
    'grant_type', p_grant.grant_type,
    'remaining', case when p_grant.grant_type = 'unlimited' then null
      else greatest(0, p_grant.quota_total - (
        select count(*) from private.entitlement_ledger l
         where l.grant_id = p_grant.id and l.state in ('reserved','consumed')
      )) end
  );
$$;
revoke execute on function private.entitlement_effective(private.entitlement_grants)
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 5. 게이트: 조회(preview) — 비변경. 서버 라우트가 funding_source 판정에 쓴다.
--    owner 는 항상 통과(source=owner). 아니면 유효 entitlement 를 찾는다.
--    반환은 판정에 필요한 최소값. 회원 식별정보를 노출하지 않는다.
-- ------------------------------------------------------------
create or replace function public.svc_lesson_plan_access_preview(p_actor uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_grant private.entitlement_grants%rowtype; v_eff jsonb;
begin
  -- owner 는 개인 이용권 없이도 생성 가능(지갑 주인).
  if private.actor_has_permission(p_actor, 'entitlement.manage_cost') then
    return jsonb_build_object('allowed', true, 'source', 'owner');
  end if;
  -- 가장 먼저 만료되는 유효 grant 를 고른다(만료 임박분 우선 소진).
  for v_grant in
    select * from private.entitlement_grants
     where member_id = p_actor and entitlement_key = 'lesson_plan_generate'
       and status = 'active'
     order by coalesce(expires_at, 'infinity'::timestamptz) asc, id asc
  loop
    v_eff := private.entitlement_effective(v_grant);
    if (v_eff->>'active')::boolean then
      return jsonb_build_object('allowed', true, 'source', 'entitlement',
        'grant_id', v_grant.id, 'grant_type', v_grant.grant_type,
        'remaining', v_eff->'remaining');
    end if;
  end loop;
  return jsonb_build_object('allowed', false, 'source', 'none');
end $$;
revoke execute on function public.svc_lesson_plan_access_preview(uuid) from public, anon, authenticated;
grant  execute on function public.svc_lesson_plan_access_preview(uuid) to service_role;

-- ------------------------------------------------------------
-- 6. 게이트: 예약(reserve) — 원자적. grant 행을 잠가 초과예약을 막는다.
--    owner 는 원장 없이 통과(source=owner). entitlement 면 reserved 행 삽입.
--    request_id 멱등: 같은 키 재호출은 기존 예약을 그대로 인정한다.
-- ------------------------------------------------------------
create or replace function public.svc_reserve_lesson_plan_entitlement(
  p_actor uuid, p_request_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_grant private.entitlement_grants%rowtype; v_ex record; v_id bigint; v_occupied int;
begin
  if coalesce(trim(p_request_id),'') = '' then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;

  -- owner 는 개인 이용권 소비 없이 통과.
  if private.actor_has_permission(p_actor, 'entitlement.manage_cost') then
    return jsonb_build_object('ok', true, 'source', 'owner');
  end if;

  -- 같은 request_id 가 이미 있으면 **신원·상태를 검증**한다 (BLOCKER_2, GPT R3A).
  --   · 다른 member 의 것이면 fail-closed — 타인 원장 재사용·quota 우회 차단.
  --   · 같은 member 의 reserved 면 진짜 재시도 → 멱등 인정.
  --   · consumed/refunded 는 이미 종결된 요청 — RESERVED 처럼 재실행하지 않는다.
  select id, member_id, grant_id, state into v_ex
    from private.entitlement_ledger where request_id = p_request_id;
  if found then
    if v_ex.member_id <> p_actor then
      return jsonb_build_object('ok', false, 'reason', 'request_id_conflict');
    end if;
    if v_ex.state = 'reserved' then
      return jsonb_build_object('ok', true, 'source', 'entitlement',
        'grant_id', v_ex.grant_id, 'reason', 'already_reserved');
    end if;
    return jsonb_build_object('ok', false, 'reason', 'request_' || v_ex.state);
  end if;

  -- 유효 grant 를 잠금하고 잔여를 재확인(직렬화로 초과예약 차단).
  for v_grant in
    select * from private.entitlement_grants
     where member_id = p_actor and entitlement_key = 'lesson_plan_generate'
       and status = 'active'
     order by coalesce(expires_at, 'infinity'::timestamptz) asc, id asc
    for update
  loop
    -- 기간 확인(잠금 후 재판정).
    if now() < v_grant.starts_at then continue; end if;
    if v_grant.expires_at is not null and now() >= v_grant.expires_at then continue; end if;
    if v_grant.grant_type = 'quota' then
      select count(*) into v_occupied from private.entitlement_ledger l
        where l.grant_id = v_grant.id and l.state in ('reserved','consumed');
      if v_occupied >= v_grant.quota_total then continue; end if;
    end if;
    -- 예약.
    begin
      insert into private.entitlement_ledger (grant_id, member_id, request_id, state)
      values (v_grant.id, p_actor, p_request_id, 'reserved')
      returning id into v_id;
    exception when unique_violation then
      -- 경합: 방금 같은 request_id 가 들어왔다. 신원 검증 후 멱등 반환.
      select member_id, grant_id, state into v_ex
        from private.entitlement_ledger where request_id = p_request_id;
      if v_ex.member_id <> p_actor then
        return jsonb_build_object('ok', false, 'reason', 'request_id_conflict');
      end if;
      if v_ex.state = 'reserved' then
        return jsonb_build_object('ok', true, 'source', 'entitlement',
          'grant_id', v_ex.grant_id, 'reason', 'already_reserved');
      end if;
      return jsonb_build_object('ok', false, 'reason', 'request_' || v_ex.state);
    end;
    return jsonb_build_object('ok', true, 'source', 'entitlement',
      'grant_id', v_grant.id, 'ledger_id', v_id);
  end loop;

  return jsonb_build_object('ok', false, 'reason', 'no_entitlement');
end $$;
revoke execute on function public.svc_reserve_lesson_plan_entitlement(uuid, text) from public, anon, authenticated;
grant  execute on function public.svc_reserve_lesson_plan_entitlement(uuid, text) to service_role;

-- ------------------------------------------------------------
-- 7. 소비 확정 / 환불 — 예약을 최종 상태로 전이한다.
--    consume: 생성 성공 시. refund: 생성이 실패로 확인된 경우에만.
--    둘 다 reserved 행만 전이한다(멱등: 이미 전이됐으면 ok).
-- ------------------------------------------------------------
create or replace function public.svc_consume_entitlement(p_request_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  update private.entitlement_ledger
     set state = 'consumed', settled_at = now()
   where request_id = p_request_id and state = 'reserved';
  get diagnostics v = row_count;
  if v = 0 then
    -- 이미 consumed 거나(재호출) owner 라 예약이 없었다. 둘 다 정상.
    return jsonb_build_object('ok', true, 'reason', 'noop');
  end if;
  return jsonb_build_object('ok', true, 'consumed', v);
end $$;
revoke execute on function public.svc_consume_entitlement(text) from public, anon, authenticated;
grant  execute on function public.svc_consume_entitlement(text) to service_role;

create or replace function public.svc_refund_entitlement(p_request_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  update private.entitlement_ledger
     set state = 'refunded', settled_at = now()
   where request_id = p_request_id and state = 'reserved';
  get diagnostics v = row_count;
  return jsonb_build_object('ok', true, 'refunded', v);
end $$;
revoke execute on function public.svc_refund_entitlement(text) from public, anon, authenticated;
grant  execute on function public.svc_refund_entitlement(text) to service_role;

-- ------------------------------------------------------------
-- 8. 관리자 RPC: 이용권 부여/회수 (authenticated, auth.uid() 기반)
--    무료 quota 는 owner 지갑 지출을 유발하므로 entitlement.manage_cost(=owner)만.
--    operator 는 조회만(아래 9번).
-- ------------------------------------------------------------
create or replace function public.grant_entitlement(
  p_member_id uuid, p_key text, p_grant_type text,
  p_quota integer, p_expires_at timestamptz, p_reason text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; v_id bigint;
begin
  v_actor := private.require_permission('entitlement.manage_cost');
  if coalesce(trim(p_reason),'') = '' then raise exception 'reason required'; end if;
  if not exists (select 1 from private.entitlement_keys where key = p_key) then
    raise exception 'unknown entitlement key';
  end if;
  if p_grant_type not in ('quota','unlimited') then raise exception 'invalid grant_type'; end if;
  if p_grant_type = 'quota' and (p_quota is null or p_quota <= 0) then
    raise exception 'quota required';
  end if;
  if not exists (select 1 from private.members where id = p_member_id) then
    raise exception 'no member';
  end if;

  insert into private.entitlement_grants
    (member_id, entitlement_key, grant_type, quota_total, expires_at, reason, granted_by)
  values
    (p_member_id, p_key,
     p_grant_type,
     case when p_grant_type = 'quota' then p_quota else null end,
     p_expires_at, p_reason, v_actor)
  returning id into v_id;

  insert into private.audit_logs (actor_id, action, target_type, target_id, reason)
    values (v_actor, 'grant_entitlement:' || p_key, 'member', p_member_id::text, p_reason);
  return v_id;
end $$;
revoke execute on function public.grant_entitlement(uuid, text, text, integer, timestamptz, text)
  from public, anon, authenticated;
grant  execute on function public.grant_entitlement(uuid, text, text, integer, timestamptz, text)
  to authenticated;

create or replace function public.revoke_entitlement(p_grant_id bigint, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; v_member uuid;
begin
  v_actor := private.require_permission('entitlement.manage_cost');
  if coalesce(trim(p_reason),'') = '' then raise exception 'reason required'; end if;
  update private.entitlement_grants
     set status = 'revoked', revoked_at = now(), revoked_by = v_actor
   where id = p_grant_id and status = 'active'
   returning member_id into v_member;
  if not found then raise exception 'no active grant'; end if;
  insert into private.audit_logs (actor_id, action, target_type, target_id, reason)
    values (v_actor, 'revoke_entitlement', 'member', v_member::text, p_reason);
end $$;
revoke execute on function public.revoke_entitlement(bigint, text) from public, anon, authenticated;
grant  execute on function public.revoke_entitlement(bigint, text) to authenticated;

-- ------------------------------------------------------------
-- 9. 관리자 RPC: 회원 목록/상세 조회 (콘솔용)
--    member.read_basic 권한. PII(실명·학번·학번HMAC·이메일·auth id·본문) 미반환.
--    cursor pagination(생성일 desc, id tiebreak), page-size 상한 50.
-- ------------------------------------------------------------
-- 커서 tiebreak 는 members PK(uuid id)로 한다 — 이 표에는 순번 컬럼이 없다.
-- uuid 비교는 의미론적 순서는 아니지만 안정적이라 페이지네이션에 충분하다.
create or replace function public.admin_list_members(
  p_search text default null, p_status text default null, p_role text default null,
  p_cursor timestamptz default null, p_cursor_id uuid default null, p_limit int default 30)
returns table (
  member_id uuid, nickname text, role text, verification_status text,
  sanction text, sanction_until timestamptz, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_lim int := least(greatest(coalesce(p_limit,30),1),50);
begin
  perform private.require_permission('member.read_basic');
  return query
    select m.id, m.nickname, m.role, m.verification_status,
           m.sanction, m.sanction_until, m.created_at
      from private.members m
     where (p_search is null or m.nickname ilike '%' || p_search || '%')
       and (p_status is null or m.verification_status = p_status)
       and (p_role   is null or m.role = p_role)
       and (
         p_cursor is null
         or m.created_at < p_cursor
         or (m.created_at = p_cursor and p_cursor_id is not null and m.id < p_cursor_id)
       )
     order by m.created_at desc, m.id desc
     limit v_lim;
end $$;
revoke execute on function public.admin_list_members(text, text, text, timestamptz, uuid, int)
  from public, anon, authenticated;
grant  execute on function public.admin_list_members(text, text, text, timestamptz, uuid, int)
  to authenticated;

-- 단일 회원 상세: 제재·이용권 이력 요약. PII 미반환.
create or replace function public.admin_member_detail(p_member_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform private.require_permission('member.detail');
  select jsonb_build_object(
    'member_id', m.id, 'nickname', m.nickname, 'role', m.role,
    'verification_status', m.verification_status,
    'sanction', m.sanction, 'sanction_until', m.sanction_until,
    'created_at', m.created_at,
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

-- 이용권 현황: 활성 grant 전체(부여받은 회원 닉네임만). entitlement.read 권한.
--   "지금 누구에게 열려 있나" 를 한눈에 본다. 실명·학번 등은 반환하지 않는다.
create or replace function public.admin_list_entitlements(p_key text default null)
returns table (
  grant_id bigint, member_id uuid, nickname text, entitlement_key text,
  grant_type text, quota_total integer, used bigint,
  starts_at timestamptz, expires_at timestamptz, reason text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_permission('entitlement.read');
  return query
    select g.id, g.member_id, m.nickname, g.entitlement_key,
           g.grant_type, g.quota_total,
           (select count(*) from private.entitlement_ledger l
             where l.grant_id = g.id and l.state in ('reserved','consumed')),
           g.starts_at, g.expires_at, g.reason, g.created_at
      from private.entitlement_grants g
      join private.members m on m.id = g.member_id
     where g.status = 'active'
       and (p_key is null or g.entitlement_key = p_key)
     order by g.created_at desc;
end $$;
revoke execute on function public.admin_list_entitlements(text) from public, anon, authenticated;
grant  execute on function public.admin_list_entitlements(text) to authenticated;

-- ------------------------------------------------------------
-- 10. 콘솔 접근 판정 헬퍼 — 화면 게이트가 "무슨 권한이 있나" 를 물어본다.
--     반환은 permission 문자열 배열. 화면은 이걸로 탭 노출을 정한다(진짜 경계는 각 RPC).
-- ------------------------------------------------------------
create or replace function public.my_admin_permissions()
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(rp.permission order by rp.permission), array[]::text[])
    from private.members m
    join private.role_permissions rp on rp.role = m.role
   where m.id = auth.uid()
     and m.nickname is not null
     and m.verification_status = 'verified'
     and m.sanction = 'none';
$$;
revoke execute on function public.my_admin_permissions() from public, anon;
grant  execute on function public.my_admin_permissions() to authenticated;

commit;

-- ============================================================
-- DOWN (참고 — 가역성 증명용. 추가형이라 이 객체들만 제거하면 원복)
--   drop function public.my_admin_permissions, admin_member_detail(uuid),
--     admin_list_members(...), revoke_entitlement(bigint,text),
--     grant_entitlement(...), svc_refund_entitlement(text), svc_consume_entitlement(text),
--     svc_reserve_lesson_plan_entitlement(uuid,text), svc_lesson_plan_access_preview(uuid);
--   drop function private.entitlement_effective(...), require_permission(text),
--     actor_has_permission(uuid,text);
--   drop table private.entitlement_ledger, entitlement_grants,
--     entitlement_keys, role_permissions;
-- ============================================================
