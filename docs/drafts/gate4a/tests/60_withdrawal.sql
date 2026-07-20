-- 그룹 W(탈퇴 콘텐츠 §13) — prepare_account_deletion + detach_member_content DB 부분
begin;
-- 재실행 정리
delete from public.posts where title in ('FXPW1','FXPW2');
update private.members set verification_status='verified', sanction='none' where id='00000000-0000-0000-0000-0000000000a3';

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}',true);
insert into public.posts(board_id,title,body,is_anonymous) values ((select id from public.boards where slug='free'),'FXPW1','유지될글',false);
insert into public.posts(board_id,title,body,is_anonymous) values ((select id from public.boards where slug='free'),'FXPW2','삭제할글',false);
-- FXPW2 본인 삭제 (soft_delete_post RPC — 007)
select public.soft_delete_post((select id from public.posts where title='FXPW2'));
reset role;

-- 계정 삭제 DB 부분 (소유자 postgres로 트랙 B 호출)
select private.prepare_account_deletion('00000000-0000-0000-0000-0000000000a3');
select private.detach_member_content('00000000-0000-0000-0000-0000000000a3');

do $$ declare v_nick text; v_wd timestamptz; v_owner int; v_kept int; v_del timestamptz; v_mstatus text; begin
  -- T-W-01: 비삭제 글 내용 유지
  select count(*) into v_kept from public.posts where title='FXPW1' and body='유지될글';
  perform authz._log('T-W-01-content-kept','W', v_kept=1, 'FXPW1_kept='||v_kept);
  -- T-W-02/03: author_nickname null + author_withdrawn_at 설정 (표시 대체)
  select author_nickname, author_withdrawn_at into v_nick, v_wd from public.posts where title='FXPW1';
  perform authz._log('T-W-02-display','W', v_nick is null and v_wd is not null, 'nick='||coalesce(v_nick,'NULL')||' withdrawn='||(v_wd is not null)::text);
  -- T-W-04: owners 연결 제거
  select count(*) into v_owner from public.post_owners o where o.user_id='00000000-0000-0000-0000-0000000000a3';
  perform authz._log('T-W-04-owner-removed','W', v_owner=0, 'a3_owners='||v_owner);
  -- T-W-05: 본인 삭제글은 부활 안 함 (deleted_at 유지)
  select deleted_at into v_del from public.posts where title='FXPW2';
  perform authz._log('T-W-05-deleted-stays','W', v_del is not null, 'FXPW2_deleted='||(v_del is not null)::text);
  -- T-W-08: member deleting 전이
  select verification_status into v_mstatus from private.members where id='00000000-0000-0000-0000-0000000000a3';
  perform authz._log('T-W-08-deleting','W', v_mstatus='deleting', 'a3_status='||v_mstatus);
end $$;

-- T-W-07: 탈퇴자 글이 미리보기에서 '탈퇴한 사용자'로 표시
do $$ declare r record; begin
  select * into r from public.claim_guest_read(repeat('9',64), null, (select id from public.posts where title='FXPW1'), 200);
  perform authz._log('T-W-07-preview-label','W', r.allowed and r.author_display='탈퇴한 사용자', 'display='||coalesce(r.author_display,'null'));
end $$;

commit;

select 'W total='||count(*)||' pass='||count(*) filter(where pass)||' FAIL='||count(*) filter(where not pass)
  ||' fails=['||coalesce(string_agg(name||'('||actual||')',', ') filter(where not pass),'none')||']' as summary
from private._test_results where grp='W';
