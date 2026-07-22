-- ============================================================
-- 026_analytics_dashboard.sql — 운영자 집계 대시보드 (S4)
-- ============================================================
-- ⚠️ pending. GPT 검수(C-20260722-PACKET_S4) 전 prod 에 적용하지 않는다.
--    선행: 024(member_academic·동의) + 025(usage_events·counters).
--
-- 무엇을 하나: 운영자(operator+)만 볼 수 있는 **집계** 조회 함수. 개인 단위
-- drill-down 을 절대 반환하지 않는다. 학과·학년 세그먼트는 상세통계 동의자
-- 원시(usage_events)에서만 집계하고, 소수 셀(k<5)은 숨긴다.
--
-- 검수 MUST (설계 확정 + GPT)
--   · operator+ 만(actor_role_check('operator') — 자격 없으면 raise). 조회는 audit 로그.
--   · 원시 drill-down 없음 · 개인 식별자(subject/HMAC/uuid) 미반환.
--   · k-익명: 대시보드 셀 ≥ 5 미만은 숨김. (광고 20·광고주 10 은 S6.)
--   · CSV 원시 export 없음(엔드포인트 자체를 두지 않는다).
--   · 미동의자는 세그먼트 통계에서 제외(usage_events 에 없음). 총량은 usage_counters.
-- ============================================================

begin;

-- 대시보드 셀 최소 노출 임계(k). 이 미만 셀은 통계에서 숨긴다.
-- (함수 안에 상수로 박되, 의미를 드러내려 주석으로 남긴다. 광고는 별도 임계.)

-- ------------------------------------------------------------
-- 1. 조회 audit 헬퍼 — 누가 무엇을 봤는지 남긴다.
-- ------------------------------------------------------------
create or replace function private.audit_analytics_view(p_what text)
returns void language sql security definer set search_path = '' as $$
  insert into private.audit_logs (actor_id, action, target_type, target_id)
  values (auth.uid(), 'analytics_view', 'analytics', p_what);
$$;
revoke execute on function private.audit_analytics_view(text) from public, anon, authenticated;
-- private 함수라 authenticated 에 grant 하지 않는다. 아래 public 함수가 내부 호출.

-- ------------------------------------------------------------
-- 1-b. k-익명 suppression (GPT S4 BLOCKER — DB 에서 강제)
--    입력: [{...,'n':정수}, ...]. 규칙:
--      · primary   : n < k 인 셀은 숨긴다.
--      · complementary: 숨겨진 셀이 **정확히 1개**면(총계-공개셀로 역산 가능),
--        가장 작은 공개셀도 추가로 숨긴다 → 항상 0개 또는 ≥2개만 숨겨진다.
--    반환에 'suppressed count' 를 넣지 않는다(역산 힌트 차단).
-- ------------------------------------------------------------
create or replace function private.k_suppress(p_rows jsonb, p_k int default 5)
returns jsonb language sql immutable set search_path = '' as $$
  with cells as (
    select value, (value->>'n')::numeric n
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) value
  ),
  hidden  as (select count(*) c from cells where n < p_k),
  visible as (select value, n from cells where n >= p_k),
  minv    as (select min(n) m from visible)
  select coalesce(jsonb_agg(value order by n desc), '[]'::jsonb)
    from visible, hidden, minv
   where not (hidden.c = 1 and visible.n = minv.m);
$$;
revoke execute on function private.k_suppress(jsonb, int) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 1-c. 주간 세그먼트 스냅샷 (GPT 최종검수 B2)
--    세그먼트 통계는 **직전 완결 ISO 주** 단일 cadence 로만 낸다(주는 서로 비중첩
--    → 기간차감 불가). 그 주가 끝난 뒤 처음 조회될 때 suppression 적용 payload 를
--    이 표에 **확정**하고, 이후 조회는 이 확정본을 반환한다 → 철회 CASCADE 로
--    기초행이 바뀌어도 공개 count 가 변하지 않는다(불변 스냅샷).
-- ------------------------------------------------------------
create table private.analytics_week_snapshots (
  event_name   text not null,
  week_start   date not null,   -- 그 주 월요일(ISO)
  payload      jsonb not null,  -- 이미 suppression 적용된 공개본
  finalized_at timestamptz not null default now(),
  primary key (event_name, week_start)
);
alter table private.analytics_week_snapshots enable row level security;
revoke all on private.analytics_week_snapshots from anon, authenticated;

-- ------------------------------------------------------------
-- 2. 개요 — 회원/인증 총계 + 학과·학년 분포(k≥5) + 이벤트 총량
-- ------------------------------------------------------------
create or replace function public.analytics_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_members jsonb;
  v_by_dept jsonb;
  v_by_grade jsonb;
  v_events jsonb;
