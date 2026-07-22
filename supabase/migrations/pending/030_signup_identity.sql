-- ============================================================
-- 030_signup_identity.sql — 회원가입 재설계: 아이디(username)·학번(1인1계정)·동의
-- ============================================================
-- ⚠️ pending/. GPT/소유자 검토 + 운영 적용 전 미배포. 추가형·가역.
--
-- 소유자 지시(2026-07-23): 통상적 회원가입(아이디/이메일/비번) + 학번(재학생확인·
--   1인1계정 중복방지, 필수 수집동의) + 닉네임(중복방지). 파급 DB 설계·적용.
--
-- 재사용: 학번 HMAC=app/lib/server/verification/hmac.mjs(원문 미저장, 키버전 배열).
--         파생저장=svc_set_member_academic(024). 동의=member_consents(024).
--
-- 이 마이그레이션이 추가하는 것:
--   1) private.members.username (unique, 형식 CHECK)
--   2) private.account_identity — 학번 HMAC 로 1인1계정(같은 학번 재가입 차단). 원문 없음.
--   3) member_consents.purpose 에 'account_hakbeon'(학번 수집동의) 추가
--   4) username_available / nickname_available — 가입폼 실시간 중복확인(anon 호출)
--   5) svc_finalize_signup — 가입 라우트(service_role)가 부르는 원자적 확정 함수
-- ============================================================

begin;

-- 1. 아이디(username) ---------------------------------------------------------
alter table private.members
  add column if not exists username text
    check (username is null or username ~ '^[A-Za-z0-9_]{4,20}$');
-- 대소문자 무시 유일성(닉네임과 동일 방식).
create unique index if not exists members_username_ci_unique
  on private.members (lower(username)) where username is not null;

-- 2. 학번 정체성(1인1계정) — 원문 없음, HMAC 만 --------------------------------
create table if not exists private.account_identity (
  member_id     uuid primary key references private.members (id) on delete cascade,
  hakbeon_hmac  text not null,
  key_ver       smallint not null check (key_ver between 1 and 32),
  created_at    timestamptz not null default now(),
  -- 같은 학번(같은 키버전)으로 두 계정 금지 = 1인1계정.
  unique (hakbeon_hmac, key_ver)
);
alter table private.account_identity enable row level security;
revoke all on private.account_identity from anon, authenticated;

-- 3. 동의 목적 확장 -----------------------------------------------------------
alter table private.member_consents drop constraint if exists member_consents_purpose_check;
alter table private.member_consents add constraint member_consents_purpose_check
  check (purpose in ('product_analytics','targeted_ads','account_hakbeon'));

