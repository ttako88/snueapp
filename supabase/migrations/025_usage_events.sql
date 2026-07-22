-- ============================================================
-- 025_usage_events.sql — 이용 이벤트 수집 (S3)
-- ============================================================
-- ⚠️ pending. GPT 검수(C-20260722-PACKET_S3) 전 prod 에 적용하지 않는다.
--    선행: 024_analytics_consent.sql (member_academic·analytics_subjects·동의).
--
-- 3 파이프라인 (설계 확정 + GPT S2 BLOCKER 반영)
--   · 미동의  → usage_counters 만 증가(식별자·세그먼트 없음).
--   · 상세통계 동의 → usage_events 원시행(무작위 analytics_subject_id + 세그먼트).
--   · 광고 동의 → 세그먼트는 광고 선택(S6)에만. 행동 이벤트는 광고 선택에 안 쓴다.
--
-- 검수 MUST
--   · registry(allowlist)만 수집한다. 허용 이벤트·허용 target 조합이 아니면 거부.
--     자유문자열·회원ID·URL 식별자·원문검색어를 target 으로 받지 않는다(정규식+등록표).
--   · 원시 이벤트는 analytics_subject_id 로만 묶는다(회원 uuid·HMAC 아님).
--   · **동의 철회 = 즉시 파기(PIPA §37).** usage_events 는 analytics_subjects 를
--     ON DELETE CASCADE 로 참조 → 024 set_my_consent 의 매핑 삭제가 같은 트랜잭션에서
--     원시 이벤트까지 지운다. 90일 잔존 보존 없음. 재식별 불가 집계만 남는다.
--   · 쓰기 함수는 service_role 전용(p_member_id 는 /api/track 이 세션 검증 후 넘김 —
--     begin_verification 과 동일 신뢰경계). auth.uid() 위조 불가.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. 이벤트 allowlist 등록표 (registry)
--    (event_name, target_key) 조합만 수집한다. target_key='' = target 없는 이벤트.
--    새 계측 지점이 생기면 이 표에 행을 추가한다(코드 배포 없이 확장 가능하되,
--    반드시 슬러그 형식이라 자유문자열·PII 가 못 들어온다).
-- ------------------------------------------------------------
create table private.usage_event_registry (
  event_name text not null check (event_name in
    ('screen_view','feature_start','feature_complete','button_click',
     'search_submitted','error','sponsor_impression','sponsor_click')),
  target_key text not null default ''
    check (target_key = '' or target_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  note       text,
  primary key (event_name, target_key)
);
alter table private.usage_event_registry enable row level security;
revoke all on private.usage_event_registry from anon, authenticated;

-- 스타터 seed — 대표 화면·기능·버튼. 자유서술·개인 식별자는 없다.
insert into private.usage_event_registry (event_name, target_key) values
  ('screen_view','home'), ('screen_view','timetable'), ('screen_view','courses'),
  ('screen_view','board'), ('screen_view','lesson_plan'), ('screen_view','meal'),
  ('screen_view','calendar'), ('screen_view','notice'), ('screen_view','settings'),
  ('screen_view','verification'), ('screen_view','my'),
  ('feature_start','timetable_wizard'), ('feature_complete','timetable_wizard'),
  ('feature_start','lesson_plan_generate'), ('feature_complete','lesson_plan_generate'),
  ('feature_start','gpa_calc'), ('feature_complete','gpa_calc'),
  ('feature_start','course_search'), ('feature_complete','course_search'),
  ('button_click','create_post'), ('button_click','vote'), ('button_click','bookmark'),
  ('button_click','report'), ('button_click','share'), ('button_click','ai_generate'),
  ('search_submitted','course'), ('search_submitted','board'),
  ('error',''),
  ('sponsor_impression','slot_home'), ('sponsor_click','slot_home'),
  ('sponsor_impression','slot_board'), ('sponsor_click','slot_board'),
  ('sponsor_impression','slot_meal'), ('sponsor_click','slot_meal');

-- ------------------------------------------------------------
-- 2. 원시 이벤트 (상세통계 동의 파이프라인) — 가명 subject + 세그먼트
--    analytics_subjects 삭제 시 CASCADE 로 함께 파기된다(철회 즉시 파기).
-- ------------------------------------------------------------
create table private.usage_events (
  id                   bigint generated always as identity primary key,
  analytics_subject_id uuid not null
    references private.analytics_subjects (analytics_subject_id) on delete cascade,
  event_name           text not null,
  target_key           text,
  segment_department   text,      -- 이벤트 시점 세그먼트 스냅샷(모르면 null)
  segment_grade        smallint,
  occurred_at          timestamptz not null default now()
);
create index usage_events_subject on private.usage_events (analytics_subject_id);
create index usage_events_rollup  on private.usage_events (event_name, occurred_at);
alter table private.usage_events enable row level security;
revoke all on private.usage_events from anon, authenticated;

-- ------------------------------------------------------------
-- 3. 집계 카운터 (미동의 파이프라인 + 재식별 불가 집계)
--    개인·식별자 없음. 미동의 경로는 세그먼트 없이('' / 0) 총량만.
-- ------------------------------------------------------------
create table private.usage_counters (
  event_name         text not null,
  event_day          date not null,
  segment_department text not null default '',
  segment_grade      smallint not null default 0,
  cnt                bigint not null default 0 check (cnt >= 0),
  primary key (event_name, event_day, segment_department, segment_grade)
);
alter table private.usage_counters enable row level security;
revoke all on private.usage_counters from anon, authenticated;

-- ------------------------------------------------------------
-- 3-b. rate limit 저장소 (GPT S3 BLOCKER — 우회 불가한 원자적 상한)
--    DB 가 공유 저장소이므로 다중 서버 인스턴스에서도 상한이 하나로 강제된다.
--    개인 속성(학번·학과·학년) 없음. 짧게 보존하고 svc_prune_usage_rate 가 지운다.
--    scope_key='' = 회원 전체/분, 'event:target' = 조합/분.
-- ------------------------------------------------------------
create table private.usage_rate (
  member_id     uuid not null,
  window_minute timestamptz not null,
  scope_key     text not null,
  cnt           int not null default 0,
  primary key (member_id, window_minute, scope_key)
);
create index usage_rate_window on private.usage_rate (window_minute);
alter table private.usage_rate enable row level security;
revoke all on private.usage_rate from anon, authenticated;

-- ------------------------------------------------------------
-- 4. 수집 함수 (service_role 전용)
--    /api/track 이 세션을 검증하고 p_member_id 를 넘긴다. 세그먼트는 서버가
--    member_academic 에서 읽는다 — 클라이언트가 세그먼트를 못 지정한다.
--    rate limit(전체 120/분, 조합 20/분)을 먼저 원자적으로 적용한다. 초과 시
--    원시·counter 어느 것도 쓰지 않고 rate_limited 를 반환한다.
-- ------------------------------------------------------------
create or replace function private.svc_track_event(
  p_member_id uuid, p_event text, p_target text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_target  text := coalesce(p_target, '');
  v_subject uuid;
  v_dept    text;
  v_grade   smallint;
  v_win     timestamptz := date_trunc('minute', now());
  v_total   int;
  v_combo   int;
begin
  if p_member_id is null then raise exception 'member_id required'; end if;

  -- 1) allowlist(registry) **먼저**. 미등록 event/target 은 어떤 rate 행도 만들지
  --    않고 거부한다. (GPT S6 최종검수 B1: rate 를 먼저 두면 매번 새 유효형식
  --    target 으로 usage_rate combo 행을 무한 증식시킬 수 있다. registry 를 앞에
  --    두면 combo 키가 등록된 유한 조합으로만 생긴다.)
  if not exists (
    select 1 from private.usage_event_registry r
     where r.event_name = p_event and r.target_key = v_target
  ) then
    return jsonb_build_object('status', 'not_allowed');
  end if;

  -- 2) 고정 전체키(member×분) 원자 증가. 초과면 combo write 없이 즉시 반환.
  insert into private.usage_rate (member_id, window_minute, scope_key, cnt)
  values (p_member_id, v_win, '', 1)
  on conflict (member_id, window_minute, scope_key)
    do update set cnt = private.usage_rate.cnt + 1
  returning cnt into v_total;
  if v_total > 120 then return jsonb_build_object('status', 'rate_limited'); end if;

  -- 3) 등록된 조합에 한해서만 combo 키 증가(scope_key 는 서버가 구성·유한).
  insert into private.usage_rate (member_id, window_minute, scope_key, cnt)
  values (p_member_id, v_win, left('e:' || p_event || ':' || v_target, 96), 1)
  on conflict (member_id, window_minute, scope_key)
    do update set cnt = private.usage_rate.cnt + 1
  returning cnt into v_combo;
  if v_combo > 20 then return jsonb_build_object('status', 'rate_limited'); end if;

  select analytics_subject_id into v_subject
    from private.analytics_subjects where member_id = p_member_id;

  if v_subject is not null then
    -- 상세통계 동의: 원시행(가명 subject + 세그먼트 스냅샷)
    select coalesce(a.current_major, a.entry_department),
           coalesce(a.current_grade, a.expected_grade)
      into v_dept, v_grade
      from private.member_academic a where a.member_id = p_member_id;
    insert into private.usage_events
      (analytics_subject_id, event_name, target_key, segment_department, segment_grade)
    values (v_subject, p_event, nullif(v_target, ''), v_dept, v_grade);
  else
    -- 미동의: 세그먼트·식별자 없이 카운터만
    insert into private.usage_counters (event_name, event_day, cnt)
    values (p_event, (now() at time zone 'Asia/Seoul')::date, 1)
    on conflict (event_name, event_day, segment_department, segment_grade)
      do update set cnt = private.usage_counters.cnt + 1;
  end if;

  return jsonb_build_object('status', 'ok');
end $$;
revoke execute on function private.svc_track_event(uuid, text, text)
  from public, anon, authenticated;
grant execute on function private.svc_track_event(uuid, text, text) to service_role;

-- ------------------------------------------------------------
-- 5. rate limit 기록 청소 (유지보수 배치가 주기적으로 호출)
--    지난 창(window)은 더 이상 상한 판정에 안 쓰이므로 지운다. 짧게만 보존.
-- ------------------------------------------------------------
create or replace function private.svc_prune_usage_rate(p_keep_minutes int default 10)
returns int language plpgsql security definer set search_path = '' as $$
declare v_n int; v_keep int := greatest(coalesce(p_keep_minutes, 10), 1);
begin
  delete from private.usage_rate
   where window_minute < now() - (v_keep || ' minutes')::interval;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke execute on function private.svc_prune_usage_rate(int) from public, anon, authenticated;
grant execute on function private.svc_prune_usage_rate(int) to service_role;

commit;
