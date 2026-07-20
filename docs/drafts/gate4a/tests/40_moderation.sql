-- 그룹 D(모더레이션 흐름) — 신고→사건→조치. case_id는 custom GUC로 role 간 전달.
begin;

-- 재실행 정리
delete from private.moderation_actions where case_id in (select id from private.moderation_cases);
delete from private.reports where case_id in (select id from private.moderation_cases);
delete from private.audit_logs where true;
delete from private.moderation_cases where true;
delete from public.posts where title='FXPD1';
update private.members set sanction='none', sanction_until=null where id='00000000-0000-0000-0000-0000000000a2';
update public.posts set hidden_at=null where title in ('FXP2','FXPD1');

set local role authenticated;
-- d1(moderator) 글 FXPD1
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}',true);
insert into public.posts(board_id,title,body,is_anonymous) values ((select id from public.boards where slug='free'),'FXPD1','모더글',false);
-- a3 신고: FXP2(a2), FXPD1(d1)
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}',true);
select public.submit_report('post',(select id from public.posts where title='FXP2'),'spam','스팸신고');
select public.submit_report('post',(select id from public.posts where title='FXPD1'),'abuse','욕설신고');
reset role;

-- case id들을 세션 GUC에 저장 (postgres 조회)
select set_config('test.case_fxp2',(select id::text from private.moderation_cases where target_type='post' and target_id=(select id from public.posts where title='FXP2') and status='open'),false);
select set_config('test.case_fxpd1',(select id::text from private.moderation_cases where target_type='post' and target_id=(select id from public.posts where title='FXPD1') and status='open'),false);
select set_config('test.fxp2_id',(select id::text from public.posts where title='FXP2'),false);

-- moderator d1 조치
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}',true);
do $$ declare v_case bigint; v jsonb; begin
  v_case := current_setting('test.case_fxp2')::bigint;
  -- T-D-05: get_case reports에 신고자 정보 미노출
  select reports into v from public.get_case(v_case);
  perform authz._log('T-D-05-reporter-hidden','D', not (v::text like '%reporter%'), 'reports='||left(v::text,50));
  -- T-D-07a: member 대상 hide OK
  begin perform public.moderate_content(v_case,'hide','스팸숨김'); perform authz._log('T-D-07a-mod-member','D',true,'hid'); exception when others then perform authz._log('T-D-07a-mod-member','D',false,'FAIL:'||left(sqlerrm,30)); end;
  -- T-D-03: self-target(FXPD1=d1 소유) 거부
  begin perform public.moderate_content(current_setting('test.case_fxpd1')::bigint,'hide','x'); perform authz._log('T-D-03-self','D',false,'self allowed'); exception when others then perform authz._log('T-D-03-self','D',true,'blocked'); end;
  -- T-D-08a: moderator는 apply_sanction 권한 없음
  begin perform public.apply_sanction(v_case,'suspend_7d','x'); perform authz._log('T-D-08a-mod-sanction','D',false,'allowed'); exception when others then perform authz._log('T-D-08a-mod-sanction','D',true,'blocked'); end;
end $$;

-- operator d2 조치
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d2","role":"authenticated"}',true);
do $$ declare v_case bigint; v_ms text; begin
  v_case := current_setting('test.case_fxp2')::bigint;
  -- T-D-08b: operator apply_sanction suspend_7d OK
  begin perform public.apply_sanction(v_case,'suspend_7d','정지사유'); perform authz._log('T-D-08b-op-sanction','D',true,'suspended'); exception when others then perform authz._log('T-D-08b-op-sanction','D',false,'FAIL:'||left(sqlerrm,30)); end;
  -- T-D-04: admin_reveal_author 올바른 case → 성공(audit 기록)
  begin perform public.admin_reveal_author(v_case,'post',current_setting('test.fxp2_id')::bigint,'조사사유'); perform authz._log('T-D-04-reveal','D',true,'revealed'); exception when others then perform authz._log('T-D-04-reveal','D',false,'FAIL:'||left(sqlerrm,30)); end;
  -- T-D-04b: mismatch case → 거부
  begin perform public.admin_reveal_author(v_case,'comment',999999,'x'); perform authz._log('T-D-04b-mismatch','D',false,'allowed'); exception when others then perform authz._log('T-D-04b-mismatch','D',true,'blocked'); end;
end $$;

reset role;
commit;

-- T-D-01: a2 sanction이 실제 community_suspended로 반영됐는지 + audit 남았는지 (postgres 확인)
do $$ declare v_ms text; v_au int; begin
  select sanction into v_ms from private.members where id='00000000-0000-0000-0000-0000000000a2';
  select count(*) into v_au from private.audit_logs where action like 'reveal_author%';
  perform authz._log('T-D-01-sanction-applied','D', v_ms='community_suspended', 'a2_sanction='||v_ms);
  perform authz._log('T-D-06-reveal-audit','D', v_au>=1, 'reveal_audit='||v_au);
end $$;

select 'D total='||count(*)||' pass='||count(*) filter(where pass)||' FAIL='||count(*) filter(where not pass)
  ||' fails=['||coalesce(string_agg(name||'('||actual||')',', ') filter(where not pass),'none')||']' as summary
from private._test_results where grp='D';
