-- ============================================================
-- 027_sponsors.sql — first-party 스폰서 슬롯 (S6, targetedAds 뒤 휴면)
-- ============================================================
-- ⚠️ pending. GPT 검수(P-...PACKET_S6_REVIEW_01) 반영본. prod 미적용.
--    적용돼도 노출은 flag targetedAds(OFF)+사업자등록 전까지 휴면(UI 미배선).
--    선행: 024(동의·파생) + 025(usage_events·analytics_subjects·usage_rate).
--
-- 설계 (소유자 지시 + GPT MUST)
--   · 맞춤은 **서버가** 학과·학년으로 고른다. 세그먼트는 서버 밖으로 안 나가고
--     클라이언트엔 크리에이티브만. 동의(targeted_ads,18+)+세그먼트≥20 일 때만 맞춤.
--   · **광고 이벤트 위조·증폭 차단(GPT S6 BLOCKER):** 서빙 시 단명 opaque delivery
--     token(sponsor_id+slot+만료 결속, PII 없음) 발급. ad-event 는 클라 sponsor_id 를
--     신뢰하지 않고 token 에서 서버가 복원. token 당 impression/click 각 1회(원자적),
--     만료·위조·재사용은 write 0. member×분 상한 초과도 write 0(양쪽 저장소).
--   · 광고주엔 집계만(k≥10). Google/AdMob·리워드는 네이티브 통합지점(held).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 0. DB 활성화 fence (GPT S6 최종검수 B4)
--    features.js 의 targetedAds 는 UX 스위치일 뿐 권한 경계가 아니다. 027 을
--    적용해 authenticated 에 RPC 실행권을 주면 UI 미배선이어도 직접 호출된다.
--    그래서 **DB 안에서** 광고 서빙 on/off 를 잠근다. 기본 false — 사업자등록 후
--    소유자가 이 값을 true 로 바꿔야(운영 mutation) 서빙이 열린다.
-- ------------------------------------------------------------
create table if not exists private.app_flags (
  key     text primary key,
  enabled boolean not null default false
);
alter table private.app_flags enable row level security;
revoke all on private.app_flags from anon, authenticated;
insert into private.app_flags (key, enabled) values ('targeted_ads', false)
  on conflict (key) do nothing;

create or replace function private.ad_serving_enabled()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select enabled from private.app_flags where key = 'targeted_ads'), false);
$$;
revoke execute on function private.ad_serving_enabled() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 1. 스폰서 크리에이티브 + 타겟팅
-- ------------------------------------------------------------
create table private.sponsors (
  id                bigint generated always as identity primary key,
  slot              text not null check (slot ~ '^slot_[a-z0-9_]{1,30}$'),
  title             text not null check (char_length(title) between 1 and 60),
  body              text check (body is null or char_length(body) <= 200),
  link_url          text not null check (link_url ~ '^https://'),  -- https 만
  advertiser        text not null check (char_length(advertiser) between 1 and 60),
  target_department text,                          -- null = 전체(비타겟)
  target_grade      smallint check (target_grade is null or target_grade between 1 and 8),
  active            boolean not null default true,
  weight            smallint not null default 1 check (weight >= 1),
  created_at        timestamptz not null default now()
);
create index sponsors_pick on private.sponsors (slot, active);
alter table private.sponsors enable row level security;
revoke all on private.sponsors from anon, authenticated;

-- ------------------------------------------------------------
-- 2. 스폰서별 집계 (광고주 보고용 — 개인 없음)
-- ------------------------------------------------------------
create table private.sponsor_stats (
  sponsor_id  bigint not null references private.sponsors (id) on delete cascade,
  stat_day    date not null,
  impressions bigint not null default 0 check (impressions >= 0),
  clicks      bigint not null default 0 check (clicks >= 0),
  primary key (sponsor_id, stat_day)
);
alter table private.sponsor_stats enable row level security;
revoke all on private.sponsor_stats from anon, authenticated;

-- ------------------------------------------------------------
-- 3. 서빙 토큰 (위조·중복 차단). token 은 uuid — PII·세그먼트 미포함.
-- ------------------------------------------------------------
create table private.ad_deliveries (
  token        uuid primary key default gen_random_uuid(),
  sponsor_id   bigint not null references private.sponsors (id) on delete cascade,
  slot         text not null,
  member_id    uuid not null,          -- 상한 스코프용(토큰 값엔 안 들어감)
  issued_at    timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '5 minutes',
  impressed_at timestamptz,            -- 최초 1회만 기록(원자적)
  clicked_at   timestamptz
);
create index ad_deliveries_expiry on private.ad_deliveries (expires_at);
alter table private.ad_deliveries enable row level security;
revoke all on private.ad_deliveries from anon, authenticated;

