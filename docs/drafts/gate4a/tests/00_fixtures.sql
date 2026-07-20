-- ============================================================
-- 00_fixtures.sql — dev 테스트 fixture (합성 계정만, 실제 개인정보 없음)
-- dev 전용. 운영 미적용. 테스트 종료 후 99_teardown.sql로 정리.
-- ============================================================
begin;

-- 테스트 결과 기록 테이블 (증거 보존 — GPT 6항)
create table if not exists private._test_results (
  name text primary key, grp text, expected text, actual text,
  pass boolean, ran_at timestamptz default now()
);
truncate private._test_results;

-- assert 헬퍼: 조건이 true면 PASS
create or replace function private._assert(p_name text, p_grp text, p_expected text, p_cond boolean, p_actual text default null)
returns void language plpgsql as $$
begin
  insert into private._test_results(name, grp, expected, actual, pass)
  values (p_name, p_grp, p_expected, coalesce(p_actual, case when p_cond then 'ok' else 'FAIL' end), p_cond)
  on conflict (name) do update set actual = excluded.actual, pass = excluded.pass, ran_at = now();
end $$;

-- 특정 코드 블록이 예외를 던지는지 검사 (권한 거부 등 negative 테스트)
create or replace function private._assert_raises(p_name text, p_grp text, p_sql text)
returns void language plpgsql as $$
begin
  execute p_sql;
  perform private._assert(p_name, p_grp, 'raises', false, 'NO EXCEPTION (leak!)');
exception when others then
  perform private._assert(p_name, p_grp, 'raises', true, 'raised: '||left(sqlerrm,40));
end $$;

-- 특정 코드 블록이 성공하는지 검사 (positive)
create or replace function private._assert_ok(p_name text, p_grp text, p_sql text)
returns void language plpgsql as $$
begin
  execute p_sql;
  perform private._assert(p_name, p_grp, 'succeeds', true, 'ok');
exception when others then
  perform private._assert(p_name, p_grp, 'succeeds', false, 'FAIL: '||left(sqlerrm,40));
end $$;

-- fixture 계정 (고정 uuid). auth.users insert → 트리거로 members 자동 생성
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1','fx-va@dev.test'),   -- verified member A (작성자)
  ('00000000-0000-0000-0000-0000000000a2','fx-vb@dev.test'),   -- verified member B (다른 작성자/차단대상)
  ('00000000-0000-0000-0000-0000000000a3','fx-vc@dev.test'),   -- verified member C (제3자/신고자)
  ('00000000-0000-0000-0000-0000000000b1','fx-pend@dev.test'), -- pending
  ('00000000-0000-0000-0000-0000000000b2','fx-subm@dev.test'), -- submitted
  ('00000000-0000-0000-0000-0000000000c1','fx-wr@dev.test'),   -- verified + write_restricted
  ('00000000-0000-0000-0000-0000000000c2','fx-cs@dev.test'),   -- verified + community_suspended
  ('00000000-0000-0000-0000-0000000000c3','fx-ban@dev.test'),  -- verified + banned
  ('00000000-0000-0000-0000-0000000000d1','fx-mod@dev.test'),  -- moderator
  ('00000000-0000-0000-0000-0000000000d2','fx-op@dev.test'),   -- operator
  ('00000000-0000-0000-0000-0000000000d3','fx-own@dev.test')   -- owner
on conflict (id) do nothing;

-- 상태·닉네임 설정 (postgres role — 테스트 세팅용 직접 update)
update private.members set nickname='정회원에이', verification_status='verified', sanction='none', role='member' where id='00000000-0000-0000-0000-0000000000a1';
update private.members set nickname='정회원비',   verification_status='verified', sanction='none', role='member' where id='00000000-0000-0000-0000-0000000000a2';
update private.members set nickname='정회원씨',   verification_status='verified', sanction='none', role='member' where id='00000000-0000-0000-0000-0000000000a3';
update private.members set nickname='펜딩유저',   verification_status='pending',  sanction='none', role='member' where id='00000000-0000-0000-0000-0000000000b1';
update private.members set nickname='서브밋유저', verification_status='submitted',sanction='none', role='member' where id='00000000-0000-0000-0000-0000000000b2';
update private.members set nickname='제한유저',   verification_status='verified', sanction='write_restricted', sanction_until=now()+interval '1 day', role='member' where id='00000000-0000-0000-0000-0000000000c1';
update private.members set nickname='정지유저',   verification_status='verified', sanction='community_suspended', sanction_until=now()+interval '7 days', role='member' where id='00000000-0000-0000-0000-0000000000c2';
update private.members set nickname='밴유저',     verification_status='verified', sanction='banned', role='member' where id='00000000-0000-0000-0000-0000000000c3';
update private.members set nickname='모더레이터', verification_status='verified', sanction='none', role='moderator' where id='00000000-0000-0000-0000-0000000000d1';
update private.members set nickname='오퍼레이터', verification_status='verified', sanction='none', role='operator' where id='00000000-0000-0000-0000-0000000000d2';
update private.members set nickname='오너계정',   verification_status='verified', sanction='none', role='owner' where id='00000000-0000-0000-0000-0000000000d3';

commit;

-- 확인
select 'fixtures:'||count(*)||' verified:'||count(*) filter (where verification_status='verified') as summary
from private.members where id::text like '00000000-0000-0000-0000-0000000000%';
