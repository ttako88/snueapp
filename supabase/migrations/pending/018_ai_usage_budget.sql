-- ============================================================
-- 018_ai_usage_budget.sql — AI 호출 비용 상한 (rev2)
-- ============================================================
-- ⚠️ pending. GPT 검수 전 적용하지 않는다.
--
-- 보장해야 하는 단일 불변식
--   **AI 호출 총비용이 KST 일일 한도를 초과할 수 없다.**
--
-- rev1 은 이걸 보장하지 못했다. GPT 검수(P-20260722-PACKET_018_AI_BUDGET_REVIEW_01)가
-- 찾은 초과 경로 셋:
--   ① READ COMMITTED 에서 두 트랜잭션이 같은 잔액을 읽고 둘 다 통과
--      (₩4,800 상태에서 ₩200 요청 둘 → ₩5,200)
--   ② 실제 비용이 예약액보다 클 수 있음
--   ③ AI 호출은 성공했는데 기록이 실패하면 예약이 만료로 사라져 비용이 잊힘
--   ④ 일일 한도를 함수 인자로 받아 호출부 오류로 우회 가능
--
-- rev2 의 해법
--   ① **날짜별 guard 행을 FOR UPDATE 로 잠근다.** 같은 날의 예약은 직렬화된다.
--   ② 견적이 아니라 **그 호출이 낼 수 있는 최대 비용**을 예약한다.
--      정산 시 실제가 예약액을 넘으면 거부하고 예약액을 그대로 청구한다.
--   ③ 예약은 자동 소멸하지 않는다. 만료된 예약은 **비용으로 간주**한 채 남고,
--      해제는 호출 실패가 확인된 경우에만 명시적으로 한다.
--   ④ 한도는 DB 설정 테이블 한 곳에서만 읽는다. 인자로 받지 않는다.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. 한도 설정 — 신뢰 가능한 단일 출처
--    호출부가 한도를 넘겨주지 않는다. 넘겨받으면 p_daily_total=500000 같은
--    호출부 오류가 상한을 통째로 무력화한다.
-- ------------------------------------------------------------
create table if not exists private.ai_budget_config (
  id                 boolean primary key default true check (id),  -- 단일 행 강제
  daily_total_krw    integer not null check (daily_total_krw   >= 0),
  daily_user_krw     integer not null check (daily_user_krw    >= 0),
  single_call_max_krw integer not null check (single_call_max_krw > 0),
  updated_at         timestamptz not null default now()
);
insert into private.ai_budget_config (id, daily_total_krw, daily_user_krw, single_call_max_krw)
values (true, 5000, 1000, 200)
on conflict (id) do nothing;

alter table private.ai_budget_config enable row level security;
revoke all on private.ai_budget_config from anon, authenticated;

-- ------------------------------------------------------------
-- 2. 날짜별 guard — 동시성 직렬화 지점
--    이 행을 FOR UPDATE 로 잠근 뒤에만 집계·예약을 한다.
-- ------------------------------------------------------------
create table if not exists private.ai_budget_day (
  day date primary key,
  created_at timestamptz not null default now()
);
alter table private.ai_budget_day enable row level security;
revoke all on private.ai_budget_day from anon, authenticated;

