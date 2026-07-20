-- ============================================================
-- 009_server_job_rpcs.sql — 서버 잡(maintenance Route) 전용 service_role RPC
-- ============================================================
-- ⚠️ DRAFT · NOT EXECUTED · post-freeze 추가 migration (Batch 0 RPC 경계 대조 + GPT 검수 반영)
--   - 동결본 001~008(SHA 6746127)은 수정하지 않는다. 009는 그 위에 얹는 별도 번호.
--     (prepare_account_deletion만 CREATE OR REPLACE로 멱등 보강 — GPT 판정 Q4: 001~008 수정이
--      아니라 명시적 post-freeze 보강으로 허용.)
--   - 원격(dev/prod)에 적용하지 않는다 — GPT 배치 검수 통과 후 dev 리허설 → 재동결.
--   - 근거: server-jobs/README.md, GATE3_DESIGN v1.3 §4.4·§9·§13, GPT 009 검수 회신.
--
-- 설계 규칙(전 함수 공통):
--   - private 스키마는 PostgREST 미노출. 서버 service_role client는 private을 직접 CRUD하지 않고
--     반드시 이 public 얇은 래퍼(→ private impl)만 호출한다.
--   - 전 함수 SECURITY DEFINER + set search_path='' + 객체 schema-qualified + 동적 SQL 금지.
--   - public wrapper EXECUTE는 service_role에만. private impl EXECUTE는 전부 revoke(래퍼가 definer라
--     소유자 권한으로 호출 — 별도 grant 불필요). = 008 하드닝 원칙 동일.
--   - claim류: lease(1차 중복방지)에 더해 "행 상태 조건"이 최종 멱등 방어선.
--     purge류는 purge_started_at 원자 기록 + stale-gate 재회수, 늦은 failure가 이후 success를
--     덮어쓰지 못하게 조건부 UPDATE(purged_at is null).
--   - path·member UUID를 "서버 모듈로 반환"하는 것은 Storage/Auth 삭제에 필수라 허용된다.
--     금지 범위는 HTTP 응답 / 일반 앱 로그 / batch_runs·audit 평문 target / 클라이언트 반환.
-- ============================================================
begin;

-- claim 재회수 유예: 이전 실행이 Storage 단계에서 죽어 purge_started_at만 남은 건을 이만큼
-- 지난 뒤 다음 실행이 다시 잡는다(단일 실행은 Route maxDuration 60s·lease TTL 120s보다 충분히 김).
-- (상수는 함수 내 인라인 — 설정 테이블 도입 없이 명시)

-- ------------------------------------------------------------
-- 0. 공통: 배치 실행 기록 public 래퍼 + 입력 검증
-- ------------------------------------------------------------
create or replace function public.record_maintenance_run(
  p_job text, p_ok boolean, p_processed int, p_error_code text)
returns void language plpgsql security definer set search_path='' as $$
begin
  -- 조용한 clamp 금지 — 범위 이탈은 배치 통계 오류를 숨기므로 명시적 거부.
  if p_job not in ('purge-verification-docs','delete-accounts','expire-uploads','stale-reviews') then
    raise exception 'unknown job';
  end if;
  if p_processed is null or p_processed < 0 or p_processed > 1000000 then
    raise exception 'processed out of range';
  end if;
  if p_ok then
    if p_error_code is not null then raise exception 'ok run must not carry error_code'; end if;
  else
    -- 실패 기록은 안전한 error_code 필수(공백·개행·경로·UUID·원문오류 차단 형식).
    if p_error_code is null or p_error_code !~ '^[a-z0-9][a-z0-9_:-]{0,39}$' then
      raise exception 'invalid error_code';
    end if;
  end if;
  perform private.record_batch_run(p_job, p_ok, p_processed, p_error_code);
end $$;
revoke execute on function public.record_maintenance_run(text, boolean, int, text) from public, anon, authenticated;
grant  execute on function public.record_maintenance_run(text, boolean, int, text) to service_role;

-- ============================================================
-- A. purge-verification-docs
-- ============================================================

