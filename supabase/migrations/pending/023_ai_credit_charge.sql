-- ============================================================
-- 023_ai_credit_charge.sql — 지도안 생성에 SR 차감
-- ============================================================
-- ⚠️ pending/. GPT 검수 + 소유자 승인 전에는 적용하지 않는다.
-- ⚠️ 022_currency_split.sql 이 **먼저** 적용돼야 한다 (currency 컬럼을 쓴다).
--
-- 왜 필요한가 (docs/POINT_ECONOMY.md §7 에서 발견)
--   지금 /api/lesson-plan 은 로그인만 하면 **무제한**이다. 막는 것은 018 의
--   일일 예산 상한뿐인데, 그건 "소유자 지갑이 하루에 얼마까지 털리는가" 를
--   정할 뿐 **개인이 얼마나 쓰는가** 는 제한하지 않는다.
--   한 사람이 하루 예산을 통째로 소진하면 나머지 전원이 못 쓴다.
--
--   실측 원가: 약안 1건 ₩22. 일일 한도 5,000원 = 약 227건.
--   지금 구조로는 한 계정이 그 227건을 다 쓸 수 있다.
--
-- 설계
--   · 예산 상한(018)과 **함께** 건다. 둘 중 하나라도 막으면 호출하지 않는다.
--     SR 은 "공정한 분배", 예산은 "지갑 보호" 로 목적이 다르다.
--   · 차감은 **생성 전에** 한다. 생성 후에 깎으면 실패 시 돌려주는 경로가
--     또 필요해지고, 그 경로가 실패하면 사용자가 손해를 본다.
--   · 실패하면 되돌린다(역분개). 원장은 append-only 이므로 반대 부호 행을 넣는다.
--   · 무료(free) SR 로만 받는다. 유료 크레딧은 아직 존재하지 않는다.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. 원장 reason 확장
--    011 의 CHECK 를 교체한다. 기존 값은 전부 유지한다 — 빼면 과거 행이
--    제약을 위반해 ALTER 자체가 실패한다.
-- ------------------------------------------------------------
alter table private.ticket_ledger drop constraint if exists ticket_ledger_reason_check;
alter table private.ticket_ledger add constraint ticket_ledger_reason_check
  check (reason in (
    'verification_bonus','review_published','exam_tip_published',
    'helpful_bonus','unlock_subject','clawback',
    'ai_lesson_plan','ai_refund'));

-- 부호 규칙도 같이 넓힌다. 이유와 부호가 어긋나는 행을 막는 장치다.
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'private.ticket_ledger'::regclass
     and pg_get_constraintdef(oid) like '%verification_bonus%delta > 0%';
  if c is not null then
    execute format('alter table private.ticket_ledger drop constraint %I', c);
  end if;
end $$;

alter table private.ticket_ledger add constraint ticket_ledger_sign_check
  check (
    (reason in ('verification_bonus','review_published','exam_tip_published',
                'helpful_bonus','ai_refund') and delta > 0)
    or (reason in ('unlock_subject','clawback','ai_lesson_plan') and delta < 0)
  );

-- ------------------------------------------------------------
-- 2. 요금표
--    코드에 박지 않고 DB 에 둔다 — 값을 바꾸려고 배포하지 않아도 되고,
--    호출부 실수로 다른 금액이 청구되는 경로가 생기지 않는다.
-- ------------------------------------------------------------
create table if not exists private.ai_price_config (
  purpose  text primary key,
  cost_sr  integer not null check (cost_sr > 0),
  updated_at timestamptz not null default now()
);
alter table private.ai_price_config enable row level security;
revoke all on private.ai_price_config from anon, authenticated;

insert into private.ai_price_config (purpose, cost_sr) values
  ('lesson_plan_brief', 10),
  ('lesson_plan_full',  25)
on conflict (purpose) do nothing;

-- ------------------------------------------------------------
-- 3. 차감
--    회원 행을 FOR UPDATE 로 잠가 동시 요청을 직렬화한다. 잠그지 않으면
--    두 요청이 같은 잔액을 읽고 둘 다 통과해 잔액이 음수가 된다
--    (READ COMMITTED 는 이걸 막아 주지 않는다 — 018 에서 같은 문제를 겪었다).
-- ------------------------------------------------------------
create or replace function public.svc_charge_ai_credit(
  p_member_id uuid, p_purpose text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_cost integer;
  v_bal  bigint;
  v_id   bigint;
begin
  select cost_sr into v_cost from private.ai_price_config where purpose = p_purpose;
  if v_cost is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_purpose');
  end if;

  perform 1 from private.members m where m.id = p_member_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_member');
  end if;

  select coalesce(sum(delta), 0) into v_bal
    from private.ticket_ledger
   where member_id = p_member_id and currency = 'free';

  if v_bal < v_cost then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_sr',
                              'balance', v_bal, 'cost', v_cost);
  end if;

  begin
    insert into private.ticket_ledger
      (member_id, delta, reason, currency, idempotency_key)
    values
      (p_member_id, -v_cost, 'ai_lesson_plan', 'free', p_idempotency_key)
    returning id into v_id;
  exception when unique_violation then
    -- 같은 키로 이미 청구됐다. 두 번 깎지 않는다.
    return jsonb_build_object('ok', true, 'reason', 'already_charged', 'cost', v_cost);
  end;

  return jsonb_build_object('ok', true, 'entry_id', v_id, 'cost', v_cost,
                            'balance', v_bal - v_cost);
end $$;
revoke execute on function public.svc_charge_ai_credit(uuid, text, text)
  from public, anon, authenticated;
grant  execute on function public.svc_charge_ai_credit(uuid, text, text) to service_role;

-- ------------------------------------------------------------
-- 4. 환불
--    생성이 **실패로 확인된** 경우에만 부른다. 애매하면 부르지 않는다 —
--    결과를 받았는데 환불까지 하면 공짜가 된다.
-- ------------------------------------------------------------
create or replace function public.svc_refund_ai_credit(
  p_member_id uuid, p_entry_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_delta integer; v_cur text;
begin
  select delta, currency into v_delta, v_cur
    from private.ticket_ledger
   where id = p_entry_id and member_id = p_member_id and reason = 'ai_lesson_plan';
  if v_delta is null then
    return jsonb_build_object('ok', false, 'reason', 'entry_not_found');
  end if;

  begin
    insert into private.ticket_ledger
      (member_id, delta, reason, currency, reverses_entry_id, idempotency_key)
    values
      (p_member_id, -v_delta, 'ai_refund', v_cur, p_entry_id,
       'ai_refund:' || p_entry_id::text);
  exception when unique_violation then
    -- 이미 환불했다. 두 번 돌려주지 않는다.
    return jsonb_build_object('ok', true, 'reason', 'already_refunded');
  end;

  return jsonb_build_object('ok', true, 'refunded', -v_delta);
end $$;
revoke execute on function public.svc_refund_ai_credit(uuid, bigint)
  from public, anon, authenticated;
grant  execute on function public.svc_refund_ai_credit(uuid, bigint) to service_role;

commit;

-- ============================================================
-- ⚠️ 022 의 clawback 통화 검사 트리거와의 관계
--   ai_refund 는 reverses_entry_id 를 채우므로 그 트리거를 지난다.
--   같은 currency 로 넣으므로 통과한다(위 함수가 원본 행의 currency 를 읽어 쓴다).
--
-- 적용 순서
--   022_currency_split.sql → 023_ai_credit_charge.sql → 라우트 배포
--   (023 은 currency 컬럼을 쓴다. 순서가 뒤바뀌면 적용 자체가 실패한다.)
-- ============================================================
