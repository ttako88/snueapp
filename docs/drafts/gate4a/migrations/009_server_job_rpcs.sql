-- ============================================================
-- 009_server_job_rpcs.sql — 서버 잡(maintenance Route) 전용 service_role RPC
-- ============================================================
-- ⚠️ DRAFT · NOT EXECUTED · post-freeze 추가 migration (Batch 0 RPC 경계 대조 결과)
--   - 동결본 001~008(SHA 6746127)은 수정하지 않는다. 009는 그 위에 얹는 별도 번호.
--   - 원격(dev/prod)에 적용하지 않는다 — GPT 배치 검수 통과 후 dev 리허설 → 재동결.
--   - 근거: docs/drafts/gate4a/scripts/server-jobs/README.md(서버 잡 계약),
--            GATE3_DESIGN v1.3 §4.4(파기)·§9(배치)·§13(계정삭제 14단계).
--
-- 설계 규칙(전 함수 공통):
--   - private 스키마는 PostgREST 미노출. 서버 service_role client는 private을 직접 CRUD하지 않고
--     반드시 이 public 얇은 래퍼(→ private impl)만 호출한다. (Supabase 보안 권장)
--   - 전 함수 SECURITY DEFINER + set search_path='' + EXECUTE는 service_role에만.
--   - claim류는 for update skip locked + 상태/시각 조건으로 재실행 시 완료분 스킵(멱등).
--   - "파일 이미 없음 = 성공 수렴", "이미 처리됨 = no-op"은 호출측(서버 잡)과 DB가 함께 만족.
--   - 응답/기록에 실명·학번 HMAC·경로·UUID·원문 오류를 넣지 않는다(비식별 error_code만).
-- ============================================================
begin;

-- ------------------------------------------------------------
-- 0. 공통: 배치 실행 기록 public 래퍼 (private.record_batch_run은 001~008에 이미 존재)
-- ------------------------------------------------------------
create or replace function public.record_maintenance_run(
  p_job text, p_ok boolean, p_processed int, p_error_code text)
returns void language sql security definer set search_path='' as $$
  select private.record_batch_run(p_job, p_ok, p_processed, p_error_code);
$$;
revoke execute on function public.record_maintenance_run(text, boolean, int, text) from public, anon, authenticated;
grant  execute on function public.record_maintenance_run(text, boolean, int, text) to service_role;

-- ============================================================
-- A. purge-verification-docs
--    파기 예정(purge_after 경과) 인증 원본을 서버가 Storage에서 지우도록 경로를 넘기고,
--    Storage 삭제 성공 확인 후 path·real_name을 null 처리.
-- ============================================================

