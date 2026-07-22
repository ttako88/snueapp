-- ============================================================
-- 024_analytics_consent.sql — 학번 파생 저장 + 목적별 동의 (S2)
-- ============================================================
-- ⚠️ pending. GPT 검수(C-20260722-PACKET_S2) 전 prod 에 적용하지 않는다.
--    적용은 한 번에 하나(prod-apply-migration.mjs), 검수 통과 + 소유자 확인 후.
--
-- 무엇을 하나
--   1) private.member_academic — 학번에서 파생한 학과·학년 세그먼트. "학번만 넣으면
--      학년·학과가 나온다"(hakbeonAutofill) + 통계/광고 세그먼트의 저장소.
--   2) private.member_consents — 목적별 동의(상세통계 / 맞춤광고)를 독립 저장.
--   3) private.analytics_subjects — 분석 파이프라인용 **무작위** 가명 식별자.
--      중복가입 HMAC(school_identities)과 절대 공유하지 않는다.
--
-- 검수 MUST 반영 (P-20260722 분석설계 + S1 리뷰)
--   · 학번은 학생 인증 단계에서만 수집(전원 가입 시 X). 이 표들은 그 결과의 저장이다.
--   · 파생값은 **서버가 정규화된 학번에서 독립 재계산한 것만** 저장한다. 클라이언트가
--     보낸 department/track/grade 를 그대로 저장하지 않는다 → 쓰기 경로를 service_role
--     전용 svc_set_member_academic 하나로 좁힌다(사용자·authenticated 쓰기 없음).
--   · 목적별 동의 분리: 상세통계 동의가 맞춤광고 동의로 자동승격되지 않는다(별도 호출).
--   · 맞춤광고 동의는 만 18세 이상 확인이 있어야 true 가 된다.
--   · 식별자 목적 분리: analytics_subject_id 는 gen_random_uuid — HMAC 재사용 금지.
--   · 모든 함수 security definer, search_path='' , 완전수식명, auth.uid() 기반.
--     호출자가 member_id 를 지정할 수 없다(service_role 함수 제외 — 서버 신뢰경계).
--
-- 되돌리기: 이 마이그레이션은 새 표/함수만 추가한다(기존 것 변경 없음). 롤백은
--   024_down 에서 drop (데이터 삭제이므로 N3 — 소유자 승인 전 실행 금지, 별도 파일).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. 학번 파생 세그먼트 (서버가 독립 재계산해 저장)
-- ------------------------------------------------------------
-- entry_year+dept_code 는 세그먼트(같은 값의 학생이 다수)라 개인 식별력이 낮다.
-- 개인번호(학번 뒤 2자리)는 저장하지 않는다. real_name 은 여기 없다(school_identities).
create table private.member_academic (
  member_id        uuid primary key references private.members (id) on delete cascade,
  entry_year       smallint not null check (entry_year between 1980 and 2100),
  dept_code        char(2) check (dept_code ~ '^[0-9]{2}$'),
  entry_department text,                         -- 파생 학과명(모르면 null)
  track            char(1) check (track in ('A','B')),
  dept_status      text not null check (dept_status in
                     ('known','unknown_code','entry_year_outside_table')),
  expected_grade   smallint check (expected_grade between 1 and 4),  -- 파생 제안값 스냅샷
  current_grade    smallint check (current_grade between 1 and 8),   -- 사용자 확정값
  current_major    text,                          -- 사용자 확정(기본=entry_department)
  dept_source      text,                          -- 파생 근거(예: 'hakbeon.js')
  captured_at      timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- 학과를 모르면(파생 실패) known 상태가 아니어야 한다
  check ((dept_status = 'known') = (entry_department is not null))
);
create index member_academic_segment
  on private.member_academic (entry_department, current_grade);

alter table private.member_academic enable row level security;   -- 정책 0 = 전면 거부
revoke all on private.member_academic from anon, authenticated;

