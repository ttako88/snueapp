-- 그룹 CC(comment_count) — 공개 댓글 수 유지: insert +1 / soft_delete -1(1회) / 재삭제 no-op
--   / moderator hide -1 / restore +1. (40_moderation의 신고→사건→moderate 패턴 재사용)
-- _test_results를 truncate하지 않음 — 기존 61건에 CC 5건을 더해 66/66이 되게 함.
-- CC 전용 격리 회원(e1·e2·e3)을 생성해 다른 테스트의 차단·제재 상태와 완전 분리.
begin;

-- 재실행 정리 (R1-1: FK 안전 순서 — case 하위부터 → case → 콘텐츠). 자기완결·재실행 가능.
delete from private.moderation_actions where case_id in
  (select id from private.moderation_cases where target_type='comment'
     and target_id in (select id from public.comments where body like 'CCC%'));
delete from private.reports where case_id in
  (select id from private.moderation_cases where target_type='comment'
     and target_id in (select id from public.comments where body like 'CCC%'));
delete from private.case_snapshots where case_id in
  (select id from private.moderation_cases where target_type='comment'
     and target_id in (select id from public.comments where body like 'CCC%'));
delete from private.moderation_cases where target_type='comment'
  and target_id in (select id from public.comments where body like 'CCC%');
delete from private.audit_logs where reason in ('cc숨김','cc복구','cc신고');
delete from public.comments where body like 'CCC%';
delete from public.posts where title='CCP1';

-- CC 전용 회원 3명 (트리거로 members 생성 → verified/none/member로 설정)
insert into auth.users(id,email,email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000e1','cc-au@dev.test',now()),
  ('00000000-0000-0000-0000-0000000000e2','cc-c1@dev.test',now()),
  ('00000000-0000-0000-0000-0000000000e3','cc-c2@dev.test',now())
on conflict (id) do update set email_confirmed_at=now();
update private.members set nickname='CC글쓴이', verification_status='verified', sanction='none', sanction_until=null, role='member' where id='00000000-0000-0000-0000-0000000000e1';
update private.members set nickname='CC댓글일', verification_status='verified', sanction='none', sanction_until=null, role='member' where id='00000000-0000-0000-0000-0000000000e2';
update private.members set nickname='CC댓글이', verification_status='verified', sanction='none', sanction_until=null, role='member' where id='00000000-0000-0000-0000-0000000000e3';
-- moderator(d1) 깨끗이 재설정 (dirty 상태 대비)
update private.members set verification_status='verified', sanction='none', sanction_until=null, role='moderator' where id='00000000-0000-0000-0000-0000000000d1';

set local role authenticated;
-- e1: 글 CCP1
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}',true);
insert into public.posts(board_id,title,body,is_anonymous)
  values ((select id from public.boards where slug='free'),'CCP1','cc본문',false);
-- e2: 댓글 CCC1
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated"}',true);
insert into public.comments(post_id,body,is_anonymous)
  values ((select id from public.posts where title='CCP1'),'CCC1',false);
-- e3: 댓글 CCC2
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000e3","role":"authenticated"}',true);
insert into public.comments(post_id,body,is_anonymous)
  values ((select id from public.posts where title='CCP1'),'CCC2',false);
reset role;

-- CC-1: 초기 공개 댓글 수 = 2
select private._assert('T-CC-01-initial','CC','count=2',
  (select comment_count=2 from public.posts where title='CCP1'),
  (select 'cc='||comment_count from public.posts where title='CCP1'));

-- CC-2: 작성자(e2) soft_delete_comment(CCC1) → 1회 감소
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated"}',true);
select public.soft_delete_comment((select id from public.comments where body='CCC1'));
reset role;
select private._assert('T-CC-02-softdel-dec','CC','count=1',
  (select comment_count=1 from public.posts where title='CCP1'),
  (select 'cc='||comment_count from public.posts where title='CCP1'));

-- CC-3: 재삭제 no-op → 예외 없이 정상 반환(계약: 이미 삭제된 건 조용히 no-op) + count 불변
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated"}',true);
select public.soft_delete_comment((select id from public.comments where body='CCC1'));  -- 예외 삼키지 않음(R1-2)
reset role;
select private._assert('T-CC-03-redelete-noop','CC','count=1',
  (select comment_count=1 from public.posts where title='CCP1'),
  (select 'cc='||comment_count from public.posts where title='CCP1'));

-- CC-4: 신고(e1)→사건→moderator(d1) hide(CCC2) → 0
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}',true);
select public.submit_report('comment',(select id from public.comments where body='CCC2'),'spam','cc신고');
reset role;
select set_config('test.cc_case',
  (select id::text from private.moderation_cases where target_type='comment'
     and target_id=(select id from public.comments where body='CCC2') and status='open'),false);
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}',true);
select public.moderate_content(current_setting('test.cc_case')::bigint,'hide','cc숨김');
reset role;
select private._assert('T-CC-04-modhide-dec','CC','count=0',
  (select comment_count=0 from public.posts where title='CCP1'),
  (select 'cc='||comment_count from public.posts where title='CCP1'));

-- CC-5: moderator(d1) restore → 1
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}',true);
select public.moderate_content(current_setting('test.cc_case')::bigint,'restore','cc복구');
reset role;
select private._assert('T-CC-05-modrestore-inc','CC','count=1',
  (select comment_count=1 from public.posts where title='CCP1'),
  (select 'cc='||comment_count from public.posts where title='CCP1'));

select 'CC '||count(*)||' pass='||count(*) filter (where pass)||' FAIL='||count(*) filter (where not pass)
       ||' fails=['||coalesce(string_agg(name,', ') filter (where not pass),'none')||']' as cc_summary
from private._test_results where grp='CC';

commit;
