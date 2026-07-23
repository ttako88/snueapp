-- ============================================================
-- 035_lesson_plan_runs.sql — 지도안 생성 분석 로그 + 집계
-- ============================================================
-- ⚠️ pending/. 추가형·가역. 028(role_permissions)·032 적용 후.
-- 소유자 지시(2026-07-23): 콘솔에 지도안 생성 내역·효용 분석.
--   실행 1건=1행 로그(학년·교과서·목차·약/세·모델·비용·SR·내보내기·약안세안체인).
--   집계: 일일(약/세 별도·인원·API비용·SR) + 효용(업그레이드율·재사용분포·내보내기전환).
-- 설계: docs/LESSON_ANALYTICS_DESIGN_2026-07-23.md
-- 비용/SR 은 각 ledger 가 원본, 여기엔 분석용 스냅샷을 denormalize.
-- private 스키마 + RLS + grant 없음 → 정의자 RPC 만 접근.
-- ============================================================

begin;

-- 1) 로그 테이블
create table if not exists private.lesson_plan_runs (
  id             uuid primary key default gen_random_uuid(),
  member_id      uuid not null references private.members(id) on delete cascade,
  plan_type      text not null check (plan_type in ('brief','full')),
  grade          int,
  subject        text,
  unit           text,
  textbook_id    text,
  publisher      text,
  model          text not null,
  funding_source text not null check (funding_source in ('owner','entitlement','paid')),
  cost_krw       int  not null default 0,
  sr_spent       int  not null default 0,
  chained_from   uuid references private.lesson_plan_runs(id) on delete set null,
  created_at     timestamptz not null default now(),
  exported_docx_at timestamptz,
  exported_hwp_at  timestamptz,
  exported_pdf_at  timestamptz
);
create index if not exists lpr_member_created on private.lesson_plan_runs(member_id, created_at desc);
create index if not exists lpr_created        on private.lesson_plan_runs(created_at desc);
create index if not exists lpr_chain_lookup   on private.lesson_plan_runs(member_id, subject, unit, textbook_id, created_at desc);
alter table private.lesson_plan_runs enable row level security;
revoke all on private.lesson_plan_runs from anon, authenticated;

-- 2) 권한: analytics.read (owner·operator)
insert into private.role_permissions(role, permission) values
  ('owner','analytics.read'), ('operator','analytics.read')
  on conflict (role, permission) do nothing;