-- 4. 가입폼 실시간 중복확인 (로그인 전이라 anon 도 호출) -----------------------
--    존재 여부(bool)만 반환한다. 아이디·닉네임은 비밀이 아니다(게시판에 공개됨).
--    대량 열거 방지는 라우트/레이트리밋에서.
create or replace function public.username_available(p_username text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_username ~ '^[A-Za-z0-9_]{4,20}$'
     and not exists (select 1 from private.members m where lower(m.username) = lower(p_username));
$$;
revoke execute on function public.username_available(text) from public;
grant  execute on function public.username_available(text) to anon, authenticated;

create or replace function public.nickname_available(p_nick text)
returns boolean language sql stable security definer set search_path = '' as $$
  select char_length(p_nick) between 2 and 16
     and not exists (select 1 from private.members m where lower(m.nickname) = lower(p_nick));
$$;
revoke execute on function public.nickname_available(text) from public;
grant  execute on function public.nickname_available(text) to anon, authenticated;

-- 4b. 학번 중복검사 — 보존 중인 전 키버전으로 대조(1인1계정). service_role 전용.
--     hmac.mjs 가 전 버전 HMAC 배열을 주므로, 어느 버전으로든 일치하면 중복이다.
create or replace function public.svc_hakbeon_exists(p_hmacs text[], p_key_vers smallint[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.account_identity a
      join unnest(p_hmacs, p_key_vers) as t(h, kv) on a.hakbeon_hmac = t.h and a.key_ver = t.kv
  );
$$;
revoke execute on function public.svc_hakbeon_exists(text[], smallint[]) from public, anon, authenticated;
grant  execute on function public.svc_hakbeon_exists(text[], smallint[]) to service_role;

-- 4c. 아이디 → 이메일 (로그인용, service_role 전용). 이메일은 클라에 노출 안 됨.
create or replace function public.svc_email_for_username(p_username text)
returns text language sql stable security definer set search_path = '' as $$
  select u.email from auth.users u
    join private.members m on m.id = u.id
   where lower(m.username) = lower(p_username)
   limit 1;
$$;
revoke execute on function public.svc_email_for_username(text) from public, anon, authenticated;
grant  execute on function public.svc_email_for_username(text) to service_role;

-- 5. 원자적 가입 확정 (service_role 전용) -------------------------------------
--    on_auth_user_created 트리거가 members 행을 이미 만들었다(003). 여기서
--    username·nickname 세팅 + 학번 정체성 + 동의를 **한 트랜잭션**에 확정한다.
--    부분 상태 방지: 먼저 전부 중복검사 → 통과해야 mutation. 경합(race)으로
--    unique 위반이 나면 예외가 전파돼 트랜잭션 전체가 롤백된다(라우트가 정리).
create or replace function public.svc_finalize_signup(
  p_member_id uuid, p_username text, p_nickname text,
  p_hakbeon_hmac text, p_key_ver smallint,
  p_analytics_granted boolean, p_consent_version text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_member_id is null then return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
  if p_username is null or p_username !~ '^[A-Za-z0-9_]{4,20}$' then
    return jsonb_build_object('ok', false, 'reason', 'username_format'); end if;
  if p_nickname is null or char_length(p_nickname) < 2 or char_length(p_nickname) > 16 then
    return jsonb_build_object('ok', false, 'reason', 'nickname_format'); end if;
  if coalesce(p_hakbeon_hmac, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'hakbeon_required'); end if;

  -- 선-중복검사 (mutation 전 — 부분상태 방지)
  if exists (select 1 from private.members m where lower(m.username) = lower(p_username) and m.id <> p_member_id) then
    return jsonb_build_object('ok', false, 'reason', 'username_taken'); end if;
  if exists (select 1 from private.members m where lower(m.nickname) = lower(p_nickname) and m.id <> p_member_id) then
    return jsonb_build_object('ok', false, 'reason', 'nickname_taken'); end if;
  if exists (select 1 from private.account_identity a where a.hakbeon_hmac = p_hakbeon_hmac and a.key_ver = p_key_ver) then
    return jsonb_build_object('ok', false, 'reason', 'hakbeon_taken'); end if;

  -- mutation (경합 시 unique 위반 → 예외 전파 → 전체 롤백)
  update private.members set username = p_username, nickname = p_nickname where id = p_member_id;

  insert into private.account_identity (member_id, hakbeon_hmac, key_ver)
  values (p_member_id, p_hakbeon_hmac, p_key_ver);

  -- 학번 수집동의(필수)
  insert into private.member_consents (member_id, purpose, granted, consent_version, granted_at)
  values (p_member_id, 'account_hakbeon', true, p_consent_version, now())
  on conflict (member_id, purpose) do update
     set granted = true, consent_version = excluded.consent_version, granted_at = now(), updated_at = now();

  -- 이용통계 동의(선택)
  insert into private.member_consents (member_id, purpose, granted, consent_version, granted_at, revoked_at)
  values (p_member_id, 'product_analytics', coalesce(p_analytics_granted, false), p_consent_version,
          case when p_analytics_granted then now() end,
          case when p_analytics_granted then null else now() end)
  on conflict (member_id, purpose) do update
     set granted = excluded.granted, consent_version = excluded.consent_version,
         granted_at = case when excluded.granted then now() else private.member_consents.granted_at end,
         revoked_at = case when excluded.granted then private.member_consents.revoked_at else now() end,
         updated_at = now();

  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.svc_finalize_signup(uuid, text, text, text, smallint, boolean, text)
  from public, anon, authenticated;
grant  execute on function public.svc_finalize_signup(uuid, text, text, text, smallint, boolean, text)
  to service_role;

commit;

-- ============================================================
-- DOWN (참고): drop function svc_finalize_signup(...), nickname_available(text),
--   username_available(text); alter table member_consents ... (purpose 원복);
--   drop table account_identity; drop index members_username_ci_unique;
--   alter table members drop column username;
-- ============================================================
