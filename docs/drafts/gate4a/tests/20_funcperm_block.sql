-- 그룹 F(함수 권한 격리) + A(차단)
begin;

-- 메타 검증 (postgres role): PUBLIC execute 잔존 0, definer search_path 잠금 전수
-- 예외: private._%(테스트 헬퍼, private 스키마 미노출·anon/authenticated USAGE 없음),
--       rls_%(RLS 자동활성 시스템 트리거 — 이벤트트리거로만 호출).
-- search_path 판정: 빈 경로는 PG가 proconfig에 search_path="" 로 저장하므로
--   @> array['search_path='] (따옴표 없는 정확일치)는 오탐. like 'search_path=%'로 잠금 여부만 확인.
do $$ declare v int; begin
  select count(*) into v from information_schema.role_routine_grants
    where grantee='PUBLIC' and specific_schema in ('public','private','authz')
      and routine_name not like 'rls\_%' and routine_name not like '\_%';
  perform authz._log('T-F-04-pubexec','F', v=0, 'public_exec='||v);
  select count(*) into v from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private','authz') and p.prosecdef
      and not exists (select 1 from unnest(coalesce(p.proconfig,array[]::text[])) x
                      where x like 'search_path=%');
  perform authz._log('T-F-05-searchpath','F', v=0, 'bad_searchpath='||v);
end $$;

set local role authenticated;

-- member a1: 관리 함수 전부 거부 + 차단 수행
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
do $$ begin
  begin perform public.moderate_content(1,'hide','사유'); perform authz._log('T-F-02-mod','F',false,'allowed'); exception when others then perform authz._log('T-F-02-mod','F',true,'denied'); end;
  begin perform public.grant_role('00000000-0000-0000-0000-0000000000a2','moderator','x'); perform authz._log('T-F-02-grant','F',false,'allowed'); exception when others then perform authz._log('T-F-02-grant','F',true,'denied'); end;
  begin perform public.admin_reveal_author(1,'post',1,'x'); perform authz._log('T-F-02-reveal','F',false,'allowed'); exception when others then perform authz._log('T-F-02-reveal','F',true,'denied'); end;
  -- a1이 FXP2(a2 소유) 차단
  perform public.block_author('post',(select id from public.posts where title='FXP2'));
end $$;

-- 차단 후 a1 조회: FXP2 제외 (RLS 필터)
do $$ declare v int; begin
  select count(*) into v from public.posts where title like 'FXP%';
  perform authz._log('T-A-08-block-filter','A', v=2, 'posts_after_block='||v);
  select count(*) into v from public.list_my_blocks();
  perform authz._log('T-A-02-list','A', v=1, 'blocks='||v);
  -- 중복 차단: 동일한 조용한 성공
  begin perform public.block_author('post',(select id from public.posts where title='FXP2'));
    perform authz._log('T-A-01-dup','A',true,'silent-ok');
  exception when others then perform authz._log('T-A-01-dup','A',false,'raised'); end;
end $$;

reset role;

-- anon: RPC execute 권한 없음
set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
do $$ begin
  begin perform public.get_my_member(); perform authz._log('T-F-01-anon-rpc','F',false,'allowed'); exception when others then perform authz._log('T-F-01-anon-rpc','F',true,'denied'); end;
end $$;

reset role;
commit;

select 'F+A total='||count(*)||' pass='||count(*) filter(where pass)||' FAIL='||count(*) filter(where not pass)
  ||' fails=['||coalesce(string_agg(name,',') filter(where not pass),'none')||']' as summary
from private._test_results where grp in ('F','A');
