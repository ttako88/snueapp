-- ============================================================
-- 018_ai_usage_budget.sql — AI 호출 사용량·예산 상한
-- ============================================================
-- ⚠️ pending. GPT 검수 전 적용하지 않는다.
--
-- 배경
--   AI 수업지도안 생성은 소유자 지갑에서 실제 돈이 나간다. 원가는 세안 1건당
--   ₩20~35 수준이지만, 버그나 어뷰징 한 번이면 상한 없이 누적된다.
--   기능보다 이 장치가 먼저 있어야 한다는 것이 소유자 확인 사항이다.
--
-- 설계 판단
--   · 상한은 **금액**으로 잡는다. 호출 횟수로 잡으면 모델을 바꿀 때마다
--     의미가 달라진다.
--   · 확인과 기록을 한 함수 안에서 하지 않는다 — 확인 시점과 실제 사용량이
--     다르기 때문이다. 대신 확인은 **예약(reserve)** 을 함께 남겨,
--     동시 요청이 같은 잔액을 보고 둘 다 통과하는 일을 막는다.
--   · 예약은 짧은 유효기간을 갖는다. 호출이 실패해 기록이 안 오면
--     예약만 남아 예산을 잠그는데, 만료로 자연히 풀리게 한다.
--   · 예산 확인이 불가능하면 호출을 거부한다(fail-closed). 확인 못 한 채
--     돈 쓰는 호출을 통과시키면 상한 장치가 무의미하다.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. 사용 기록
--    회원 탈퇴 시 연결만 끊고 회계 기록은 남긴다(ticket_ledger 와 같은 원칙).
-- ------------------------------------------------------------
create table if not exists private.ai_usage (
  id           bigint generated always as identity primary key,
  member_id    uuid references private.members (id) on delete set null,
  model        text not null check (char_length(model) between 1 and 60),
  purpose      text not null check (purpose in ('lesson_plan_brief','lesson_plan_full')),
  in_tokens    integer not null check (in_tokens >= 0),
  out_tokens   integer not null check (out_tokens >= 0),
  cost_krw     integer not null check (cost_krw >= 0),
  -- 예약(reserve)인지 실제 사용 기록인지. 예약은 만료되면 집계에서 빠진다.
  kind         text not null default 'actual' check (kind in ('reserve','actual')),
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  check (kind <> 'reserve' or expires_at is not null)
);
create index if not exists ai_usage_member_day
  on private.ai_usage (member_id, created_at desc);
create index if not exists ai_usage_day on private.ai_usage (created_at desc);

alter table private.ai_usage enable row level security;
revoke all on private.ai_usage from anon, authenticated;

-- ------------------------------------------------------------
-- 2. 예산 확인 + 예약
--    같은 트랜잭션에서 집계하고 예약을 남긴다. 동시 요청 둘이 같은 잔액을
--    읽고 둘 다 통과하는 것을 막기 위함이다.
-- ------------------------------------------------------------
create or replace function public.svc_ai_budget_check(
  p_member_id uuid, p_est_krw integer,
  p_daily_total_krw integer, p_daily_user_krw integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_total integer; v_user integer; v_day date;
begin
  if p_est_krw is null or p_est_krw < 0 then raise exception 'bad estimate'; end if;

  -- 하루 경계는 KST 기준. UTC 로 자르면 한국 사용자에게 오후 9시에 초기화된다.
  v_day := (now() at time zone 'Asia/Seoul')::date;

  -- 만료된 예약은 집계에서 빼기 위해 먼저 정리한다.
  delete from private.ai_usage
   where kind = 'reserve' and expires_at < now();

  select coalesce(sum(cost_krw), 0) into v_total
    from private.ai_usage
   where (created_at at time zone 'Asia/Seoul')::date = v_day;

  select coalesce(sum(cost_krw), 0) into v_user
    from private.ai_usage
   where member_id = p_member_id
     and (created_at at time zone 'Asia/Seoul')::date = v_day;

  if v_total + p_est_krw > p_daily_total_krw then
    return jsonb_build_object('allowed', false, 'reason', 'daily_total_exceeded',
                              'spent_today', v_total);
  end if;
  if v_user + p_est_krw > p_daily_user_krw then
    return jsonb_build_object('allowed', false, 'reason', 'daily_user_exceeded',
                              'spent_today', v_user);
  end if;

  -- 통과했으면 곧바로 예약을 잡는다. 실제 사용량이 오면 이 행을 대체한다.
  insert into private.ai_usage
    (member_id, model, purpose, in_tokens, out_tokens, cost_krw, kind, expires_at)
  values (p_member_id, 'reserve', 'lesson_plan_brief', 0, 0, p_est_krw,
          'reserve', now() + interval '5 minutes');

  return jsonb_build_object('allowed', true, 'spent_today', v_total);
end $$;
revoke execute on function public.svc_ai_budget_check(uuid, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.svc_ai_budget_check(uuid, integer, integer, integer)
  to service_role;

-- ------------------------------------------------------------
-- 3. 실제 사용량 기록
--    가장 오래된 유효 예약 하나를 실제 기록으로 바꾼다. 예약이 없으면
--    (만료됐거나 확인을 건너뛴 호출) 그냥 실제 기록만 남긴다 — 돈은 이미
--    나갔으므로 집계에서 빠뜨리면 안 된다.
-- ------------------------------------------------------------
create or replace function public.svc_ai_record_usage(
  p_member_id uuid, p_model text, p_in_tokens integer, p_out_tokens integer,
  p_cost_krw integer, p_purpose text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  select id into v_id from private.ai_usage
   where member_id = p_member_id and kind = 'reserve' and expires_at > now()
   order by created_at limit 1 for update skip locked;

  if v_id is not null then
    update private.ai_usage
       set kind = 'actual', expires_at = null, model = p_model, purpose = p_purpose,
           in_tokens = p_in_tokens, out_tokens = p_out_tokens, cost_krw = p_cost_krw
     where id = v_id;
  else
    insert into private.ai_usage
      (member_id, model, purpose, in_tokens, out_tokens, cost_krw, kind)
    values (p_member_id, p_model, p_purpose, p_in_tokens, p_out_tokens, p_cost_krw, 'actual');
  end if;
  return true;
end $$;
revoke execute on function public.svc_ai_record_usage(uuid, text, integer, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.svc_ai_record_usage(uuid, text, integer, integer, integer, text)
  to service_role;

-- ------------------------------------------------------------
-- 4. 오늘 사용량 조회 (운영자용)
--    소유자가 "오늘 얼마 나갔나" 를 아침 보고서에서 볼 수 있어야 한다.
-- ------------------------------------------------------------
create or replace function public.svc_ai_usage_today()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'date', (now() at time zone 'Asia/Seoul')::date,
    'total_krw', coalesce(sum(cost_krw) filter (where kind = 'actual'), 0),
    'calls', count(*) filter (where kind = 'actual'),
    'reserved_krw', coalesce(sum(cost_krw) filter (where kind = 'reserve'), 0))
  from private.ai_usage
  where (created_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date;
$$;
revoke execute on function public.svc_ai_usage_today() from public, anon, authenticated;
grant execute on function public.svc_ai_usage_today() to service_role;

commit;