-- A-1. 파기 대상 claim: purge_after 경과 + 미파기 + 경로 존재. 신규(purge_started_at null) 또는
--   10분 이상 방치된 중단분을 잡아 purge_started_at=now(), attempts+1 원자 기록.
create or replace function private.claim_verification_docs_to_purge(p_limit int)
returns table(req_id bigint, storage_path text)
language plpgsql security definer set search_path='' as $$
begin
  return query
  update private.verification_requests r
     set purge_started_at = now(), purge_attempts = r.purge_attempts + 1
   where r.id in (
     select r2.id from private.verification_requests r2
      where r2.purge_after is not null and r2.purge_after <= now()
        and r2.purged_at is null and r2.storage_path is not null
        and (r2.purge_started_at is null or r2.purge_started_at < now() - interval '10 minutes')
      order by r2.purge_after
      limit greatest(p_limit, 0)
      for update skip locked)
  returning r.id, r.storage_path;
end $$;
create or replace function public.claim_verification_docs_to_purge(p_limit int)
returns table(req_id bigint, storage_path text)
language sql security definer set search_path='' as $$
  select * from private.claim_verification_docs_to_purge(p_limit);
$$;
revoke execute on function public.claim_verification_docs_to_purge(int) from public, anon, authenticated;
grant  execute on function public.claim_verification_docs_to_purge(int) to service_role;

-- A-2. Storage 삭제 성공(또는 이미 없음) 확인 후 파기 완료. 이미 purged면 no-op.
create or replace function private.mark_verification_doc_purged(p_req_id bigint)
returns void language plpgsql security definer set search_path='' as $$
begin
  -- purge_started_at도 함께 보장(CHECK: purged_at 설정 시 purge_started_at 필수).
  --   purge job은 claim이 선행 설정하지만, 방어적으로 coalesce로 확정.
  update private.verification_requests
     set storage_path = null, real_name = null,
         purge_started_at = coalesce(purge_started_at, now()),
         purged_at = now(), purge_last_error = null
   where id = p_req_id and purged_at is null;
end $$;
create or replace function public.mark_verification_doc_purged(p_req_id bigint)
returns void language sql security definer set search_path='' as $$
  select private.mark_verification_doc_purged(p_req_id);
$$;
revoke execute on function public.mark_verification_doc_purged(bigint) from public, anon, authenticated;
grant  execute on function public.mark_verification_doc_purged(bigint) to service_role;

-- A-3. 파기 실패 기록(비식별 error_code). purged_at is null 조건 → 늦은 failure가 이후 success를 못 덮음.
create or replace function private.record_verification_purge_failure(p_req_id bigint, p_error_code text)
returns void language plpgsql security definer set search_path='' as $$
begin
  update private.verification_requests
     set purge_last_error = left(coalesce(p_error_code, 'unknown'), 40)
   where id = p_req_id and purged_at is null;
end $$;
create or replace function public.record_verification_purge_failure(p_req_id bigint, p_error_code text)
returns void language sql security definer set search_path='' as $$
  select private.record_verification_purge_failure(p_req_id, p_error_code);
$$;
revoke execute on function public.record_verification_purge_failure(bigint, text) from public, anon, authenticated;
grant  execute on function public.record_verification_purge_failure(bigint, text) to service_role;

-- ============================================================
-- B. expire-uploads (uploading 24h → upload_expired 전이 후 미완 객체 정리)
--    완료/실패는 A-2/A-3 재사용(같은 컬럼).
-- ============================================================
create or replace function private.claim_expired_uploads(p_limit int)
returns table(req_id bigint, storage_path text)
language plpgsql security definer set search_path='' as $$
begin
  update private.verification_requests
     set status = 'upload_expired'
   where status = 'uploading' and created_at < now() - interval '24 hours';
  return query
  update private.verification_requests r
     set purge_started_at = now(), purge_attempts = r.purge_attempts + 1
   where r.id in (
     select r2.id from private.verification_requests r2
      where r2.status = 'upload_expired' and r2.purged_at is null and r2.storage_path is not null
        and (r2.purge_started_at is null or r2.purge_started_at < now() - interval '10 minutes')
      order by r2.created_at
      limit greatest(p_limit, 0)
      for update skip locked)
  returning r.id, r.storage_path;
end $$;
create or replace function public.claim_expired_uploads(p_limit int)
returns table(req_id bigint, storage_path text)
language sql security definer set search_path='' as $$
  select * from private.claim_expired_uploads(p_limit);
$$;
revoke execute on function public.claim_expired_uploads(int) from public, anon, authenticated;
grant  execute on function public.claim_expired_uploads(int) to service_role;

-- ============================================================
-- C. stale-reviews
-- ============================================================

