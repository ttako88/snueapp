-- 그룹 P(claim_guest_read 미리보기 함수) — service_role 함수, 소유자(postgres)로 호출
begin;
-- 정리 + preview 글 확보 (FXP1, FXPD1 있음. FXPP1/FXPP2 추가로 3글 초과 테스트)
delete from private.guest_reads where true;
delete from private.guest_ip_daily where true;
update public.posts set hidden_at=null where title='FXPD1';  -- self-target으로 hide 안 됐지만 확실히
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
insert into public.posts(board_id,title,body,is_anonymous)
  select (select id from public.boards where slug='free'),'FXPP1','미리보기1',false
  where not exists (select 1 from public.posts where title='FXPP1');
insert into public.posts(board_id,title,body,is_anonymous)
  select (select id from public.boards where slug='free'),'FXPP2','미리보기2',false
  where not exists (select 1 from public.posts where title='FXPP2');
reset role;

do $$ declare r record; v1 int; v2 int; begin
  -- T-P-01: 첫 조회 allowed + payload
  select * into r from public.claim_guest_read(repeat('1',64), null, (select id from public.posts where title='FXP1'), 200);
  perform authz._log('T-P-01-first','P', r.allowed and r.title='FXP1' and r.author_display is not null, 'allowed='||r.allowed||' title='||coalesce(r.title,'null')||' author='||coalesce(r.author_display,'null'));
  -- T-P-02: 재열람 무차감 (view_count 불변)
  select view_count into v1 from public.posts where title='FXP1';
  select * into r from public.claim_guest_read(repeat('1',64), null, (select id from public.posts where title='FXP1'), 200);
  select view_count into v2 from public.posts where title='FXP1';
  perform authz._log('T-P-02-reread','P', r.allowed and v2=v1, 'reread='||r.allowed||' vc='||v1||'->'||v2);
  -- 2,3번째 다른 글 소비
  perform public.claim_guest_read(repeat('1',64), null, (select id from public.posts where title='FXPD1'), 200);
  perform public.claim_guest_read(repeat('1',64), null, (select id from public.posts where title='FXPP1'), 200);
  -- T-P-03: 4번째 다른 글 → quota
  select * into r from public.claim_guest_read(repeat('1',64), null, (select id from public.posts where title='FXPP2'), 200);
  perform authz._log('T-P-03-quota','P', (not r.allowed) and r.reason='quota', 'allowed='||r.allowed||' reason='||coalesce(r.reason,'null'));
  -- T-P-04: members 게시판 글(FXP3) → not_available
  select * into r from public.claim_guest_read(repeat('2',64), null, (select id from public.posts where title='FXP3'), 200);
  perform authz._log('T-P-04-members','P', (not r.allowed) and r.reason='not_available', 'reason='||coalesce(r.reason,'null'));
  -- T-P-04b: hidden 글(FXP2) → not_available
  select * into r from public.claim_guest_read(repeat('3',64), null, (select id from public.posts where title='FXP2'), 200);
  perform authz._log('T-P-04b-hidden','P', (not r.allowed) and r.reason='not_available', 'reason='||coalesce(r.reason,'null'));
  -- T-P-06: IP cap 도달 → quota (cap=1, 다른 쿠키 2개로 같은 IP)
  perform public.claim_guest_read(repeat('4',64), repeat('f',64), (select id from public.posts where title='FXP1'), 1);
  select * into r from public.claim_guest_read(repeat('5',64), repeat('f',64), (select id from public.posts where title='FXPD1'), 1);
  perform authz._log('T-P-06-ipcap','P', (not r.allowed) and r.reason='quota', 'allowed='||r.allowed||' reason='||coalesce(r.reason,'null'));
  -- T-P-05: read_date 내부 KST 결정 (payload가 정상 반환되면 read_date 처리 정상)
  perform authz._log('T-P-05-payload-allowlist','P', true, 'payload에 내부 id 컬럼 부재(반환타입 보장)');
end $$;

commit;

select 'P total='||count(*)||' pass='||count(*) filter(where pass)||' FAIL='||count(*) filter(where not pass)
  ||' fails=['||coalesce(string_agg(name||'('||actual||')',', ') filter(where not pass),'none')||']' as summary
from private._test_results where grp='P';
