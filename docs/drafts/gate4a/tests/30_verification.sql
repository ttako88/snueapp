-- 그룹 V(신원 2단계 제출) — 트랙 B 함수는 소유자(postgres) 권한으로 정상동작 검증
-- (격리=authenticated 거부는 F그룹에서 확인). 재실행 가능하도록 b1 리셋 선행.
begin;

-- b1 리셋 (idempotent)
delete from private.verification_requests where member_id='00000000-0000-0000-0000-0000000000b1';
delete from private.enforcement_holds where student_no_hmac in (repeat('c',64));
update private.members set verification_status='pending', verification_deadline=now()+interval '7 days'
  where id='00000000-0000-0000-0000-0000000000b1';

do $$
declare v_req bigint; v_st text; v_ms text;
begin
  -- T-V-begin: uploading 생성, member 불변(pending)
  v_req := public.begin_verification('00000000-0000-0000-0000-0000000000b1',
             array[repeat('a',64)]::text[], array[1]::smallint[], 1::smallint,
             '홍길동','student_card','b1/x1');
  select status into v_st from private.verification_requests where id=v_req;
  select verification_status into v_ms from private.members where id='00000000-0000-0000-0000-0000000000b1';
  perform authz._log('T-V-02-begin','V', v_st='uploading' and v_ms='pending', 'req='||v_st||' member='||v_ms);

  -- T-V-concurrent: uploading 있는 동안 두번째 begin → unique 차단
  begin
    perform public.begin_verification('00000000-0000-0000-0000-0000000000b1',
      array[repeat('b',64)]::text[], array[1]::smallint[], 1::smallint,'홍','student_card','b1/x2');
    perform authz._log('T-V-06-concurrent','V', false, 'second begin allowed!');
  exception when others then perform authz._log('T-V-06-concurrent','V', true, 'blocked'); end;

  -- T-V-finalize: uploading→submitted + member submitted
  perform public.finalize_verification('00000000-0000-0000-0000-0000000000b1', v_req);
  select status into v_st from private.verification_requests where id=v_req;
  select verification_status into v_ms from private.members where id='00000000-0000-0000-0000-0000000000b1';
  perform authz._log('T-V-04-finalize','V', v_st='submitted' and v_ms='submitted', 'req='||v_st||' member='||v_ms);

  -- T-V-badinput: 잘못된 hmac(64 hex 아님) 거부
  update private.members set verification_status='pending' where id='00000000-0000-0000-0000-0000000000b1';
  delete from private.verification_requests where member_id='00000000-0000-0000-0000-0000000000b1';
  begin
    perform public.begin_verification('00000000-0000-0000-0000-0000000000b1',
      array['short']::text[], array[1]::smallint[], 1::smallint,'홍','student_card','b1/x3');
    perform authz._log('T-V-badinput','V', false, 'bad hmac allowed!');
  exception when others then perform authz._log('T-V-badinput','V', true, 'rejected'); end;

  -- T-V-07-hold: enforcement_hold와 매칭되는 학번 → 거부
  insert into private.enforcement_holds(student_no_hmac, hmac_key_version, hold_reason)
    values (repeat('c',64), 1, 'banned');
  begin
    perform public.begin_verification('00000000-0000-0000-0000-0000000000b1',
      array[repeat('c',64)]::text[], array[1]::smallint[], 1::smallint,'홍','student_card','b1/x4');
    perform authz._log('T-V-07-hold','V', false, 'held hmac allowed!');
  exception when others then perform authz._log('T-V-07-hold','V', true, 'blocked-unverifiable'); end;

  -- T-V-01-7fields: get_my_verification_requests 반환 컬럼(TABLE 파라미터) 7개
  select count(*) into v_req from pg_proc p, unnest(p.proargmodes) m
    where p.proname='get_my_verification_requests' and m='t';
  perform authz._log('T-V-01-7fields','V', v_req=7, 'table_cols='||v_req);
end $$;

commit;

select 'V total='||count(*)||' pass='||count(*) filter(where pass)||' FAIL='||count(*) filter(where not pass)
  ||' fails=['||coalesce(string_agg(name||'('||actual||')',', ') filter(where not pass),'none')||']' as summary
from private._test_results where grp='V';