-- C-1. 장기 미심사 알림: 3/7일 운영진(operator+owner, verified·sanction none) 경고 + 사용자 지연 안내.
--   owner_warned_3_at/7_at = "운영진 경고 발송 완료" 표식(레거시 명칭). 발송+표식은 한 트랜잭션.
create or replace function private.run_stale_review_notifications(p_limit int)
returns int language plpgsql security definer set search_path='' as $$
declare v_sent int := 0; r record; v_cnt int;
begin
  for r in
    select vr.id, vr.member_id, vr.submitted_at,
           vr.owner_warned_3_at, vr.owner_warned_7_at, vr.user_delay_notified_at
      from private.verification_requests vr
     where vr.status = 'submitted' and vr.submitted_at is not null
       and vr.submitted_at < now() - interval '3 days'
     order by vr.submitted_at
     limit greatest(p_limit, 0)
     for update skip locked
  loop
    -- 7일 경고 (운영진) — 아직 미발송이면. 실제 수신자가 1명 이상 생겼을 때만 발송 완료 표식.
    if r.submitted_at < now() - interval '7 days' and r.owner_warned_7_at is null then
      insert into public.operational_messages(member_id, kind, title, body)
        select m.id, 'system', '인증 심사 지연(7일+)', '7일 넘게 대기 중인 인증 심사가 있어요.'
          from private.members m
         where m.role in ('operator','owner') and m.verification_status = 'verified' and m.sanction = 'none';
      get diagnostics v_cnt = row_count;
      if v_cnt > 0 then   -- 수신자 0명이면 표식 미기록 → 다음 실행 재시도
        update private.verification_requests set owner_warned_7_at = now() where id = r.id;
        v_sent := v_sent + v_cnt;
      end if;
    -- 3일 경고 (운영진)
    elsif r.owner_warned_3_at is null then
      insert into public.operational_messages(member_id, kind, title, body)
        select m.id, 'system', '인증 심사 지연(3일+)', '3일 넘게 대기 중인 인증 심사가 있어요.'
          from private.members m
         where m.role in ('operator','owner') and m.verification_status = 'verified' and m.sanction = 'none';
      get diagnostics v_cnt = row_count;
      if v_cnt > 0 then
        update private.verification_requests set owner_warned_3_at = now() where id = r.id;
        v_sent := v_sent + v_cnt;
      end if;
    end if;
    -- 사용자 지연 안내 (신청자, 3일 경과 1회)
    if r.user_delay_notified_at is null then
      insert into public.operational_messages(member_id, kind, title, body)
        values (r.member_id, 'system', '심사가 지연되고 있어요', '인증 심사가 지연되고 있어요. 조금만 기다려 주세요.');
      update private.verification_requests set user_delay_notified_at = now() where id = r.id;
      v_sent := v_sent + 1;
    end if;
  end loop;
  return v_sent;
end $$;
create or replace function public.run_stale_review_notifications(p_limit int)
returns int language sql security definer set search_path='' as $$
  select private.run_stale_review_notifications(p_limit);
$$;
revoke execute on function public.run_stale_review_notifications(int) from public, anon, authenticated;
grant  execute on function public.run_stale_review_notifications(int) to service_role;

-- C-2. 30일 초과 미심사 → 한 트랜잭션으로 전이·pending 복귀·사과·파기예약(부분적용 금지). 반환=처리 건수.
--   purge_after는 이 전이 시점에 확정(설정 키 재계산 없음 — GPT Q1). 7일 유예 후 문서 파기 대상.
create or replace function private.expire_unreviewed_submissions(p_limit int)
returns int language plpgsql security definer set search_path='' as $$
declare v_n int := 0; r record;
begin
  for r in
    select vr.id, vr.member_id
      from private.verification_requests vr
     where vr.status = 'submitted' and vr.submitted_at is not null
       and vr.submitted_at < now() - interval '30 days'
     order by vr.submitted_at
     limit greatest(p_limit, 0)
     for update skip locked
  loop
    -- 원본 파기 기한: 즉시(now()) → 일 1회 파기 잡이 24h 이내 처리로 수렴.
    --   (members.verification_deadline의 '7일'은 새 제출 기한이지 원본 보존기간이 아님 — GATE3 확정값)
    update private.verification_requests
       set status = 'expired_unreviewed', purge_after = now()
     where id = r.id;
    update private.members
       set verification_status = 'pending', verification_deadline = now() + interval '7 days'
     where id = r.member_id and verification_status = 'submitted';
    insert into public.operational_messages(member_id, kind, title, body)
      values (r.member_id, 'system', '인증 심사가 만료되었어요',
              '기한 내 심사가 이뤄지지 않아 다시 제출이 필요해요. 불편을 드려 죄송해요.');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