-- ------------------------------------------------------------
-- 2. 목적별 동의 (상세통계 / 맞춤광고) — 약관형, 기본 OFF, 독립 토글
-- ------------------------------------------------------------
create table private.member_consents (
  member_id            uuid not null references private.members (id) on delete cascade,
  purpose              text not null check (purpose in ('product_analytics','targeted_ads')),
  granted              boolean not null,
  consent_version      text not null,
  age_confirmed_18plus boolean not null default false,
  granted_at           timestamptz,   -- 마지막으로 true 가 된 시각
  revoked_at           timestamptz,   -- 마지막으로 false 가 된 시각
  updated_at           timestamptz not null default now(),
  primary key (member_id, purpose),
  -- 맞춤광고 동의(true)는 만 18세 이상 확인이 있어야 성립한다 (GPT MUST)
  check (not (purpose = 'targeted_ads' and granted and not age_confirmed_18plus))
);
alter table private.member_consents enable row level security;
revoke all on private.member_consents from anon, authenticated;

-- ------------------------------------------------------------
-- 3. 분석 파이프라인용 무작위 가명 식별자 (HMAC 과 목적·값 분리)
-- ------------------------------------------------------------
-- 상세통계 동의 회원에게만 발급. usage_events 는 이 id 로만 묶인다(회원 uuid·HMAC 아님).
-- ⚠️ S3 의 private.usage_events 는 analytics_subject_id 를 ON DELETE CASCADE 로 참조한다.
--    → 동의 철회 시 이 표의 행을 지우면 그 subject 의 원시 이벤트가 같은 트랜잭션에서
--      함께 파기된다(PIPA §37 즉시 파기). set_my_consent 참조.
create table private.analytics_subjects (
  member_id            uuid primary key references private.members (id) on delete cascade,
  analytics_subject_id uuid not null default gen_random_uuid() unique,
  created_at           timestamptz not null default now()
);
alter table private.analytics_subjects enable row level security;
revoke all on private.analytics_subjects from anon, authenticated;

-- ------------------------------------------------------------
-- 4. 서버 전용 쓰기: 학번 파생 저장 (service_role 만)
--    finalize 라우트가 정규화된 학번에서 hakbeon.js 로 독립 재계산한 값을 넘긴다.
--    사용자·authenticated 는 이 표에 못 쓴다(클라 파생 불신 원칙).
-- ------------------------------------------------------------
create or replace function private.svc_set_member_academic(
  p_member_id uuid, p_entry_year int, p_dept_code text, p_entry_department text,
  p_track text, p_dept_status text, p_expected_grade int)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_member_id is null then raise exception 'member_id required'; end if;
  insert into private.member_academic
    (member_id, entry_year, dept_code, entry_department, track, dept_status,
     expected_grade, current_major, dept_source)
  values
    (p_member_id, p_entry_year, p_dept_code, p_entry_department, p_track, p_dept_status,
     p_expected_grade, p_entry_department, 'hakbeon.js')
  on conflict (member_id) do update set
     entry_year       = excluded.entry_year,
     dept_code        = excluded.dept_code,
     entry_department = excluded.entry_department,
     track            = excluded.track,
     dept_status      = excluded.dept_status,
     expected_grade   = excluded.expected_grade,
     dept_source      = excluded.dept_source,
     updated_at       = now();
  -- current_grade / current_major 는 사용자 확정값이므로 재인증에도 덮지 않는다.
end $$;
revoke execute on function private.svc_set_member_academic(uuid,int,text,text,text,text,int)
  from public, anon, authenticated;
grant execute on function private.svc_set_member_academic(uuid,int,text,text,text,text,int)
  to service_role;

-- ------------------------------------------------------------
-- 5. 내 학번 파생 조회 (본인만)
-- ------------------------------------------------------------
create or replace function public.get_my_academic()
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when a.member_id is null then null else jsonb_build_object(
           'entry_year', a.entry_year,
           'entry_department', a.entry_department,
           'track', a.track,
           'dept_status', a.dept_status,
           'expected_grade', a.expected_grade,
           'current_grade', a.current_grade,
           'current_major', a.current_major) end
    from (select auth.uid() as uid) me
    left join private.member_academic a on a.member_id = me.uid;
$$;
revoke execute on function public.get_my_academic() from public, anon, authenticated;
grant execute on function public.get_my_academic() to authenticated;

