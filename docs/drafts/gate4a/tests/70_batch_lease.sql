-- 그룹 G(파기·hold·제재만료 배치 DB 함수) + X(maintenance lease) — 소유자(postgres)로 호출.
-- GPT 검수 A: clean replay 재실행 시 G/X 누락 지적 → DB 함수부만 검증(서버 Route/Cron HTTP는 DEFERRED).
begin;

-- ===== X: maintenance lease (중복 실행 방지) =====
delete from private.maintenance_leases where job_name='xtestjob';
do $$ declare t1 uuid; t2 uuid; t3 uuid; begin
  -- T-X-01: 최초 획득 → 토큰 발급
  t1 := private.acquire_maintenance_lease('xtestjob', 60);
  perform authz._log('T-X-01-acquire','X', t1 is not null, 'token1='||coalesce(t1::text,'null'));
  -- T-X-02: 유효 lease 존재 중 재획득 → null (already_running)
  t2 := private.acquire_maintenance_lease('xtestjob', 60);
  perform authz._log('T-X-02-double-blocked','X', t2 is null, 'token2='||coalesce(t2::text,'null(blocked)'));
  -- T-X-04: 잘못된 토큰 release는 no-op → 여전히 점유 → 재획득 null
  perform private.release_maintenance_lease('xtestjob', gen_random_uuid());
  t2 := private.acquire_maintenance_lease('xtestjob', 60);
  perform authz._log('T-X-04-wrongtoken-noop','X', t2 is null, 'after_wrong_release='||coalesce(t2::text,'null(still held)'));
  -- T-X-03: 올바른 토큰 release → 재획득 성공
  perform private.release_maintenance_lease('xtestjob', t1);
  t3 := private.acquire_maintenance_lease('xtestjob', 60);
  perform authz._log('T-X-03-release-reacquire','X', t3 is not null, 'token3='||coalesce(t3::text,'null'));
end $$;
delete from private.maintenance_leases where job_name='xtestjob';

-- ===== G-01: expire_sanctions (만료 제재 자동 해제) =====
-- c1(제한유저)에 만료된 write_restricted 부여 후 배치 실행 → none 전이 검증
update private.members set sanction='write_restricted', sanction_until=now()-interval '1 hour'
  where id='00000000-0000-0000-0000-0000000000c1';
select private.expire_sanctions(500);
do $$ declare v text; begin
  select sanction into v from private.members where id='00000000-0000-0000-0000-0000000000c1';
  perform authz._log('T-G-01-expire-sanction','G', v='none', 'c1_sanction='||v);
end $$;

-- ===== G-02: purge_expired_holds (만료 hold hard delete, 미만료 보존) =====
delete from private.enforcement_holds where student_no_hmac in (repeat('e',64), repeat('f',64));
insert into private.enforcement_holds(student_no_hmac, hmac_key_version, hold_reason, retention_until)
  values (repeat('e',64), 1, 'banned', now()-interval '1 day');       -- 만료 → 삭제 대상
insert into private.enforcement_holds(student_no_hmac, hmac_key_version, hold_reason, retention_until)
  values (repeat('f',64), 1, 'banned', now()+interval '30 days');     -- 미만료 → 보존
select private.purge_expired_holds();
do $$ declare v_exp int; v_fut int; begin
  select count(*) into v_exp from private.enforcement_holds where student_no_hmac=repeat('e',64);
  select count(*) into v_fut from private.enforcement_holds where student_no_hmac=repeat('f',64);
  perform authz._log('T-G-02-purge-holds','G', v_exp=0 and v_fut=1, 'expired='||v_exp||' future='||v_fut);
end $$;
delete from private.enforcement_holds where student_no_hmac in (repeat('e',64), repeat('f',64));

-- ===== G-03: purge_expired_guest_reads (만료 guest_read 삭제, 미만료 보존) =====
delete from private.guest_reads where cookie_hmac in (repeat('7',64), repeat('8',64));
insert into private.guest_reads(cookie_hmac, post_id, read_date, expires_at)
  values (repeat('7',64), (select id from public.posts where title='FXP1'), current_date, now()-interval '1 hour');  -- 만료
insert into private.guest_reads(cookie_hmac, post_id, read_date, expires_at)
  values (repeat('8',64), (select id from public.posts where title='FXP1'), current_date, now()+interval '1 day');   -- 미만료
select private.purge_expired_guest_reads();
do $$ declare v_exp int; v_fut int; begin
  select count(*) into v_exp from private.guest_reads where cookie_hmac=repeat('7',64);
  select count(*) into v_fut from private.guest_reads where cookie_hmac=repeat('8',64);
  perform authz._log('T-G-03-purge-guest-reads','G', v_exp=0 and v_fut=1, 'expired='||v_exp||' future='||v_fut);
end $$;
delete from private.guest_reads where cookie_hmac in (repeat('7',64), repeat('8',64));

-- ===== G-04: purge_soft_deleted_content (30일 경과+무사건만 hard delete) =====
delete from private.moderation_cases where target_type='post'
  and target_id in (select id from public.posts where title in ('FXG_OLD','FXG_RECENT','FXG_CASE'));
delete from public.posts where title in ('FXG_OLD','FXG_RECENT','FXG_CASE');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
insert into public.posts(board_id,title,body,is_anonymous) values ((select id from public.boards where slug='free'),'FXG_OLD','30일전삭제',false);
insert into public.posts(board_id,title,body,is_anonymous) values ((select id from public.boards where slug='free'),'FXG_RECENT','최근삭제',false);
insert into public.posts(board_id,title,body,is_anonymous) values ((select id from public.boards where slug='free'),'FXG_CASE','30일전삭제+열린사건',false);
reset role;
update public.posts set deleted_at=now()-interval '31 days' where title in ('FXG_OLD','FXG_CASE');
update public.posts set deleted_at=now()-interval '1 day'   where title='FXG_RECENT';
insert into private.moderation_cases(target_type, target_id, status)
  values ('post', (select id from public.posts where title='FXG_CASE'), 'open');
select private.purge_soft_deleted_content(500);
do $$ declare v_old int; v_recent int; v_case int; begin
  select count(*) into v_old    from public.posts where title='FXG_OLD';     -- 삭제됨(0)
  select count(*) into v_recent from public.posts where title='FXG_RECENT';  -- 보존(1, 30일 미경과)
  select count(*) into v_case   from public.posts where title='FXG_CASE';    -- 보존(1, 열린 사건)
  perform authz._log('T-G-04a-purge-old-nocase','G', v_old=0, 'old_kept='||v_old);
  perform authz._log('T-G-04b-purge-recent-kept','G', v_recent=1, 'recent='||v_recent);
  perform authz._log('T-G-04c-purge-opencase-kept','G', v_case=1, 'case_kept='||v_case);
end $$;
-- 정리
delete from private.moderation_cases where target_type='post'
  and target_id in (select id from public.posts where title in ('FXG_RECENT','FXG_CASE'));
delete from public.posts where title in ('FXG_RECENT','FXG_CASE');

commit;

select 'G+X total='||count(*)||' pass='||count(*) filter(where pass)||' FAIL='||count(*) filter(where not pass)
  ||' fails=['||coalesce(string_agg(name||'('||actual||')',', ') filter(where not pass),'none')||']' as summary
from private._test_results where grp in ('G','X');