-- ------------------------------------------------------------
-- 4. 세그먼트 인원 (맞춤 최소 크기 ≥20 판정, 내부)
-- ------------------------------------------------------------
create or replace function private.segment_size(p_dept text, p_grade smallint)
returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from private.member_academic a
   where a.entry_department is not null
     and a.entry_department = p_dept
     and coalesce(a.current_grade, a.expected_grade) = p_grade;
$$;
revoke execute on function private.segment_size(text, smallint) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 5. 슬롯 스폰서 1개 선택 + delivery token 발급 (본인 컨텍스트)
--    반환은 token + 크리에이티브. 타겟속성·advertiser·sponsor_id 미반환.
-- ------------------------------------------------------------
create or replace function public.get_sponsor_for_slot(p_slot text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ads    boolean := false;
  v_dept   text;
  v_grade  smallint;
  v_target boolean := false;
  v_row    private.sponsors%rowtype;
  v_token  uuid;
  v_win    timestamptz := date_trunc('minute', now());
  v_cnt    int;
begin
  if auth.uid() is null then return null; end if;
  -- DB 활성화 fence — 꺼져 있으면 직접 호출해도 아무것도 서빙하지 않는다.
  if not private.ad_serving_enabled() then return null; end if;

  -- 발급 상한(member×slot×분). 초과면 ad_deliveries insert 없이 null.
  -- (B4: 발급 자체를 반복 호출해 delivery 행을 증폭시키는 것을 차단.)
  insert into private.usage_rate (member_id, window_minute, scope_key, cnt)
  values (auth.uid(), v_win, left('addeliver:' || p_slot, 96), 1)
  on conflict (member_id, window_minute, scope_key)
    do update set cnt = private.usage_rate.cnt + 1
  returning cnt into v_cnt;
  if v_cnt > 30 then return null; end if;

  select true into v_ads from private.member_consents c
   where c.member_id = auth.uid() and c.purpose = 'targeted_ads'
     and c.granted and c.age_confirmed_18plus;

  if coalesce(v_ads, false) then
    select a.entry_department, coalesce(a.current_grade, a.expected_grade)
      into v_dept, v_grade
      from private.member_academic a where a.member_id = auth.uid();
    if v_dept is not null and v_grade is not null
       and private.segment_size(v_dept, v_grade) >= 20 then
      v_target := true;
    end if;
  end if;

  select * into v_row from private.sponsors s
   where s.slot = p_slot and s.active
     and (s.target_department is null or (v_target and s.target_department = v_dept))
     and (s.target_grade is null or (v_target and s.target_grade = v_grade))
   order by ((s.target_department is not null) or (s.target_grade is not null)) desc,
            random() / s.weight
   limit 1;
  if not found then return null; end if;

  insert into private.ad_deliveries (sponsor_id, slot, member_id)
  values (v_row.id, v_row.slot, auth.uid())
  returning token into v_token;

  -- token + 크리에이티브만. sponsor_id·타겟속성·advertiser 는 클라이언트에 안 준다.
  return jsonb_build_object(
    'token', v_token, 'slot', v_row.slot,
    'title', v_row.title, 'body', v_row.body, 'link', v_row.link_url);
end $$;
revoke execute on function public.get_sponsor_for_slot(text) from public, anon, authenticated;
grant execute on function public.get_sponsor_for_slot(text) to authenticated;

-- ------------------------------------------------------------
-- 6. 노출·클릭 기록 (service_role) — 클라 sponsor_id 불신, token 에서 복원
--    token 당 각 1회(원자적), 만료·재사용 write 0, member×분 상한, 양쪽 저장소.
-- ------------------------------------------------------------
create or replace function private.svc_ad_event(p_member_id uuid, p_token uuid, p_kind text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_del     private.ad_deliveries%rowtype;
  v_win     timestamptz := date_trunc('minute', now());
  v_cnt     int;
  v_first   boolean;
  v_subject uuid;
  v_dept    text;
  v_grade   smallint;
  v_evt     text;
begin
  if p_kind not in ('impression', 'click') then
    return jsonb_build_object('status', 'bad_kind');
  end if;
  -- DB 활성화 fence
  if not private.ad_serving_enabled() then
    return jsonb_build_object('status', 'disabled');
  end if;

  select * into v_del from private.ad_deliveries where token = p_token;
  if not found or now() > v_del.expires_at then
    return jsonb_build_object('status', 'invalid_token');
  end if;
  -- 호출자(인증 member)와 delivery 소유자가 일치해야 한다(B4: 남의 token 기록 금지).
  if v_del.member_id <> p_member_id then
    return jsonb_build_object('status', 'not_owner');
  end if;
  -- 클릭은 실제 노출(impression) 이후에만 집계한다(B4: 노출 없는 클릭 write 0).
  if p_kind = 'click' and v_del.impressed_at is null then
    return jsonb_build_object('status', 'no_impression');
  end if;

  -- member×분 상한(광고 이벤트). 초과면 양쪽 저장소 write 0.
  insert into private.usage_rate (member_id, window_minute, scope_key, cnt)
  values (v_del.member_id, v_win, 'ad_event', 1)
  on conflict (member_id, window_minute, scope_key)
    do update set cnt = private.usage_rate.cnt + 1
  returning cnt into v_cnt;
  if v_cnt > 120 then return jsonb_build_object('status', 'rate_limited'); end if;

  -- 원자적 최초 1회 판정. 이미 기록됐으면 중복 — 통계 미증가.
  if p_kind = 'impression' then
    update private.ad_deliveries set impressed_at = now()
     where token = p_token and impressed_at is null
     returning true into v_first;
    v_evt := 'sponsor_impression';
  else
    update private.ad_deliveries set clicked_at = now()
     where token = p_token and clicked_at is null
     returning true into v_first;
    v_evt := 'sponsor_click';
  end if;
  if not coalesce(v_first, false) then
    return jsonb_build_object('status', 'duplicate');
  end if;

  -- (a) 비식별 집계(광고주 보고용)
  insert into private.sponsor_stats (sponsor_id, stat_day, impressions, clicks)
  values (v_del.sponsor_id, (now() at time zone 'Asia/Seoul')::date,
          case when p_kind = 'impression' then 1 else 0 end,
          case when p_kind = 'click' then 1 else 0 end)
  on conflict (sponsor_id, stat_day) do update set
     impressions = private.sponsor_stats.impressions + (case when p_kind = 'impression' then 1 else 0 end),
     clicks      = private.sponsor_stats.clicks      + (case when p_kind = 'click' then 1 else 0 end);

  -- (b) 상세통계 동의자면 usage_events 에도(가명 subject+세그먼트). 광고동의 철회 시
  --     analytics_subjects CASCADE 로 함께 파기된다. slot 은 서버가 발급한 값이다.
  select analytics_subject_id into v_subject
    from private.analytics_subjects where member_id = v_del.member_id;
  if v_subject is not null then
    select coalesce(a.current_major, a.entry_department),
           coalesce(a.current_grade, a.expected_grade)
      into v_dept, v_grade
      from private.member_academic a where a.member_id = v_del.member_id;
    insert into private.usage_events
      (analytics_subject_id, event_name, target_key, segment_department, segment_grade)
    values (v_subject, v_evt, v_del.slot, v_dept, v_grade);
  end if;

  return jsonb_build_object('status', 'ok');
end $$;
revoke execute on function private.svc_ad_event(uuid, uuid, text) from public, anon, authenticated;
grant execute on function private.svc_ad_event(uuid, uuid, text) to service_role;

-- 만료 delivery 청소(유지보수 배치).
create or replace function private.svc_prune_ad_deliveries(p_keep_minutes int default 30)
returns int language plpgsql security definer set search_path = '' as $$
declare v_n int; v_keep int := greatest(coalesce(p_keep_minutes, 30), 5);
begin
  delete from private.ad_deliveries
   where expires_at < now() - (v_keep || ' minutes')::interval;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke execute on function private.svc_prune_ad_deliveries(int) from public, anon, authenticated;
grant execute on function private.svc_prune_ad_deliveries(int) to service_role;

-- ------------------------------------------------------------
-- 7. 광고주/운영자 보고 (집계만, k≥10) — operator+, 고정 기간(7/30/90)
-- ------------------------------------------------------------
create or replace function public.sponsor_report(p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_rows jsonb; v_days int := case when p_days in (7,30,90) then p_days else 30 end;
begin
  perform private.actor_role_check('operator');
  perform private.audit_analytics_view('sponsor_report');

  select private.k_suppress((
    select coalesce(jsonb_agg(jsonb_build_object(
             'sponsor_id', sponsor_id, 'advertiser', advertiser,
             'title', title, 'n', impressions, 'clicks', clicks)), '[]'::jsonb)
      from (select s.id sponsor_id, s.advertiser, s.title,
                   coalesce(sum(st.impressions),0)::int impressions,
                   coalesce(sum(st.clicks),0)::int clicks
              from private.sponsors s
              left join private.sponsor_stats st on st.sponsor_id = s.id
               and st.stat_day >= (now() at time zone 'Asia/Seoul')::date - v_days
             group by s.id, s.advertiser, s.title) t), 10)
    into v_rows;

  return jsonb_build_object('days', v_days, 'sponsors', v_rows);
end $$;
revoke execute on function public.sponsor_report(int) from public, anon, authenticated;
grant execute on function public.sponsor_report(int) to authenticated;

commit;
