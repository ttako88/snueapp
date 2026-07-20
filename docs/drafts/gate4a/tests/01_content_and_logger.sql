-- ============================================================
-- 01_content_and_logger.sql — 결과기록 함수(authz._log) + 콘텐츠 fixture(정상 경로)
-- authz 스키마에 두는 이유: private는 authenticated에 usage 미부여 → 호출 불가.
-- authz는 usage 부여됨. _log는 SECURITY DEFINER라 authenticated 컨텍스트에서도 결과 기록.
-- ============================================================

-- 결과기록 함수 (postgres role, 암묵 트랜잭션)
create or replace function authz._log(p_name text, p_grp text, p_cond boolean, p_actual text)
returns void language plpgsql security definer set search_path='' as $$
begin
  insert into private._test_results(name, grp, expected, actual, pass)
  values (p_name, p_grp, '-', p_actual, p_cond)
  on conflict (name) do update set actual=excluded.actual, pass=excluded.pass, ran_at=now();
end $$;
revoke execute on function authz._log(text,text,boolean,text) from public;
grant execute on function authz._log(text,text,boolean,text) to authenticated, anon;

-- 콘텐츠 fixture (authenticated 컨텍스트 정상 경로 = insert 정책도 함께 검증)
begin;
set local role authenticated;

-- member A (a1): free 공개글 FXP1, secret 회원글 FXP3
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
insert into public.posts(board_id,title,body,is_anonymous) values ((select id from public.boards where slug='free'),  'FXP1','본문1',false);
insert into public.posts(board_id,title,body,is_anonymous) values ((select id from public.boards where slug='secret'),'FXP3','본문3',false);

-- member B (a2): free 공개글 FXP2 (차단 테스트 대상)
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}',true);
insert into public.posts(board_id,title,body,is_anonymous) values ((select id from public.boards where slug='free'),'FXP2','본문2',false);

-- member A: FXP1에 댓글 FXC1
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
insert into public.comments(post_id,body,is_anonymous) values ((select id from public.posts where title='FXP1'),'FXC1',false);

commit;

-- 검증: 콘텐츠 개수 + owner 매핑 + author_nickname 트리거
select 'posts='||(select count(*) from public.posts where title like 'FXP%')
     ||' comments='||(select count(*) from public.comments where body='FXC1')
     ||' p1_author='||(select author_nickname from public.posts where title='FXP1')
     ||' p1_owner='||(select (o.user_id='00000000-0000-0000-0000-0000000000a1')::text from public.post_owners o join public.posts p on p.id=o.post_id where p.title='FXP1') as content_verify;