begin
  perform private.actor_role_check('operator');   -- 자격 없으면 raise
  perform private.audit_analytics_view('overview');

  select jsonb_build_object(
           'total', count(*),
           'verified', count(*) filter (where verification_status = 'verified'),
           'pending',  count(*) filter (where verification_status in ('pending','submitted'))
         ) into v_members
    from private.members;

  -- 학과 분포: primary+complementary suppression 을 DB 에서 강제.
  select private.k_suppress((
    select coalesce(jsonb_agg(jsonb_build_object('department', d, 'n', n)), '[]'::jsonb)
      from (select entry_department d, count(*)::int n
              from private.member_academic
             where entry_department is not null
             group by entry_department) t))
    into v_by_dept;

  -- 학년 분포(사용자 확정 우선, 없으면 파생 제안값): 동일 suppression.
  select private.k_suppress((
    select coalesce(jsonb_agg(jsonb_build_object('grade', g, 'n', n)), '[]'::jsonb)
      from (select coalesce(current_grade, expected_grade) g, count(*)::int n
              from private.member_academic
             where coalesce(current_grade, expected_grade) is not null
             group by coalesce(current_grade, expected_grade)) t))
    into v_by_grade;

  -- 이벤트 총량(집계치 — 개인 아님). 미동의 counter + 동의자 원시 합산.
  -- union 을 event_name 으로 한 번 더 묶어야 object_agg 키가 유일해진다.
  select coalesce(jsonb_object_agg(event_name, total), '{}'::jsonb) into v_events
    from (
      select event_name, sum(c)::bigint total from (
        select event_name, sum(cnt)::bigint c from private.usage_counters group by event_name
        union all
        select event_name, count(*)::bigint c from private.usage_events group by event_name
      ) u
      group by event_name
    ) x;

  return jsonb_build_object(
    'members', v_members,
    'by_department', v_by_dept,
    'by_grade', v_by_grade,
    'events', v_events);
end $$;
revoke execute on function public.analytics_overview() from public, anon, authenticated;
grant execute on function public.analytics_overview() to authenticated;

-- ------------------------------------------------------------
-- 3. 이벤트별 학과×학년 세그먼트 — 동의자 원시에서만.
--    (GPT 최종검수 B2) **직전 완결 ISO 주 단일 cadence**. 주는 서로 비중첩이라
--    기간차감이 불가능하다. 그 주 payload 는 처음 조회 시 suppression 을 적용해
--    analytics_week_snapshots 에 확정하고, 이후엔 확정본을 반환한다 → 철회 CASCADE
--    로 기초행이 변해도 공개 count 가 바뀌지 않는다(불변). 월·분기 세그먼트는
--    제공하지 않는다(총량은 analytics_daily 로 비세그먼트만).
-- ------------------------------------------------------------
create or replace function public.analytics_event_segments(p_event text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_kst   date := (now() at time zone 'Asia/Seoul')::date;
  v_start date := date_trunc('week', v_kst)::date - 7;  -- 지난 완결 주 월요일
  v_end   date := date_trunc('week', v_kst)::date;
  v_rows  jsonb;
begin
  perform private.actor_role_check('operator');
  perform private.audit_analytics_view('segments:' || coalesce(p_event,'') || ':' || v_start);

  -- 이미 확정된 주면 그 스냅샷을 그대로 반환(불변).
  select payload into v_rows
    from private.analytics_week_snapshots
   where event_name = p_event and week_start = v_start;
  if found then
    return jsonb_build_object('event', p_event, 'week_start', v_start, 'week_end', v_end,
                              'segments', v_rows, 'finalized', true);
  end if;

  -- 미확정이면 지금 계산해 suppression 적용 후 확정(첫 조회가 스냅샷을 고정).
  select private.k_suppress((
    select coalesce(jsonb_agg(jsonb_build_object(
             'department', dept, 'grade', grade, 'n', n)), '[]'::jsonb)
      from (select segment_department dept, segment_grade grade, count(*)::int n
              from private.usage_events
             where event_name = p_event
               and (occurred_at at time zone 'Asia/Seoul')::date >= v_start
               and (occurred_at at time zone 'Asia/Seoul')::date <  v_end
             group by segment_department, segment_grade) t))
    into v_rows;

  insert into private.analytics_week_snapshots (event_name, week_start, payload)
  values (p_event, v_start, v_rows)
  on conflict (event_name, week_start) do nothing;
  -- 경합으로 남이 먼저 확정했으면 그 값을 최종으로 읽는다.
  select payload into v_rows
    from private.analytics_week_snapshots
   where event_name = p_event and week_start = v_start;

  return jsonb_build_object('event', p_event, 'week_start', v_start, 'week_end', v_end,
                            'segments', v_rows, 'finalized', true);
end $$;
revoke execute on function public.analytics_event_segments(text, int) from public, anon, authenticated;
grant execute on function public.analytics_event_segments(text, int) to authenticated;

-- ------------------------------------------------------------
-- 4. 일별 총량(시계열) — 집계치. 개인 아님.
-- ------------------------------------------------------------
create or replace function public.analytics_daily(p_event text, p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_rows jsonb; v_days int := case when p_days in (7,30,90) then p_days else 30 end;
begin
  perform private.actor_role_check('operator');
  perform private.audit_analytics_view('daily:' || coalesce(p_event,''));

  select coalesce(jsonb_agg(jsonb_build_object('day', day, 'n', n) order by day), '[]'::jsonb)
    into v_rows
    from (
      select day, sum(n)::bigint n from (
        select event_day day, sum(cnt)::bigint n
          from private.usage_counters
         where event_name = p_event and event_day >= (now() at time zone 'Asia/Seoul')::date - v_days
         group by event_day
        union all
        select (occurred_at at time zone 'Asia/Seoul')::date day, count(*)::bigint n
          from private.usage_events
         where event_name = p_event and occurred_at >= now() - (v_days || ' days')::interval
         group by (occurred_at at time zone 'Asia/Seoul')::date
      ) s group by day
    ) t;

  return jsonb_build_object('event', p_event, 'days', v_days, 'daily', v_rows);
end $$;
revoke execute on function public.analytics_daily(text, int) from public, anon, authenticated;
grant execute on function public.analytics_daily(text, int) to authenticated;

commit;