-- ------------------------------------------------------------
-- 3. 예약과 정산
--    open   = 돈이 나갈 수 있는 상태. **비용으로 간주한다.**
--    settled= 실제 사용량 확정
--    released = 호출이 실패했음이 확인돼 해제됨
--
--    만료(expires_at 경과)해도 자동으로 사라지지 않는다. open 인 채 남아
--    계속 비용으로 잡힌다 — AI 호출은 성공했는데 기록만 실패한 경우를
--    "안 쓴 것" 으로 처리하면 상한이 새기 때문이다.
-- ------------------------------------------------------------
create table if not exists private.ai_usage (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid references private.members (id) on delete set null,
  day          date not null,
  state        text not null default 'open' check (state in ('open','settled','released')),
  -- 예약 시점에 정한 최대 비용. 실제 비용은 이 값을 넘을 수 없다.
  max_krw      integer not null check (max_krw > 0),
  -- 정산 후 실제 비용. open 인 동안은 null 이고 집계에는 max_krw 를 쓴다.
  actual_krw   integer check (actual_krw is null or actual_krw >= 0),
  model        text,
  purpose      text check (purpose is null or purpose in ('lesson_plan_brief','lesson_plan_full')),
  in_tokens    integer check (in_tokens is null or in_tokens >= 0),
  out_tokens   integer check (out_tokens is null or out_tokens >= 0),
  created_at   timestamptz not null default now(),
  settled_at   timestamptz,
  expires_at   timestamptz not null,
  check (state <> 'settled' or (actual_krw is not null and settled_at is not null)),
  check (actual_krw is null or actual_krw <= max_krw)
);
create index if not exists ai_usage_day_state on private.ai_usage (day, state);
create index if not exists ai_usage_member_day on private.ai_usage (member_id, day);

alter table private.ai_usage enable row level security;
revoke all on private.ai_usage from anon, authenticated;

