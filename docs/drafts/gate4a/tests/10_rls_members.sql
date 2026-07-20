-- 그룹 M(members 격리) + R(콘텐츠 RLS) — 사용자 컨텍스트별 authenticated/anon
begin;
set local role authenticated;

-- verified member A (a1)
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
do $$
declare v int; v_txt text;
begin
  -- T-M-01: private.members 직접 접근 불가
  begin execute 'select count(*) from private.members' into v;
    perform authz._log('T-M-01','M',false,'LEAK members='||v);
  exception when others then perform authz._log('T-M-01','M',true,'denied'); end;
  -- T-M-06: get_my_member 본인 1행
  select count(*) into v from public.get_my_member();
  perform authz._log('T-M-06','M', v=1, 'rows='||v);
  -- T-R-01a: verified는 free 글 조회 가능
  select count(*) into v from public.posts where title like 'FXP%';
  perform authz._log('T-R-verified-see','R', v=3, 'posts='||v);
  -- T-R-06: hard delete 불가 (delete 권한/정책 없음)
  begin execute 'delete from public.posts where title=''FXP1''';
    perform authz._log('T-R-06','R',false,'DELETE succeeded!');
  exception when others then perform authz._log('T-R-06','R',true,'denied'); end;
  -- T-R-05a: 타인(a2) 글 update 불가 (0행 영향)
  update public.posts set body='해킹' where title='FXP2';
  get diagnostics v = row_count;
  perform authz._log('T-R-05a','R', v=0, 'rows_updated='||v);
  -- T-R-05b: 본인 글 update 성공
  update public.posts set body='정상수정' where title='FXP1';
  get diagnostics v = row_count;
  perform authz._log('T-R-05b','R', v=1, 'rows_updated='||v);
  -- T-M-nick-dup: 중복 닉네임 거부
  begin execute 'select public.change_nickname(''정회원비'')';
    perform authz._log('T-M-nick-dup','M',false,'dup allowed!');
  exception when others then perform authz._log('T-M-nick-dup','M',true,'rejected'); end;
end $$;

-- pending member (b1)
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}',true);
do $$ declare v int; begin
  select count(*) into v from public.posts where title like 'FXP%';
  perform authz._log('T-R-01-pending','R', v=0, 'posts='||v);
end $$;

-- community_suspended (c2)
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000c2","role":"authenticated"}',true);
do $$ declare v int; begin
  select count(*) into v from public.posts where title like 'FXP%';
  perform authz._log('T-R-02-suspended','R', v=0, 'posts='||v);
end $$;

-- banned (c3)
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}',true);
do $$ declare v int; begin
  select count(*) into v from public.posts where title like 'FXP%';
  perform authz._log('T-R-02-banned','R', v=0, 'posts='||v);
end $$;

-- write_restricted (c1): 열람 가능·작성 불가
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}',true);
do $$ declare v int; begin
  select count(*) into v from public.posts where title like 'FXP%';
  perform authz._log('T-R-02-wr-see','R', v=3, 'posts='||v);
  begin
    insert into public.posts(board_id,title,body,is_anonymous) values ((select id from public.boards where slug='free'),'WRFAIL','x',false);
    perform authz._log('T-R-02-wr-write','R',false,'write allowed!');
  exception when others then perform authz._log('T-R-02-wr-write','R',true,'denied'); end;
end $$;

reset role;

-- anon (비회원)
set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
do $$ declare v int; v_prev int; begin
  -- anon은 posts 직접 조회 불가 (table grant 없음 → permission denied 예외)
  begin
    select count(*) into v from public.posts;
    perform authz._log('T-R-anon-posts','R', v=0, 'posts='||v);
  exception when others then perform authz._log('T-R-anon-posts','R', true, 'denied-tablepriv'); end;
  -- boards: preview만 보임 (anon 정책)
  select count(*) into v from public.boards;
  select count(*) into v_prev from public.boards where access='preview';
  perform authz._log('T-P-anon-boards','P', v=v_prev, 'visible='||v||' preview='||v_prev);
end $$;

reset role;
commit;

select grp, name, pass, actual from private._test_results order by grp, name;