-- ------------------------------------------------------------
-- 6. 현재 학년·전공 확정 (본인만) — 파생 제안값을 사용자가 확정/수정
-- ------------------------------------------------------------
create or replace function public.set_my_academic_confirmation(
  p_current_grade int, p_current_major text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from private.member_academic where member_id = auth.uid()) then
    -- 학번 파생이 아직 없다(미인증). 확정할 대상이 없다.
    return jsonb_build_object('status','no_academic');
  end if;
  if p_current_grade is null or p_current_grade < 1 or p_current_grade > 8 then
    return jsonb_build_object('status','bad_grade');
  end if;
  if p_current_major is not null and char_length(p_current_major) > 40 then
    return jsonb_build_object('status','bad_major');
  end if;
  update private.member_academic
     set current_grade = p_current_grade,
         current_major = coalesce(p_current_major, current_major),
         updated_at = now()
   where member_id = auth.uid();
  return jsonb_build_object('status','ok');
end $$;
revoke execute on function public.set_my_academic_confirmation(int, text)
  from public, anon, authenticated;
grant execute on function public.set_my_academic_confirmation(int, text) to authenticated;

-- ------------------------------------------------------------
-- 7. 동의 설정 (본인만) — 목적별 독립. 자동승격 없음. 광고는 18+.
-- ------------------------------------------------------------
create or replace function public.set_my_consent(
  p_purpose text, p_granted boolean, p_version text, p_age_confirmed boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not allowed'; end if;
  if p_purpose not in ('product_analytics','targeted_ads') then
    return jsonb_build_object('status','bad_purpose');
  end if;
  if p_version is null or char_length(p_version) not between 1 and 40 then
    return jsonb_build_object('status','bad_version');
  end if;
  -- 맞춤광고 동의는 18+ 확인 없이는 성립하지 않는다. 상세통계 동의는 광고로 승격 안 됨.
  if p_purpose = 'targeted_ads' and p_granted and not coalesce(p_age_confirmed, false) then
    return jsonb_build_object('status','age_required');
  end if;

  insert into private.member_consents
    (member_id, purpose, granted, consent_version, age_confirmed_18plus,
     granted_at, revoked_at, updated_at)
  values
    (auth.uid(), p_purpose, p_granted, p_version,
     (p_purpose = 'targeted_ads' and coalesce(p_age_confirmed,false)),
     case when p_granted then now() end,
     case when not p_granted then now() end,
     now())
  on conflict (member_id, purpose) do update set
     granted              = excluded.granted,
     consent_version      = excluded.consent_version,
     age_confirmed_18plus = (private.member_consents.age_confirmed_18plus
                             or excluded.age_confirmed_18plus),
     granted_at           = case when excluded.granted then now()
                                 else private.member_consents.granted_at end,
     revoked_at           = case when not excluded.granted then now()
                                 else private.member_consents.revoked_at end,
     updated_at           = now();

  -- 상세통계 동의/철회를 식별자 발급/즉시 파기와 원자적으로 묶는다 (GPT S2 BLOCKER,
  -- PIPA §37 — 철회 시 지체 없이 파기). 동의=무작위 가명 id 발급(HMAC 재사용 없음).
  -- 철회=매핑 삭제 → S3 usage_events 의 ON DELETE CASCADE 로 그 subject 의 원시 이벤트가
  -- 같은 트랜잭션에서 함께 삭제된다. 삭제가 실패하면 트랜잭션이 롤백되어 'ok' 를 응답하지
  -- 않는다. 재식별 불가능한 집계(usage_counters)만 남는다.
  if p_purpose = 'product_analytics' then
    if p_granted then
      insert into private.analytics_subjects (member_id)
      values (auth.uid()) on conflict (member_id) do nothing;
    else
      delete from private.analytics_subjects where member_id = auth.uid();
    end if;
  end if;

  return jsonb_build_object('status','ok','purpose',p_purpose,'granted',p_granted);
end $$;
revoke execute on function public.set_my_consent(text, boolean, text, boolean)
  from public, anon, authenticated;
grant execute on function public.set_my_consent(text, boolean, text, boolean) to authenticated;

-- ------------------------------------------------------------
-- 8. 내 동의 상태 조회 (본인만)
-- ------------------------------------------------------------
create or replace function public.get_my_consents()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(c.purpose, jsonb_build_object(
           'granted', c.granted,
           'version', c.consent_version,
           'age_confirmed_18plus', c.age_confirmed_18plus,
           'updated_at', c.updated_at)), '{}'::jsonb)
    from private.member_consents c
   where c.member_id = auth.uid();
$$;
revoke execute on function public.get_my_consents() from public, anon, authenticated;
grant execute on function public.get_my_consents() to authenticated;

commit;
