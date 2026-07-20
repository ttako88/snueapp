-- ============================================================
-- 80_009_behavior.sql — 009 server-job RPC 행동 테스트 (dev, 합성 fixture, 재실행 가능)
-- ============================================================
-- 방식: 하나의 트랜잭션에서 fixture 생성 → RPC 호출 → assertion(실패 시 raise) → 마지막 ROLLBACK.
--   ROLLBACK이라 dev 상태를 바꾸지 않는다(모든 fixture·호출 효과 폐기). 실제 Storage/Auth 미접촉.
--   mock 76개가 못 잡는 실제 PostgreSQL 조건절·시간 계산·잠금을 실측(GPT 요구).
--   001~008·009 본문은 수정하지 않음. auth.users insert는 트리거로 members 자동 생성.
-- ============================================================
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ── 합성 fixture 계정 (0f00… 대역, 실제 사용자와 무관) ──
insert into auth.users (id, email) values
  ('0f000000-0000-0000-0000-000000000001','b-mp@dev.test'),
  ('0f000000-0000-0000-0000-00000000000a','b-ma@dev.test'),
  ('0f000000-0000-0000-0000-00000000000b','b-mb@dev.test'),
  ('0f000000-0000-0000-0000-00000000000c','b-mc@dev.test'),
  ('0f000000-0000-0000-0000-000000000201','b-m201@dev.test'),
  ('0f000000-0000-0000-0000-000000000051','b-ms@dev.test'),
  ('0f000000-0000-0000-0000-000000000052','b-ms2@dev.test'),
  ('0f000000-0000-0000-0000-000000000062','b-mhold@dev.test')
on conflict (id) do nothing;

-- 상태 세팅
update private.members set verification_status='deleting' where id in
  ('0f000000-0000-0000-0000-00000000000a','0f000000-0000-0000-0000-00000000000b',
   '0f000000-0000-0000-0000-000000000201');
update private.members set verification_status='verified', sanction='none' where id='0f000000-0000-0000-0000-00000000000c';
-- Mhold: banned + school_identity → hold 필요
update private.members set sanction='banned', sanction_until=null, verification_status='verified' where id='0f000000-0000-0000-0000-000000000062';
insert into private.school_identities(member_id, real_name, student_no_hmac, hmac_key_version)
  values ('0f000000-0000-0000-0000-000000000062','홍길동', repeat('d',64), 1) on conflict do nothing;