-- ------------------------------------------------------------
-- 4. 예약 — 유일한 진입점
--    호출이 낼 수 있는 **최대** 비용을 받아 잠금 아래에서 판정한다.
-- ------------------------------------------------------------
create or replace function public.svc_ai_reserve(p_member_id uuid, p_max_krw integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_day date; v_cfg private.ai_budget_config%rowtype;
  v_total integer; v_user integer; v_id uuid;
begin
  if p_member_id is null then raise exception 'member required'; end if;
  if p_max_krw is null or p_max_krw <= 0 then raise exception 'bad max cost'; end if;

  select * into v_cfg from private.ai_budget_config where id;
  if not found then raise exception 'budget config missing'; end if;

  -- 단건 상한도 설정에서 읽는다
  if p_max_krw > v_cfg.single_call_max_krw then
    return jsonb_build_object('allowed', false, 'reason', 'single_call_too_expensive');
  end if;

  -- KST 경계. UTC 로 자르면 한국 사용자에게 오후 9시에 초기화된다.
  v_day := (now() at time zone 'Asia/Seoul')::date;

  -- ★ 직렬화 지점. 같은 날의 예약은 여기서 한 줄로 세워진다.
  insert into private.ai_budget_day (day) values (v_day) on conflict (day) do nothing;
  perform 1 from private.ai_budget_day where day = v_day for update;

  -- open 은 아직 안 쓴 게 아니라 **쓸 수 있는 돈**이므로 max_krw 로 잡는다.
  -- settled 는 확정된 실제 비용.
  select coalesce(sum(case when state = 'open' then max_krw
                           when state = 'settled' then actual_krw else 0 end), 0)
    into v_total from private.ai_usage where day = v_day;

  select coalesce(sum(case when state = 'open' then max_krw
                           when state = 'settled' then actual_krw else 0 end), 0)
    into v_user from private.ai_usage where day = v_day and member_id = p_member_id;

  if v_total + p_max_krw > v_cfg.daily_total_krw then
    return jsonb_build_object('allowed', false, 'reason', 'daily_total_exceeded',
                              'spent_today', v_total, 'limit', v_cfg.daily_total_krw);
  end if;
  if v_user + p_max_krw > v_cfg.daily_user_krw then
    return jsonb_build_object('allowed', false, 'reason', 'daily_user_exceeded',
                              'spent_today', v_user, 'limit', v_cfg.daily_user_krw);
  end if;

  insert into private.ai_usage (member_id, day, max_krw, expires_at)
  values (p_member_id, v_day, p_max_krw, now() + interval '10 minutes')
  returning id into v_id;

  return jsonb_build_object('allowed', true, 'reservation_id', v_id,
                            'spent_today', v_total, 'limit', v_cfg.daily_total_krw);
end $$;
revoke execute on function public.svc_ai_reserve(uuid, integer) from public, anon, authenticated;
grant execute on function public.svc_ai_reserve(uuid, integer) to service_role;

-- ------------------------------------------------------------
-- 5. 정산 — 자기 예약만 건드린다
--    실제 비용이 예약액을 넘으면 거부한다. 넘는 순간 상한이 이미 깨진
--    것이므로 조용히 받아들이면 안 된다. 그 경우 예약은 open 으로 남아
--    max_krw 가 계속 비용으로 잡힌다(보수적 처리).
-- ------------------------------------------------------------
create or replace function public.svc_ai_settle(
  p_reservation_id uuid, p_member_id uuid, p_model text,
  p_in_tokens integer, p_out_tokens integer, p_actual_krw integer, p_purpose text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v private.ai_usage%rowtype;
begin
  if p_member_id is null then raise exception 'member required'; end if;

  select * into v from private.ai_usage
   where id = p_reservation_id and member_id = p_member_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_reservation'); end if;
  if v.state <> 'open' then
    return jsonb_build_object('ok', false, 'reason', 'already_' || v.state);
  end if;
  if p_actual_krw is null or p_actual_krw < 0 then raise exception 'bad actual cost'; end if;
  if p_actual_krw > v.max_krw then
    -- 예약보다 비싸게 나왔다. 예약을 open 으로 두어 max_krw 를 계속 청구한 채
    -- 실패를 알린다 — 이 상황 자체가 견적 로직 결함이므로 드러나야 한다.
    return jsonb_build_object('ok', false, 'reason', 'actual_exceeds_reserved',
                              'max_krw', v.max_krw, 'actual_krw', p_actual_krw);
  end if;

  update private.ai_usage
     set state = 'settled', actual_krw = p_actual_krw, settled_at = now(),
         model = p_model, purpose = p_purpose,
         in_tokens = p_in_tokens, out_tokens = p_out_tokens
   where id = v.id;
  return jsonb_build_object('ok', true, 'charged_krw', p_actual_krw);
end $$;
revoke execute on function public.svc_ai_settle(uuid, uuid, text, integer, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.svc_ai_settle(uuid, uuid, text, integer, integer, integer, text)
  to service_role;

-- ------------------------------------------------------------
-- 6. 해제 — 호출 실패가 **확인된** 경우에만
--    성공 여부가 불명확한 예약은 해제하지 않는다. 애매하면 돈이 나간 쪽으로
--    간주하는 편이 안전하다.
-- ------------------------------------------------------------
create or replace function public.svc_ai_release(p_reservation_id uuid, p_member_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if p_member_id is null then raise exception 'member required'; end if;
  update private.ai_usage
     set state = 'released', settled_at = now()
   where id = p_reservation_id and member_id = p_member_id and state = 'open';
  get diagnostics n = row_count;
  return n = 1;
end $$;
revoke execute on function public.svc_ai_release(uuid, uuid) from public, anon, authenticated;
grant execute on function public.svc_ai_release(uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- 7. 오늘 사용 현황 (아침 보고용)
--    open 을 따로 보여 준다 — 정산되지 않은 채 남은 것이 있으면
--    기록 실패나 미완 호출이 있다는 신호다.
-- ------------------------------------------------------------
create or replace function public.svc_ai_usage_today()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'day', (now() at time zone 'Asia/Seoul')::date,
    'settled_krw', coalesce(sum(actual_krw) filter (where state = 'settled'), 0),
    'open_krw',    coalesce(sum(max_krw)    filter (where state = 'open'), 0),
    'calls',       count(*) filter (where state = 'settled'),
    'stuck_open',  count(*) filter (where state = 'open' and expires_at < now()),
    'limit_krw',   (select daily_total_krw from private.ai_budget_config where id))
  from private.ai_usage
  where day = (now() at time zone 'Asia/Seoul')::date;
$$;
revoke execute on function public.svc_ai_usage_today() from public, anon, authenticated;
grant execute on function public.svc_ai_usage_today() to service_role;

commit;
