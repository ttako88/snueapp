-- ============================================================
-- 006_harden_private_exec.sql — private 함수 PUBLIC EXECUTE 심층방어 보강
-- PROMOTED for dev rehearsal (dev 검증 2026-07-20)
-- 배경: 001의 `alter default privileges in schema private revoke execute ... from public`이
--   명시적 revoke를 하지 않은 private 내부 함수(actor_role_check, *_impl, content_author 등)의
--   PUBLIC EXECUTE 기본권한을 제거하지 못했다(dev 실측 T-F-04에서 발견).
--   private 스키마 USAGE 차단이 주 방어선이라 실질 악용은 불가하나, 심층방어 원칙상 잔여 EXECUTE도 제거.
-- ============================================================
begin;

do $$
declare r record;
begin
  for r in select p.proname, pg_get_function_identity_arguments(p.oid) as args
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='private'
  loop
    execute format('revoke execute on function private.%I(%s) from public, anon, authenticated',
                   r.proname, r.args);
  end loop;
end $$;

commit;

-- 사후 검증(운영 적용 시 반드시 실측): 내 함수(테스트 헬퍼 '_' 제외)의 PUBLIC EXECUTE 잔존 0
-- select count(*) from information_schema.role_routine_grants
--   where grantee='PUBLIC' and specific_schema in('public','private','authz')
--     and routine_name not like 'rls_%' and routine_name not like '\_%';  -- 기대값 0