do $B$
declare v int; v_txt text; v_bool boolean; v_ts timestamptz; v_st text; r record; v_id bigint; v_id2 bigint;
begin
  -- ============ 1. 문서 파기 claim/reclaim ============
  insert into private.verification_requests(member_id, doc_type, student_no_hmac, hmac_key_version, storage_path, status, created_at, purge_after)
    values ('0f000000-0000-0000-0000-000000000001','student_card',repeat('a',64),1,'0f000000-0000-0000-0000-000000000001/e','expired_unreviewed', now()-interval '40 days', now()-interval '1 hour')
    returning id into v_id;
  insert into private.verification_requests(member_id, doc_type, student_no_hmac, hmac_key_version, storage_path, status, created_at, purge_after)
    values ('0f000000-0000-0000-0000-000000000001','student_card',repeat('a',64),1,'0f000000-0000-0000-0000-000000000001/f','expired_unreviewed', now(), now()+interval '1 day');  -- future
  insert into private.verification_requests(member_id, doc_type, student_no_hmac, hmac_key_version, storage_path, status, created_at, purge_after)
    values ('0f000000-0000-0000-0000-000000000001','student_card',repeat('a',64),1,'0f000000-0000-0000-0000-000000000001/n','expired_unreviewed', now(), null);  -- null purge_after

  select count(*) into v from public.claim_verification_docs_to_purge(10) where req_id = v_id;
  if v <> 1 then raise exception 'B1 expired should be claimed (got %)', v; end if;
  -- future/null 제외 확인: 방금 claim 전체가 1건뿐이어야
  select count(*) into v from public.claim_verification_docs_to_purge(10);  -- 재호출: 방금 v_id는 purge_started_at recent → 제외
  if v <> 0 then raise exception 'B1 immediate re-claim should exclude recent (got %)', v; end if;
  -- 10분 초과 방치 → reclaim
  update private.verification_requests set purge_started_at = now()-interval '11 minutes' where id = v_id;
  select count(*) into v from public.claim_verification_docs_to_purge(10) where req_id = v_id;
  if v <> 1 then raise exception 'B1 stale reclaim should succeed (got %)', v; end if;
  -- mark → nulls + purged_at
  perform public.mark_verification_doc_purged(v_id);
  select (storage_path is null and real_name is null and purged_at is not null) into v_bool from private.verification_requests where id = v_id;
  if not v_bool then raise exception 'B1 mark should null path/name and set purged_at'; end if;
  -- 늦은 failure는 완료 상태 비복원 (purged_at 유지, path null 유지)
  perform public.record_verification_purge_failure(v_id, 'late_err');
  select (storage_path is null and purged_at is not null) into v_bool from private.verification_requests where id = v_id;
  if not v_bool then raise exception 'B1 late failure must not restore completed row'; end if;

  -- ============ 2. 회원 결속 mark ============
  insert into private.verification_requests(member_id, doc_type, student_no_hmac, hmac_key_version, storage_path, status, created_at)
    values ('0f000000-0000-0000-0000-00000000000a','student_card',repeat('a',64),1,'0f000000-0000-0000-0000-00000000000a/x','expired_unreviewed', now()) returning id into v_id;   -- Ma's request
  insert into private.verification_requests(member_id, doc_type, student_no_hmac, hmac_key_version, storage_path, status, created_at)
    values ('0f000000-0000-0000-0000-00000000000c','student_card',repeat('a',64),1,'0f000000-0000-0000-0000-00000000000c/x','expired_unreviewed', now()) returning id into v_id2;  -- Mc(non-deleting)
  -- Ma request + Mb(wrong member) → false, 불변
  if public.mark_member_verification_doc_purged(v_id, '0f000000-0000-0000-0000-00000000000b') <> false then raise exception 'B2 wrong-member should be false'; end if;
  select (storage_path is not null) into v_bool from private.verification_requests where id = v_id;
  if not v_bool then raise exception 'B2 wrong-member must not purge'; end if;
  -- Ma request + Ma → true, purge
  if public.mark_member_verification_doc_purged(v_id, '0f000000-0000-0000-0000-00000000000a') <> true then raise exception 'B2 correct member should be true'; end if;
  select (storage_path is null and purged_at is not null) into v_bool from private.verification_requests where id = v_id;
  if not v_bool then raise exception 'B2 correct member should purge'; end if;
  -- 재처리 멱등 → 여전히 true
  if public.mark_member_verification_doc_purged(v_id, '0f000000-0000-0000-0000-00000000000a') <> true then raise exception 'B2 idempotent re-mark should stay true'; end if;
  -- 비-deleting 회원 request → false
  if public.mark_member_verification_doc_purged(v_id2, '0f000000-0000-0000-0000-00000000000c') <> false then raise exception 'B2 non-deleting member should be false'; end if;

  -- ============ 3. 경로 201개 fail-closed (RPC가 200으로 절단 안 함) ============
  insert into private.verification_requests(member_id, doc_type, student_no_hmac, hmac_key_version, storage_path, status, created_at)
    select '0f000000-0000-0000-0000-000000000201','student_card',repeat('a',64),1,'0f000000-0000-0000-0000-000000000201/f'||g, 'expired_unreviewed', now()
      from generate_series(1,201) g;
  select count(*) into v from public.get_member_verification_paths('0f000000-0000-0000-0000-000000000201');
  if v <> 201 then raise exception 'B3 should return exactly 201 (got %) — RPC must not silently truncate to 200', v; end if;

  -- ============ 4. stale review 3/7/30일 ============
  insert into private.verification_requests(member_id, doc_type, student_no_hmac, hmac_key_version, status, created_at, submitted_at)
    values ('0f000000-0000-0000-0000-000000000051','student_card',repeat('a',64),1,'submitted', now()-interval '5 days', now()-interval '4 days') returning id into v_id;
  -- 운영진 없음(기존 d2/d3를 임시 비적격화) → warned_at 미기록
  update private.members set sanction='banned', sanction_until=null where id in ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000d3') and sanction='none';
  perform public.run_stale_review_notifications(10);
  select owner_warned_3_at from private.verification_requests where id = v_id into v_ts;
  if v_ts is not null then raise exception 'B4 no recipients → owner_warned_3_at must stay null'; end if;
  -- 운영진 복구 → 메시지 + warned_at 기록
  update private.members set sanction='none', sanction_until=null where id in ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000d3');
  perform public.run_stale_review_notifications(10);
  select owner_warned_3_at from private.verification_requests where id = v_id into v_ts;
  if v_ts is null then raise exception 'B4 with recipients → owner_warned_3_at should be set'; end if;
  select count(*) into v from public.operational_messages where member_id in ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000d3') and title like '%3일%';
  if v < 1 then raise exception 'B4 operator/owner message should be created'; end if;
  -- 재호출 중복 없음
  perform public.run_stale_review_notifications(10);
  select count(*) into v from public.operational_messages where member_id='00000000-0000-0000-0000-0000000000d2' and title like '%3일%';
  if v <> 1 then raise exception 'B4 duplicate 3-day message (got %)', v; end if;

  -- 30일: 전이·pending·deadline·purge_after=now
  insert into private.verification_requests(member_id, doc_type, student_no_hmac, hmac_key_version, status, created_at, submitted_at)
    values ('0f000000-0000-0000-0000-000000000052','student_card',repeat('a',64),1,'submitted', now()-interval '35 days', now()-interval '31 days') returning id into v_id2;
  perform public.expire_unreviewed_submissions(10);
  select status, purge_after into v_st, v_ts from private.verification_requests where id = v_id2;
  if v_st <> 'expired_unreviewed' then raise exception 'B4 30day → expired_unreviewed (got %)', v_st; end if;
  if v_ts is null or v_ts > now() + interval '1 minute' then raise exception 'B4 purge_after should be ~now (immediate)'; end if;
  select verification_status into v_st from private.members where id='0f000000-0000-0000-0000-000000000052';
  if v_st <> 'pending' then raise exception 'B4 member should return to pending (got %)', v_st; end if;
  -- <30일(Ms, 4일)은 전이 안 됨
  select status into v_st from private.verification_requests where id = v_id;
  if v_st <> 'submitted' then raise exception 'B4 <30day must not expire (got %)', v_st; end if;

  -- ============ 5. convergence ============
  if public.account_deletion_converged('0f000000-0000-0000-0000-000000000001') <> false then raise exception 'B5 existing member → false'; end if;
  if public.account_deletion_converged('99999999-9999-9999-9999-999999999999') <> true then raise exception 'B5 absent → true'; end if;

  -- ============ 6. prepare_account_deletion 멱등성 + hold 미확정 거부 ============
  -- Mhold: banned+school_identity, hold_retention_days=null → prepare 거부, deleting 미전이
  begin
    perform private.prepare_account_deletion('0f000000-0000-0000-0000-000000000062');
    raise exception 'B6 hold-needed with retention null should be rejected';
  exception when others then
    if sqlerrm not like '%hold retention not configured%' then raise exception 'B6 wrong error: %', sqlerrm; end if;
  end;
  select verification_status into v_st from private.members where id='0f000000-0000-0000-0000-000000000062';
  if v_st = 'deleting' then raise exception 'B6 rejected prepare must not leave deleting'; end if;

  raise notice '80_009_behavior: ALL BEHAVIOR TESTS PASSED';
end $B$;

rollback;  -- dev 상태 원복 (모든 fixture·효과 폐기)
