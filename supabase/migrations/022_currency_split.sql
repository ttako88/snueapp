-- ============================================================
-- 022_currency_split.sql — 원장 화폐 분리 (무료 SR / 유료)
-- ============================================================
-- ⚠️ pending/. GPT 검수 + 소유자 승인 전에는 적용하지 않는다.
--
-- 설계 근거: docs/CURRENCY_SPLIT_DESIGN.md
--
-- 왜 지금인가
--   **유료 기능이 아직 하나도 없다.** 그래서 기존 원장 행은 전부 무료 기여
--   보상이고, 소급 분류가 100% 정확하다. 유료가 한 건이라도 섞인 뒤에는
--   append-only 원장을 되돌릴 수 없어 영영 못 나눈다.
--
-- 무엇을 하지 않는가
--   · 유료 크레딧을 **팔지 않는다** (사업자등록 없음)
--   · 마켓 결제를 원장에 **넣지 않는다** — 플랫폼이 돈을 보유하지 않기로 했다.
--     'marketplace' 값을 미리 만들어 두지 않는 이유: 값이 있으면 나중에
--     "이미 있으니까" 하고 쓰게 된다. 문은 닫아 두고 필요할 때 연다.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. 화폐 구분
--    NOT NULL DEFAULT 'free' — 기존 행이 전부 무료 보상이므로 정확하다.
-- ------------------------------------------------------------
alter table private.ticket_ledger
  add column if not exists currency text not null default 'free';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ticket_ledger_currency_chk') then
    alter table private.ticket_ledger
      add constraint ticket_ledger_currency_chk check (currency in ('free', 'paid'));
  end if;
end $$;

comment on column private.ticket_ledger.currency is
  'free = 기여·광고로 얻은 SR(양도·환금 불가, 구글 리워드 정책 전제). '
  'paid = 현금 구매분(부채·환불 대상). 두 화폐를 한 거래에서 섞지 않는다.';

-- 잔액 조회가 화폐별로 도므로 인덱스도 그 모양으로.
create index if not exists ticket_ledger_member_currency
  on private.ticket_ledger (member_id, currency);

-- ------------------------------------------------------------
-- 2. 회수(clawback)는 같은 화폐로만
--    무료로 준 것을 유료에서 빼거나 그 반대가 되면 환불액 계산이 무너진다.
-- ------------------------------------------------------------
create or replace function private.guard_ledger_currency()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_cur text;
begin
  if new.reverses_entry_id is not null then
    select currency into v_cur from private.ticket_ledger where id = new.reverses_entry_id;
    if v_cur is null then
      raise exception 'reverses_entry_id % not found', new.reverses_entry_id;
    end if;
    if v_cur <> new.currency then
      raise exception 'currency mismatch: entry % is %, clawback is %',
        new.reverses_entry_id, v_cur, new.currency;
    end if;
  end if;
  return new;
end $$;

-- 트리거 함수는 트리거만 부른다. 기본 PUBLIC EXECUTE 를 회수해 "anon EXECUTE 0"
-- 불변식을 지킨다(사후검증이 잡았다 — private 스키마라 도달성은 낮지만 규율).
revoke execute on function private.guard_ledger_currency() from public, anon, authenticated;

drop trigger if exists ticket_ledger_currency_guard on private.ticket_ledger;
create trigger ticket_ledger_currency_guard
  before insert on private.ticket_ledger
  for each row execute function private.guard_ledger_currency();

-- ------------------------------------------------------------
-- 3. 잔액을 화폐별로
--    ⚠️ 반환 모양이 바뀐다. 011 의 my_ticket_balance 는
--       { balance, spendable } 였다. 화면이 이 함수를 쓰고 있으면
--       같이 고쳐야 한다 (아래 주 참조).
-- ------------------------------------------------------------
create or replace function public.my_ticket_balance()
returns jsonb language sql security definer set search_path='' stable as $$
  with b as (
    select l.currency,
           coalesce(sum(l.delta), 0)::bigint as bal
      from private.ticket_ledger l
     where l.member_id = auth.uid()
     group by l.currency
  )
  select jsonb_build_object(
    'free', jsonb_build_object(
      'balance',   coalesce((select bal from b where currency = 'free'), 0),
      'spendable', greatest(coalesce((select bal from b where currency = 'free'), 0), 0)),
    'paid', jsonb_build_object(
      'balance',   coalesce((select bal from b where currency = 'paid'), 0),
      'spendable', greatest(coalesce((select bal from b where currency = 'paid'), 0), 0)),
    -- 이전 모양 호환. 화면이 아직 안 고쳐졌어도 깨지지 않게 남긴다.
    -- ⚠️ 합계는 **표시용이다.** 소비 판정에 쓰면 두 화폐가 섞인다.
    'balance',   coalesce((select sum(bal) from b), 0),
    'spendable', greatest(coalesce((select sum(bal) from b), 0), 0));
$$;
revoke execute on function public.my_ticket_balance() from public, anon, authenticated;
grant  execute on function public.my_ticket_balance() to authenticated;

commit;

-- ============================================================
-- 적용 후 확인할 것
--   · 기존 행이 전부 currency='free' 인가
--       select currency, count(*) from private.ticket_ledger group by 1;
--   · my_ticket_balance() 를 쓰는 화면이 새 모양을 견디는가
--       (balance/spendable 키를 남겨 뒀으므로 당장은 깨지지 않는다)
--
-- 다음 단계 (이 배치 아님)
--   · 소비 RPC 들이 currency 를 명시하게 수정 (지금은 default 'free')
--   · 무료 우선 소비 규칙
--   · 유료 크레딧 판매 — **사업자등록 전에는 열지 않는다**
-- ============================================================