-- A-1. 파기 대상 claim: purge_started_at 기록 + attempts+1, [id, storage_path] 반환.
--   재실행 시 purged_at is null 조건으로만 다시 잡히므로 완료분은 스킵.
create or replace function private.claim_verification_docs_to_purge(p_limit int)
returns table(req_id bigint, storage_path text)
language plpgsql security definer set search_path='' as $$
begin
  return query
  update private.verification_requests r
     set purge_started_at = now(), purge_attempts = r.purge_attempts + 1
   where r.id in (
     select r2.id from private.verification_requests r2
      where r2.purge_after is not null and r2.purge_after < now()
        and r2.purged_at is null and r2.storage_path is not null
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

-- A-2. Storage 삭제 성공(또는 이미 없음) 확인 후 파기 완료 표시 (멱등: 이미 purged면 no-op).
create or replace function private.mark_verification_doc_purged(p_req_id bigint)
returns void language plpgsql security definer set search_path='' as $$
begin
  update private.verification_requests
     set storage_path = null, real_name = null, purged_at = now(), purge_last_error = null
   where id = p_req_id and purged_at is null;
end $$;
create or replace function public.mark_verification_doc_purged(p_req_id bigint)
returns void language sql security definer set search_path='' as $$
  select private.mark_verification_doc_purged(p_req_id);
$$;
revoke execute on function public.mark_verification_doc_purged(bigint) from public, anon, authenticated;
grant  execute on function public.mark_verification_doc_purged(bigint) to service_role;

-- A-3. 파기 실패 기록(비식별 error_code만). 민감 참조(path·real_name)는 유지 → 다음 실행 재시도.
create or replace function private.record_verification_purge_failure(p_req_id bigint, p_error_code text)
returns void language plpgsql security definer set search_path='' as $$
begin
  update private.verification_requests
     set purge_last_error = left(coalesce(p_error_code,'unknown'), 40)
   where id = p_req_id and purged_at is null;
end $$;
create or replace function public.record_verification_purge_failure(p_req_id bigint, p_error_code text)
returns void language sql security definer set search_path='' as $$
  select private.record_verification_purge_failure(p_req_id, p_error_code);
$$;
revoke execute on function public.record_verification_purge_failure(bigint, text) from public, anon, authenticated;
grant  execute on function public.record_verification_purge_failure(bigint, text) to service_role;

-- ============================================================
-- B. expire-uploads
--    uploading 24h 경과 → upload_expired 전이(finalize 차단) 후, 미완 객체 경로를 넘겨 정리.
--    Storage 완료/실패는 A-2/A-3 재사용(같은 테이블·컬럼).
-- ============================================================
create or replace function private.claim_expired_uploads(p_limit int)
returns table(req_id bigint, storage_path text)
language plpgsql security definer set search_path='' as $$
begin
  -- ① 24h 경과 uploading → upload_expired 전이 (Storage 실패와 무관하게 전이는 확정)
  update private.verification_requests
     set status = 'upload_expired'
   where status = 'uploading' and created_at < now() - interval '24 hours';
  -- ② 정리 대상 반환: upload_expired 이면서 객체가 남고(purged_at null) 경로가 있는 건.
  --    다음 실행이 upload_expired AND purged_at IS NULL 을 재선별 → Storage 실패분 재시도(r4).
  return query
  update private.verification_requests r
     set purge_started_at = now(), purge_attempts = r.purge_attempts + 1
   where r.id in (
     select r2.id from private.verification_requests r2
      where r2.status = 'upload_expired' and r2.purged_at is null and r2.storage_path is not null
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
--    C-1: 제출 후 장기 미심사 → 3/7일 owner 경고 + 사용자 지연 안내(발송 시각 컬럼으로 중복 방지).
--    C-2: 30일 초과 → expired_unreviewed 전이 + member pending 복귀 + deadline+7d + 사과 + purge_after.
--    (Storage 삭제는 purge-verification-docs가 담당 — 여기선 purge_after만 설정)
-- ============================================================

-- C-1. 알림 발송 (한 요청당 한 트랜잭션, 이미 보낸 종류는 스킵). 반환=발송 건수.
--   owner 경고는 operator/owner 계정에게, 사용자 지연 안내는 신청자에게.
create or replace function private.run_stale_review_notifications(p_limit int)
returns int language plpgsql security definer set search_path='' as $$
declare v_sent int := 0; r record; v_owner uuid;
begin
  select id into v_owner from private.members where role = 'owner' order by created_at limit 1;
  for r in
    select vr.id, vr.member_id, vr.submitted_at,
           vr.owner_warned_3_at, vr.owner_warned_7_at, vr.user_delay_notified_at
      from private.verification_requests vr
     where vr.status = 'submitted' and vr.submitted_at is not null
       and (vr.submitted_at < now() - interval '3 days')
     order by vr.submitted_at
     limit greatest(p_limit, 0)
     for update skip locked
  loop
    -- 7일 경고 (owner)
    if r.submitted_at < now() - interval '7 days' and r.owner_warned_7_at is null then
      if v_owner is not null then
        insert into public.operational_messages(member_id, kind, title, body)
          values (v_owner, 'system', '인증 심사 지연(7일+)', '7일 넘게 대기 중인 인증 심사가 있어요.');
      end if;
      update private.verification_requests set owner_warned_7_at = now() where id = r.id;
      v_sent := v_sent + 1;
    -- 3일 경고 (owner)
    elsif r.submitted_at < now() - interval '3 days' and r.owner_warned_3_at is null then
      if v_owner is not null then
        insert into public.operational_messages(member_id, kind, title, body)
          values (v_owner, 'system', '인증 심사 지연(3일+)', '3일 넘게 대기 중인 인증 심사가 있어요.');
      end if;
      update private.verification_requests set owner_warned_3_at = now() where id = r.id;
      v_sent := v_sent + 1;
    end if;
    -- 사용자 지연 안내 (신청자, 3일 경과 시 1회)
    if r.submitted_at < now() - interval '3 days' and r.user_delay_notified_at is null then
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

-- C-2. 30일 초과 미심사 → 한 트랜잭션으로 전이·복귀·사과·파기예약 (부분적용 금지). 반환=처리 건수.
create or replace function private.expire_unreviewed_submissions(p_limit int)
returns int language plpgsql security definer set search_path='' as $$
declare v_n int := 0; r record; v_days int;
begin
  select value::int into v_days from private.policy_settings where key = 'verification_doc_retention_days';
  for r in
    select vr.id, vr.member_id
      from private.verification_requests vr
     where vr.status = 'submitted' and vr.submitted_at is not null
       and vr.submitted_at < now() - interval '30 days'
     order by vr.submitted_at
     limit greatest(p_limit, 0)
     for update skip locked
  loop
    update private.verification_requests
       set status = 'expired_unreviewed',
           purge_after = now() + make_interval(days => coalesce(v_days, 0))
     where id = r.id;
    -- member pending 복귀 + 재제출 기한 7일 (deleting/verified가 아닌 경우만)
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
-- D. delete-accounts (§13 — DB 단계 ①~⑧은 001~008의 prepare/detach가 담당)
--    009는 "대상 claim(재개 포함)·Storage 경로 반환·삭제 수렴 확인"만 보탠다.
--    서버 순서: claim → prepare_account_deletion → detach_member_content
--             → get_member_verification_paths → Storage remove → Auth Admin delete
--             → account_deletion_converged 확인
-- ============================================================

-- D-1. 삭제 대상 조회 (전이는 하지 않음 — 전이·hold·snapshot은 prepare가 담당해야 순서 보장).
--   대상 = ①기한 경과 미인증(pending/rejected/expired, deadline 경과) ②이미 deleting(재개).
--   deleting을 함께 반환해야 중단된 파이프라인을 다음 실행이 이어받는다.
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

-- D-2. 해당 회원의 아직 안 지워진 인증 원본 경로 반환 (Auth 삭제 전 Storage 정리용).
create or replace function private.get_member_verification_paths(p_member_id uuid)
returns table(storage_path text)
language plpgsql security definer set search_path='' as $$
begin
  return query
  select r.storage_path from private.verification_requests r
   where r.member_id = p_member_id and r.storage_path is not null;
end $$;
create or replace function public.get_member_verification_paths(p_member_id uuid)
returns table(storage_path text)
language sql security definer set search_path='' as $$
  select * from private.get_member_verification_paths(p_member_id);
$$;
revoke execute on function public.get_member_verification_paths(uuid) from public, anon, authenticated;
grant  execute on function public.get_member_verification_paths(uuid) to service_role;

-- D-3. Auth Admin 삭제 후 수렴 확인: members 행이 사라졌으면 true (auth.users cascade 결과).
--   Auth 사용자가 이미 없고 members도 없으면 "삭제 완료 수렴"으로 판정.
create or replace function private.account_deletion_converged(p_member_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  return not exists (select 1 from private.members where id = p_member_id);
end $$;
create or replace function public.account_deletion_converged(p_member_id uuid)
returns boolean language sql security definer set search_path='' as $$
  select private.account_deletion_converged(p_member_id);
$$;
revoke execute on function public.account_deletion_converged(uuid) from public, anon, authenticated;
grant  execute on function public.account_deletion_converged(uuid) to service_role;

commit;

-- ============================================================
-- 검토 필요 사항 (GPT 배치 검수 대상 — 초안 작성자 메모)
-- ============================================================
-- Q1. policy_settings에 'verification_doc_retention_days' 키가 002 시드에 없음(현재 hold_retention_days만).
--     C-2의 purge_after 계산에 필요 → 009에서 seed 추가할지, 별도로 둘지 판정 요망.
--     (coalesce(v_days,0) → 키 없으면 즉시 파기가능 시각. 안전상 기본값/필수화 검토.)
-- Q2. stale-reviews owner 경고 수신자 = role='owner' 1인으로 고정(1인 운영 전제). operator도 포함할지.
-- Q3. operational_messages.kind에 'system'만 사용(리뷰 지연·만료). 전용 kind('review_delay' 등)를
--     002 CHECK에 추가하는 건 동결 위반이라 회피 — 'system' 재사용이 맞는지 판정.
-- Q4. delete-accounts claim이 deleting을 재개 대상으로 반환 → prepare/detach 재호출이 완전 멱등인지
--     (prepare의 case_snapshots insert가 재실행 시 중복 삽입 가능 — on conflict 없음). 보강 필요 여부.
-- Q5. claim_accounts_for_deletion은 '탈퇴 요청' 대상을 포함하지 못함(members에 withdrawal 플래그 부재).
--     v1 사용자 자발 탈퇴 경로가 별도 설계되면 그 신호를 claim 조건에 추가해야 함.