create or replace function public.expire_unreviewed_submissions(p_limit int)
returns int language sql security definer set search_path='' as $$
  select private.expire_unreviewed_submissions(p_limit);
$$;
revoke execute on function public.expire_unreviewed_submissions(int) from public, anon, authenticated;
grant  execute on function public.expire_unreviewed_submissions(int) to service_role;

-- ============================================================
-- D. delete-accounts
--    ①~⑧(deleting 전이·hold·snapshot·표시대체·연결제거)은 prepare/detach가 담당.
--    009는 대상 claim(재개 포함)·Storage 경로 반환·삭제 수렴 확인 + prepare 멱등 보강.
-- ============================================================

-- D-0. prepare_account_deletion 멱등 보강 (GPT Q4). 이미 deleting이면 hold/snapshot 재삽입 없이
--   정상 반환 → resuming=true 재호출도 같은 결과로 수렴. 최초 진입 시에만 전이·hold·snapshot.
--   (001~008 수정이 아니라 명시적 post-freeze CREATE OR REPLACE.)
create or replace function private.prepare_account_deletion(p_member_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_status text; v_hmac text; v_ver smallint; v_reason text; v_case bigint; v_days int;
begin
  select verification_status into v_status from private.members where id = p_member_id for update;
  if not found then return; end if;              -- 멱등: 이미 삭제됨
  if v_status = 'deleting' then return; end if;   -- 멱등: 이미 준비됨 → hold/snapshot 재실행 금지
  -- (deleting 전이는 hold·snapshot 성공 뒤 함수 끝에서 수행 — 한 트랜잭션이라 중간 실패 시 전체 롤백.
  --  이렇게 두면 "deleting은 최초 prepare의 모든 작업이 성공한 뒤에만 커밋"이 명시적으로 보장됨.)

  -- ②~③ 열린 사건·활성 제재 확인 → hold 필요 판정·생성 (cascade 전!)
  select s.student_no_hmac, s.hmac_key_version into v_hmac, v_ver
    from private.school_identities s where s.member_id = p_member_id;
  if v_hmac is not null then
    select case
      when exists (select 1 from private.members m where m.id = p_member_id and m.sanction = 'banned')
        then 'banned'
      when exists (select 1 from private.members m where m.id = p_member_id
                   and m.sanction in ('write_restricted','community_suspended'))
        then 'active_sanction_withdrawal'
      when exists (select 1 from private.moderation_cases c
                   join public.post_owners po on c.target_type='post' and po.post_id = c.target_id
                   where c.status='open' and po.user_id = p_member_id)
        or exists (select 1 from private.moderation_cases c
                   join public.comment_owners co on c.target_type='comment' and co.comment_id = c.target_id
                   where c.status='open' and co.user_id = p_member_id)
        then 'open_case_withdrawal'
      end into v_reason;
    if v_reason is not null then
      select value::int into v_days from private.policy_settings where key = 'hold_retention_days';
      if v_days is null then
        raise exception 'hold retention not configured — deletion requiring hold is blocked';
      end if;
      insert into private.enforcement_holds (student_no_hmac, hmac_key_version, hold_reason, retention_until)
      values (v_hmac, v_ver, v_reason, now() + make_interval(days => v_days))
      on conflict do nothing;
    end if;
  end if;

  -- ④ 열린 사건 스냅샷
  for v_case in
    select c.id from private.moderation_cases c where c.status = 'open'
      and ((c.target_type='post' and exists (select 1 from public.post_owners o where o.post_id=c.target_id and o.user_id=p_member_id))
        or (c.target_type='comment' and exists (select 1 from public.comment_owners o where o.comment_id=c.target_id and o.user_id=p_member_id)))
  loop
    insert into private.case_snapshots (case_id, content)
    select v_case, left(coalesce(
      (select p.title || E'\n' || p.body from private.moderation_cases c2
        join public.posts p on p.id = c2.target_id where c2.id = v_case and c2.target_type='post'),
      (select cm.body from private.moderation_cases c2
        join public.comments cm on cm.id = c2.target_id where c2.id = v_case and c2.target_type='comment'),
      ''), 102400);
  end loop;

  -- ① deleting 전이 (hold·snapshot 성공 후 — 함수 끝. 중간 실패 시 이 전이도 함께 롤백)
  update private.members set verification_status = 'deleting' where id = p_member_id;
end $$;
-- (public.prepare_account_deletion 래퍼·grant는 001~008에 이미 존재 — 재선언 불필요)

-- D-1. 삭제 대상 claim (전이는 prepare가 담당 — 순서 보장). 대상 = 기한경과 미인증 신규 + deleting 재개.
--   submitted 제외, uploading은 expire-uploads가 선행. resuming=true는 deleting 재개분.
create or replace function private.claim_accounts_for_deletion(p_limit int)
returns table(member_id uuid, resuming boolean)
language plpgsql security definer set search_path='' as $$
begin
  return query
  select m.id, (m.verification_status = 'deleting')
    from private.members m
   where m.verification_status = 'deleting'
      or (m.verification_status in ('pending','rejected','expired')
          and m.verification_deadline < now())
   order by (m.verification_status = 'deleting') desc, m.verification_deadline
   limit greatest(p_limit, 0)
   for update skip locked;
end $$;
create or replace function public.claim_accounts_for_deletion(p_limit int)
returns table(member_id uuid, resuming boolean)
language sql security definer set search_path='' as $$
  select * from private.claim_accounts_for_deletion(p_limit);
$$;
revoke execute on function public.claim_accounts_for_deletion(int) from public, anon, authenticated;
grant  execute on function public.claim_accounts_for_deletion(int) to service_role;

-- D-2. 삭제 진행 중(deleting) 회원의 아직 안 지워진 인증 원본 (req_id + 경로) 반환.
--   Storage 삭제 후 각 request를 mark_verification_doc_purged로 정리하기 위해 req_id 동반.
--   deleting 상태에서만 반환(오남용 방지) + 빈/널 경로 제외.
create or replace function private.get_member_verification_paths(p_member_id uuid)
returns table(req_id bigint, storage_path text)
language plpgsql security definer set search_path='' as $$
begin
  if not exists (select 1 from private.members m
                 where m.id = p_member_id and m.verification_status = 'deleting') then
    return;   -- deleting이 아닌 회원의 경로는 반환하지 않음
  end if;
  -- 정확히 '<member_id>/' prefix 아래 객체만 반환. 비정상 경로(.., 선행 slash, 빈 값)는 제외.
  --   bucket 이름은 DB가 다루지 않고 서버 모듈이 고정 문자열 'verification-docs'로만 사용한다.
  --   LIMIT 201 — 서버가 201개면 too_many_verification_paths로 fail-closed(조용한 절단으로 남은 파일이
  --   있는데 Auth 삭제되는 사고 방지). 현 규모엔 회원당 파일이 소수라 실질 상한.
  return query
  select r.id, r.storage_path from private.verification_requests r
   where r.member_id = p_member_id
     and r.storage_path is not null and length(r.storage_path) > 0
     and r.storage_path like (p_member_id::text || '/%')
     and r.storage_path not like '%..%'
     and left(r.storage_path, 1) <> '/'
   limit 201;
end $$;
create or replace function public.get_member_verification_paths(p_member_id uuid)
returns table(req_id bigint, storage_path text)
language sql security definer set search_path='' as $$
  select * from private.get_member_verification_paths(p_member_id);
$$;
revoke execute on function public.get_member_verification_paths(uuid) from public, anon, authenticated;
grant  execute on function public.get_member_verification_paths(uuid) to service_role;

-- D-3. Auth Admin 삭제 후 수렴 확인. members 부재만으로는 부족(비정상 시 members만 사라지고
--   auth.users가 남을 수 있음) → auth.users 부재 AND members 부재의 AND로 판정(GPT 강화).
--   definer(postgres 소유)라 auth.users 조회 가능.
create or replace function private.account_deletion_converged(p_member_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  return not exists (select 1 from auth.users u where u.id = p_member_id)
     and not exists (select 1 from private.members m where m.id = p_member_id);
end $$;
create or replace function public.account_deletion_converged(p_member_id uuid)
returns boolean language sql security definer set search_path='' as $$
  select private.account_deletion_converged(p_member_id);
$$;
revoke execute on function public.account_deletion_converged(uuid) from public, anon, authenticated;
grant  execute on function public.account_deletion_converged(uuid) to service_role;

-- D-4. 계정 삭제 전용 메타 정리 — request가 "현재 삭제 중인 그 회원" 소유일 때만 파기 표시.
--   서버 코드의 ID 혼선이 다른 회원의 인증 메타를 지우는 사고를 막는다(GPT 강화).
--   반환 boolean: 처리 후 그 회원의 해당 request가 purged 상태면 true(멱등 재실행도 true),
--   소유 불일치·비-deleting이면 false → 서버는 Auth 삭제로 진행하지 않음.
--   (일반 문서 파기용 mark_verification_doc_purged(bigint)와 분리 — 계정삭제 전용.)
create or replace function private.mark_member_verification_doc_purged(p_req_id bigint, p_member_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  -- 계정삭제 경로는 claim이 선행하지 않으므로 purge_started_at을 함께 확정(CHECK 충족).
  update private.verification_requests r
     set storage_path = null, real_name = null,
         purge_started_at = coalesce(r.purge_started_at, now()),
         purged_at = coalesce(r.purged_at, now()), purge_last_error = null
   where r.id = p_req_id and r.member_id = p_member_id and r.purged_at is null
     and exists (select 1 from private.members m
                 where m.id = p_member_id and m.verification_status = 'deleting');
  return exists (select 1 from private.verification_requests r
                 where r.id = p_req_id and r.member_id = p_member_id and r.purged_at is not null);
end $$;
create or replace function public.mark_member_verification_doc_purged(p_req_id bigint, p_member_id uuid)
returns boolean language sql security definer set search_path='' as $$
  select private.mark_member_verification_doc_purged(p_req_id, p_member_id);
$$;
revoke execute on function public.mark_member_verification_doc_purged(bigint, uuid) from public, anon, authenticated;
grant  execute on function public.mark_member_verification_doc_purged(bigint, uuid) to service_role;

-- ------------------------------------------------------------
-- 최종 sweep: 009가 새로 만든 private 함수의 PUBLIC/anon/authenticated/service_role EXECUTE 회수.
--   (public 래퍼가 definer라 소유자 권한으로 private impl을 호출 — private에 별도 grant 불필요.)
--   008 sweep은 009 함수 생성 전이므로 여기서 재수행. 001~008 함수는 이미 처리됨.
-- ------------------------------------------------------------
do $$
declare r record;
begin
  for r in select p.proname, pg_get_function_identity_arguments(p.oid) as args
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private'
             and p.proname in (
               'claim_verification_docs_to_purge','mark_verification_doc_purged',
               'record_verification_purge_failure','claim_expired_uploads',
               'run_stale_review_notifications','expire_unreviewed_submissions',
               'claim_accounts_for_deletion','get_member_verification_paths',
               'account_deletion_converged','mark_member_verification_doc_purged',
               'prepare_account_deletion')
  loop
    execute format('revoke execute on function private.%I(%s) from public, anon, authenticated, service_role',
                   r.proname, r.args);
  end loop;
end $$;

commit;

-- ============================================================
-- 신규 public service_role RPC = 10종 (GPT B-1 집계 정정: 이전 "12종"은 오기)
--   공통 1: record_maintenance_run
--   purge  3: claim_verification_docs_to_purge / mark_verification_doc_purged / record_verification_purge_failure
--   expire 1: claim_expired_uploads (완료/실패는 A-2/A-3 재사용)
--   stale  2: run_stale_review_notifications / expire_unreviewed_submissions
--   delete 3: claim_accounts_for_deletion / get_member_verification_paths / account_deletion_converged
--   (+ private.prepare_account_deletion 멱등 보강 = 기존 함수 CREATE OR REPLACE, 신규 public 아님)
--
-- dev 리허설 시 필수 테스트(GPT C): anon/authenticated 전 RPC 실패·service_role만 성공 / 동시 claim
--   중복 없음 / 중단 claim의 10분 stale 재회수 / 늦은 failure가 success 미복원 / 이미 없는 Storage·Auth
--   수렴 / stale 알림 3·7일 중복 없음 / 30일 전이 원자성 / deleting prepare 재호출 시 snapshot·hold
--   중복 없음 / submitted 계정 자동삭제 제외 / get paths가 deleting 아닌 회원엔 빈 결과 / record_maintenance_run
--   임의 job·음수 processed·긴 오류 거부.
--
-- DEFERRED(명시): 사용자 자발 탈퇴 접수 UI/RPC 미구현. 향후 자발 탈퇴 RPC가 prepare_account_deletion을
--   호출해 deleting 상태를 만들면 본 Cron이 재개함. 지금은 "기한경과 미인증 + deleting 재개"만 처리 →
--   전체 탈퇴 기능 완료로 오인 금지.