-- 3) 로깅 RPC (service_role) — 생성 성공·정산 직후 라우트가 호출. run id 반환.
--    세안이고 클라가 체인(run_id)을 안 주면, 같은 회원+단원+교과서의 최근 약안(2h)을
--    best-effort 로 링크(업그레이드율 지표용). 클라가 주면 그 값을 우선.
create or replace function public.svc_log_lesson_run(
  p_member_id uuid, p_plan_type text, p_model text, p_funding_source text,
  p_grade int default null, p_subject text default null, p_unit text default null,
  p_textbook_id text default null, p_publisher text default null,
  p_cost_krw int default 0, p_sr_spent int default 0, p_chained_from uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_chain uuid := p_chained_from;
begin
  if v_chain is null and p_plan_type = 'full' then
    select r.id into v_chain from private.lesson_plan_runs r
     where r.member_id = p_member_id and r.plan_type = 'brief'
       and r.subject is not distinct from p_subject
       and r.unit is not distinct from p_unit
       and r.textbook_id is not distinct from p_textbook_id
       and r.created_at > now() - interval '2 hours'
     order by r.created_at desc limit 1;
  end if;
  insert into private.lesson_plan_runs(
    member_id, plan_type, model, funding_source, grade, subject, unit,
    textbook_id, publisher, cost_krw, sr_spent, chained_from)
  values (p_member_id, p_plan_type, p_model, p_funding_source, p_grade, p_subject, p_unit,
    p_textbook_id, p_publisher, coalesce(p_cost_krw,0), coalesce(p_sr_spent,0), v_chain)
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.svc_log_lesson_run(uuid,text,text,text,int,text,text,text,text,int,int,uuid)
  from public, anon, authenticated;
grant  execute on function public.svc_log_lesson_run(uuid,text,text,text,int,text,text,text,text,int,int,uuid)
  to service_role;

-- 4) 내보내기 기록 RPC (service_role) — 소유(member) 검증 후 timestamp 갱신.
create or replace function public.svc_mark_lesson_export(p_member_id uuid, p_run_id uuid, p_format text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_hit int;
begin
  if p_format not in ('docx','hwp','pdf') then return false; end if;
  update private.lesson_plan_runs set
    exported_docx_at = case when p_format='docx' then now() else exported_docx_at end,
    exported_hwp_at  = case when p_format='hwp'  then now() else exported_hwp_at  end,
    exported_pdf_at  = case when p_format='pdf'  then now() else exported_pdf_at  end
  where id = p_run_id and member_id = p_member_id;
  get diagnostics v_hit = row_count;
  return v_hit > 0;
end $$;
revoke execute on function public.svc_mark_lesson_export(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.svc_mark_lesson_export(uuid, uuid, text) to service_role;

-- 5) 집계 개요 RPC (authenticated + analytics.read) — 일일 + 효용지표. 읽기전용(STABLE).
create or replace function public.admin_lesson_analytics_overview(p_day date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_day date := coalesce(p_day, (now() at time zone 'Asia/Seoul')::date); v jsonb;
begin
  perform private.require_permission('analytics.read');
  select jsonb_build_object(
    'day', v_day,
    'brief_count', (select count(*) from private.lesson_plan_runs
                     where plan_type='brief' and (created_at at time zone 'Asia/Seoul')::date = v_day),
    'full_count',  (select count(*) from private.lesson_plan_runs
                     where plan_type='full'  and (created_at at time zone 'Asia/Seoul')::date = v_day),
    'users',       (select count(distinct member_id) from private.lesson_plan_runs
                     where (created_at at time zone 'Asia/Seoul')::date = v_day),
    'cost_krw',    (select coalesce(sum(cost_krw),0)::bigint from private.lesson_plan_runs
                     where (created_at at time zone 'Asia/Seoul')::date = v_day),
    'sr_spent',    (select coalesce(sum(sr_spent),0)::bigint from private.lesson_plan_runs
                     where (created_at at time zone 'Asia/Seoul')::date = v_day),
    -- 효용(전체 누적)
    'total_runs',  (select count(*) from private.lesson_plan_runs),
    'export_rate', (select case when count(*)=0 then 0 else
                      round(100.0 * count(*) filter (where exported_docx_at is not null
                        or exported_hwp_at is not null or exported_pdf_at is not null) / count(*), 1) end
                    from private.lesson_plan_runs),
    'upgrade_rate',(select case when b=0 then 0 else round(100.0 * u / b, 1) end from (
                      select count(distinct member_id) filter (where plan_type='brief') b,
                             count(distinct member_id) filter (where plan_type='full' and chained_from is not null) u
                        from private.lesson_plan_runs) t),
    'retention', (select jsonb_build_object(
                     'once',  count(*) filter (where n=1),
                     'few',   count(*) filter (where n between 2 and 4),
                     'loyal', count(*) filter (where n>=5))
                   from (select member_id, count(*) n from private.lesson_plan_runs group by member_id) pm)
  ) into v;
  return v;
end $$;
revoke execute on function public.admin_lesson_analytics_overview(date) from public, anon, authenticated;
grant  execute on function public.admin_lesson_analytics_overview(date) to authenticated;

-- 6) 실행 내역 목록 RPC (authenticated + analytics.read) — 닉네임 join, 필터·커서.
create or replace function public.admin_lesson_runs_list(
  p_limit int default 50, p_before timestamptz default null,
  p_plan_type text default null, p_subject text default null, p_grade int default null)
returns table(id uuid, created_at timestamptz, nickname text, plan_type text, grade int,
  subject text, unit text, textbook_id text, publisher text, model text,
  funding_source text, cost_krw int, sr_spent int, chained boolean,
  exported_docx boolean, exported_hwp boolean, exported_pdf boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_lim int := least(greatest(coalesce(p_limit,50),1),100);
begin
  perform private.require_permission('analytics.read');
  return query
    select r.id, r.created_at, m.nickname, r.plan_type, r.grade, r.subject, r.unit,
           r.textbook_id, r.publisher, r.model, r.funding_source, r.cost_krw, r.sr_spent,
           (r.chained_from is not null),
           (r.exported_docx_at is not null), (r.exported_hwp_at is not null), (r.exported_pdf_at is not null)
      from private.lesson_plan_runs r join private.members m on m.id = r.member_id
     where (p_before is null or r.created_at < p_before)
       and (p_plan_type is null or r.plan_type = p_plan_type)
       and (p_subject   is null or r.subject   = p_subject)
       and (p_grade     is null or r.grade     = p_grade)
     order by r.created_at desc limit v_lim;
end $$;
revoke execute on function public.admin_lesson_runs_list(int, timestamptz, text, text, int)
  from public, anon, authenticated;
grant  execute on function public.admin_lesson_runs_list(int, timestamptz, text, text, int)
  to authenticated;

commit;
