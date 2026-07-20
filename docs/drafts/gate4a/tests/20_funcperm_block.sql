-- 그룹 F(함수 권한 격리) + A(차단)
begin;

-- 메타 검증 (postgres role): 앱 소유 함수 PUBLIC execute 잔존 0, definer search_path 정확 잠금 전수.
-- allowlist는 접두사 패턴이 아니라 "정확한 스키마+함수명"으로 지정(GPT 검수 B): 미래에 같은
--   접두사를 가진 위험 함수가 검사를 빠져나가지 못하게 함.
--   · private._assert/_assert_raises/_assert_ok = 테스트 전용 헬퍼(오버로드 없음, production 마이그레이션
--     산출물에 미포함. private 스키마는 PostgREST 미노출·anon/authenticated USAGE 없음).
--   · public.rls_auto_enable = Supabase 관리 RLS 자동활성 트리거(무인자, search_path=pg_catalog 정확 허용).
-- search_path 판정: 빈 경로는 PG가 proconfig에 정확히 search_path="" 로 저장. 앱 definer는 이 값과
--   정확 일치해야 PASS(단순히 "설정 존재"가 아님 — search_path=public 같은 위험값 차단).
do $$ declare v int; begin
  select count(*) into v from information_schema.role_routine_grants g
    where g.grantee='PUBLIC' and g.specific_schema in ('public','private','authz')
      and not (
        (g.specific_schema='private' and g.routine_name in ('_assert','_assert_raises','_assert_ok'))
        or (g.specific_schema='public' and g.routine_name='rls_auto_enable')
      );
  perform authz._log('T-F-04-pubexec','F', v=0, 'public_exec='||v);
  select count(*) into v from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private','authz') and p.prosecdef
      and not (
        p.proconfig @> array['search_path=""']
        or (n.nspname='public' and p.proname='rls_auto_enable'
            and pg_get_function_identity_arguments(p.oid)=''
            and p.proconfig @> array['search_path=pg_catalog'])
      );
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
