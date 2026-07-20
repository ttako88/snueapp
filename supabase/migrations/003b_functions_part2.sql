-- ============================================================
-- 003b_functions_part2.sql  (승격 시 003에 병합 또는 별도 파일 — GPT 검수 시 결정)
-- PROMOTED for dev rehearsal (P2 승인 2026-07-20) — 운영 적용은 dev 전 항목 통과+B-10 승인 후
-- 근거: GATE3_DESIGN.md v1.3 §5.5·§6(모더레이션), §9(배치), §13(계정 삭제 DB 부분)
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 0-a. maintenance lease (r4 — GPT 3차 §2: 서버 작업 중복 실행 방지)
-- ------------------------------------------------------------
create or replace function private.acquire_maintenance_lease(p_job text, p_duration_sec int)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_token uuid := gen_random_uuid();
begin
  insert into private.maintenance_leases as l (job_name, lease_token, leased_until, started_at)
  values (p_job, v_token, now() + make_interval(secs => p_duration_sec), now())
  on conflict (job_name) do update
    set lease_token = v_token, leased_until = now() + make_interval(secs => p_duration_sec),
        started_at = now()
    where l.leased_until is null or l.leased_until < now();   -- 만료된 lease만 회수
  if not found then return null; end if;                      -- 유효 lease 존재 → already_running
  return v_token;
end $$;

create or replace function private.release_maintenance_lease(p_job text, p_token uuid)
returns void language sql security definer set search_path = '' as $$
  update private.maintenance_leases
    set lease_token = null, leased_until = null
    where job_name = p_job and lease_token = p_token;          -- 자기 토큰 일치 시만
$$;

create or replace function public.acquire_maintenance_lease(p_job text, p_duration_sec int)
returns uuid language sql security definer set search_path = '' as $$
  select private.acquire_maintenance_lease(p_job, p_duration_sec);
$$;
create or replace function public.release_maintenance_lease(p_job text, p_token uuid)
returns void language sql security definer set search_path = '' as $$
  select private.release_maintenance_lease(p_job, p_token);
$$;
revoke execute on function public.acquire_maintenance_lease(text, int) from public, anon, authenticated;
grant execute on function public.acquire_maintenance_lease(text, int) to service_role;
revoke execute on function public.release_maintenance_lease(text, uuid) from public, anon, authenticated;
grant execute on function public.release_maintenance_lease(text, uuid) to service_role;

-- ------------------------------------------------------------
-- 0. record_batch_run (batch_runs 테이블은 002로 이동 — GPT 2차 §7)
-- ------------------------------------------------------------
create or replace function private.record_batch_run(p_job text, p_ok boolean, p_n int, p_err text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_streak int;
begin
  insert into private.batch_runs as b (job_name, last_run_at, last_success_at, last_processed, fail_streak, last_error)
  values (p_job, now(), case when p_ok then now() end, p_n, case when p_ok then 0 else 1 end, p_err)
  on conflict (job_name) do update set
    last_run_at = now(),
    last_success_at = case when p_ok then now() else b.last_success_at end,
    last_processed = p_n,
    fail_streak = case when p_ok then 0 else b.fail_streak + 1 end,
    last_error = p_err
  returning fail_streak into v_streak;
  if v_streak = 3 then                                   -- 3연속 실패 → owner 운영 메시지 (§9)
    insert into public.operational_messages (member_id, kind, title, body)
    select m.id, 'system', '배치 작업 연속 실패', p_job || ' 작업이 3회 연속 실패했습니다.'
    from private.members m where m.role = 'owner';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. 모더레이션 (§6 매트릭스 적용. actor_role_check·target_within_limit은 003 참조)
-- ------------------------------------------------------------
-- 대상 콘텐츠의 작성자 role 해석 (내부)
create or replace function private.content_author(p_type text, p_id bigint)
returns table (member_id uuid, member_role text)
language sql stable security definer set search_path = '' as $$
  select m.id, m.role from private.members m
  where m.id = (case p_type
    when 'post' then (select o.user_id from public.post_owners o where o.post_id = p_id)
    when 'comment' then (select o.user_id from public.comment_owners o where o.comment_id = p_id)
    end);
$$;

-- moderate_content: hide / restore / warn / write_restrict_1d (moderator+)
create or replace function public.moderate_content(p_case_id bigint, p_action text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor_role text; v_case private.moderation_cases%rowtype;
        v_target record;
begin
  v_actor_role := private.actor_role_check('moderator');
  if p_action not in ('hide','restore','warn','write_restrict') then raise exception 'invalid action'; end if;
  if coalesce(trim(p_reason),'') = '' or char_length(p_reason) > 500 then raise exception 'reason required'; end if;
  select * into v_case from private.moderation_cases where id = p_case_id and status = 'open' for update;
  if not found then raise exception 'no open case'; end if;
  select * into v_target from private.content_author(v_case.target_type, v_case.target_id);
  -- r2 (GPT 2차 §6): 탈퇴자 콘텐츠(작성자 연결 없음)도 hide/restore는 가능해야 함.
  -- 회원 대상 조치(warn·write_restrict)만 작성자 연결 필요 — 없으면 일반 응답으로 거부.
  if v_target.member_id is null and p_action in ('warn','write_restrict') then
    raise exception 'not applicable'; end if;
  if v_target.member_id is not null then
    if v_target.member_id = auth.uid() then raise exception 'self target'; end if;
    if not private.target_within_limit(v_actor_role, v_target.member_role) then
      raise exception 'target beyond limit'; end if;                     -- §6 매트릭스
  end if;
  -- r2: moderator의 1일 제한은 명백한 스팸·도배 계열 사건에만 (승인 정책)
  if p_action = 'write_restrict' and not exists (
    select 1 from private.reports r where r.case_id = p_case_id and r.reason_code = 'spam') then
    raise exception 'write_restrict requires spam-type case'; end if;

  if p_action = 'hide' then
    if v_case.target_type = 'post' then
      update public.posts set hidden_at = now() where id = v_case.target_id and hidden_at is null;
    else
      update public.comments set hidden_at = now() where id = v_case.target_id and hidden_at is null;
    end if;
  elsif p_action = 'restore' then
    if v_case.target_type = 'post' then
      update public.posts set hidden_at = null where id = v_case.target_id;
    else
      update public.comments set hidden_at = null where id = v_case.target_id;
    end if;
  elsif p_action = 'warn' then
    insert into public.operational_messages (member_id, kind, title, body)
      values (v_target.member_id, 'warning', '커뮤니티 이용 경고', p_reason);
  elsif p_action = 'write_restrict' then                                 -- moderator는 1일 한정 (§6)
    perform 1 from private.members where id = v_target.member_id for update;  -- r2: 대상 행 잠금
    update private.members set sanction = 'write_restricted', sanction_until = now() + interval '1 day'
      where id = v_target.member_id and sanction = 'none';               -- 더 강한 제재 덮어쓰기 금지
    if not found then raise exception 'stronger sanction active'; end if;
    insert into private.member_status_history (member_id, changed_field, old_value, new_value, actor_id, reason)
      values (v_target.member_id, 'sanction', 'none', 'write_restricted', auth.uid(), p_reason);
    insert into public.operational_messages (member_id, kind, title, body)
      values (v_target.member_id, 'sanction_notice', '글쓰기 제한 안내', p_reason);
  end if;

  insert into private.moderation_actions (case_id, action, target_member_id, actor_id, reason)
    values (p_case_id, case p_action when 'write_restrict' then 'write_restrict' else p_action end,
            v_target.member_id, auth.uid(), p_reason);
  insert into private.audit_logs (actor_id, action, target_type, target_id, case_id, reason)
    values (auth.uid(), 'moderate_content:' || p_action, v_case.target_type,
            v_case.target_id::text, p_case_id, p_reason);
end $$;
revoke execute on function public.moderate_content(bigint, text, text) from public, anon, authenticated;
grant execute on function public.moderate_content(bigint, text, text) to authenticated;

-- apply_sanction: suspend_7d/suspend_30d (operator+) / ban (owner) / release (operator+)
create or replace function public.apply_sanction(p_case_id bigint, p_action text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor_role text; v_case private.moderation_cases%rowtype; v_target record;
        v_new text; v_until timestamptz; v_old text;
begin
  if p_action in ('suspend_7d','suspend_30d') then
    v_actor_role := private.actor_role_check('operator');
  elsif p_action = 'ban' then
    v_actor_role := private.actor_role_check('owner');
  elsif p_action = 'release' then
    v_actor_role := private.actor_role_check('moderator');  -- 최소 진입 — 대칭 검사는 아래에서
  else raise exception 'invalid action'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'reason required'; end if;
  select * into v_case from private.moderation_cases where id = p_case_id for update;
  if not found then raise exception 'no case'; end if;
  select * into v_target from private.content_author(v_case.target_type, v_case.target_id);
  if v_target.member_id is null then raise exception 'no author'; end if;
  if v_target.member_id = auth.uid() then raise exception 'self target'; end if;
  if not private.target_within_limit(v_actor_role, v_target.member_role) then
    raise exception 'target beyond limit'; end if;

  select sanction into v_old from private.members where id = v_target.member_id for update;
  if p_action = 'release' then
    -- r2 (GPT 2차 §6): 해제 권한은 부과 권한과 대칭
    --   banned 해제=owner / 7·30일 정지 해제=operator+ / 1일 제한 해제=moderator+
    if v_old = 'banned' then perform private.actor_role_check('owner');
    elsif v_old = 'community_suspended' then perform private.actor_role_check('operator');
    elsif v_old = 'write_restricted' then perform private.actor_role_check('moderator');
    else raise exception 'no active sanction'; end if;
    v_new := 'none'; v_until := null;                       -- 만료 전 해제도 권한+감사 (§6)
  else
    v_new := case p_action when 'ban' then 'banned' else 'community_suspended' end;
    v_until := case p_action when 'suspend_7d' then now() + interval '7 days'
                             when 'suspend_30d' then now() + interval '30 days' end;
    -- 더 강한 제재를 약한 것으로 덮어쓰기 금지 (§6)
    if v_old = 'banned' then raise exception 'stronger sanction active'; end if;
    if v_old = 'community_suspended' and p_action in ('suspend_7d') then
      raise exception 'stronger sanction active'; end if;
  end if;
  update private.members set sanction = v_new, sanction_until = v_until where id = v_target.member_id;
  insert into private.member_status_history (member_id, changed_field, old_value, new_value, actor_id, reason)
    values (v_target.member_id, 'sanction', v_old, v_new, auth.uid(), p_reason);
  insert into private.moderation_actions (case_id, action, target_member_id, actor_id, reason)
    values (p_case_id, case p_action when 'ban' then 'ban' when 'release' then 'release'
            when 'suspend_7d' then 'suspend_7d' else 'suspend_30d' end,
            v_target.member_id, auth.uid(), p_reason);
  insert into private.audit_logs (actor_id, action, target_type, target_id, case_id, reason)
    values (auth.uid(), 'apply_sanction:' || p_action, v_case.target_type,
            v_case.target_id::text, p_case_id, p_reason);
  if p_action <> 'release' then
    insert into public.operational_messages (member_id, kind, title, body)
      values (v_target.member_id, 'sanction_notice', '이용 제한 안내', p_reason);
  end if;
end $$;
revoke execute on function public.apply_sanction(bigint, text, text) from public, anon, authenticated;
grant execute on function public.apply_sanction(bigint, text, text) to authenticated;

-- close_case (moderator+: dismiss / resolve)
create or replace function public.close_case(p_case_id bigint, p_resolution text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.actor_role_check('moderator');
  if p_resolution not in ('resolved','dismissed') then raise exception 'invalid resolution'; end if;
  update private.moderation_cases set status = p_resolution, closed_at = now(), closed_by = auth.uid()
    where id = p_case_id and status = 'open';
  if not found then raise exception 'no open case'; end if;
  insert into private.audit_logs (actor_id, action, case_id, reason)
    values (auth.uid(), 'close_case:' || p_resolution, p_case_id, p_reason);
end $$;
revoke execute on function public.close_case(bigint, text, text) from public, anon, authenticated;
grant execute on function public.close_case(bigint, text, text) to authenticated;

-- get_case projection (§5.5: 대상 member id·신고자 신원 미반환)
create or replace function public.get_case(p_case_id bigint)
returns table (id bigint, target_type text, target_id bigint, status text, report_count int,
               emergency boolean, opened_at timestamptz,
               reports jsonb, actions jsonb, snapshot text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.actor_role_check('moderator');
  return query select c.id, c.target_type, c.target_id, c.status, c.report_count, c.emergency, c.opened_at,
    (select coalesce(jsonb_agg(jsonb_build_object(
       'reason_code', r.reason_code, 'detail', r.detail, 'created_at', r.created_at)), '[]'::jsonb)
     from private.reports r where r.case_id = c.id),                     -- 신고자 미노출
    (select coalesce(jsonb_agg(jsonb_build_object(
       'action', a.action, 'created_at', a.created_at, 'reason', a.reason)), '[]'::jsonb)
     from private.moderation_actions a where a.case_id = c.id),          -- target_member_id 제외
    (select s.content from private.case_snapshots s where s.case_id = c.id
     order by s.captured_at desc limit 1)
  from private.moderation_cases c where c.id = p_case_id;
end $$;
revoke execute on function public.get_case(bigint) from public, anon, authenticated;
grant execute on function public.get_case(bigint) to authenticated;

-- admin_reveal_author (§6: case 일치 검증+상한 매트릭스+audit 동일 트랜잭션)
create or replace function public.admin_reveal_author(p_case_id bigint, p_target_type text,
                                                      p_target_id bigint, p_reason text)
returns table (real_name text, nickname text)
language plpgsql security definer set search_path = '' as $$
declare v_actor_role text; v_case private.moderation_cases%rowtype; v_target record;
begin
  v_actor_role := private.actor_role_check('operator');
  if coalesce(trim(p_reason),'') = '' or char_length(p_reason) > 500 then
    raise exception 'reason required'; end if;
  select * into v_case from private.moderation_cases where id = p_case_id;
  if not found or v_case.target_type <> p_target_type or v_case.target_id <> p_target_id then
    raise exception 'case mismatch'; end if;                             -- 무관 사건 차용 차단
  if v_case.status <> 'open' then raise exception 'case not open'; end if;
  select * into v_target from private.content_author(p_target_type, p_target_id);
  if v_target.member_id is null then raise exception 'no author'; end if;
  if v_target.member_id = auth.uid() then raise exception 'self target'; end if;
  if not private.target_within_limit(v_actor_role, v_target.member_role) then
    raise exception 'target beyond limit'; end if;                       -- operator는 owner 조회 불가
  insert into private.audit_logs (actor_id, action, target_type, target_id, case_id, reason)
    values (auth.uid(), 'reveal_author', p_target_type, p_target_id::text, p_case_id, p_reason);
  return query select s.real_name, m.nickname
    from private.members m left join private.school_identities s on s.member_id = m.id
    where m.id = v_target.member_id;
end $$;
revoke execute on function public.admin_reveal_author(bigint, text, bigint, text) from public, anon, authenticated;
grant execute on function public.admin_reveal_author(bigint, text, bigint, text) to authenticated;

-- grant_role / revoke_role (owner. 마지막 owner 보호 §6)
create or replace function public.grant_role(p_member_id uuid, p_role text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_old text;
begin
  perform private.actor_role_check('owner');
  if p_role not in ('member','moderator','operator','owner') then raise exception 'invalid role'; end if;
  perform pg_advisory_xact_lock(hashtext('owner_role_change'));          -- r2: 동시 강등으로 owner 0명 방지
  select role into v_old from private.members where id = p_member_id for update;
  if v_old is null then raise exception 'no member'; end if;
  if v_old = 'owner' and p_role <> 'owner'
     and (select count(*) from private.members where role = 'owner') <= 1 then
    raise exception 'last owner'; end if;                                -- 마지막 owner 강등 금지
  update private.members set role = p_role where id = p_member_id;
  insert into private.member_status_history (member_id, changed_field, old_value, new_value, actor_id, reason)
    values (p_member_id, 'role', v_old, p_role, auth.uid(), p_reason);
  insert into private.audit_logs (actor_id, action, target_type, target_id, reason)
    values (auth.uid(), 'grant_role:' || p_role, 'member', p_member_id::text, p_reason);
end $$;
revoke execute on function public.grant_role(uuid, text, text) from public, anon, authenticated;
grant execute on function public.grant_role(uuid, text, text) to authenticated;

-- ------------------------------------------------------------
-- 2. 배치 (pg_cron — 004에서 스케줄)
-- ------------------------------------------------------------
create or replace function private.expire_sanctions(p_limit int default 500)
returns void language plpgsql security definer set search_path = '' as $$
declare v_n int := 0; r record;
begin
  begin                                                   -- r2: 내부 블록
    for r in select id, sanction from private.members
             where sanction in ('write_restricted','community_suspended')
               and sanction_until is not null and sanction_until < now()
             limit p_limit for update skip locked
    loop
      update private.members set sanction = 'none', sanction_until = null where id = r.id;
      insert into private.member_status_history (member_id, changed_field, old_value, new_value, reason)
        values (r.id, 'sanction', r.sanction, 'none', 'expired');
      insert into public.operational_messages (member_id, kind, title, body)
        values (r.id, 'sanction_notice', '이용 제한 해제', '이용 제한이 종료되었습니다.');
      v_n := v_n + 1;
    end loop;
  exception when others then
    perform private.record_batch_run('expire_sanctions', false, v_n, sqlerrm);
    return;
  end;
  perform private.record_batch_run('expire_sanctions', true, v_n, null);
end $$;

-- r2 (GPT 판정 Q1): 30일 경과 soft-deleted 글은 살아있는 댓글 포함 하위 트리째 hard delete.
--   단 글 자체 또는 하위 댓글에 열린 사건이 하나라도 있으면 전체 보존.
create or replace function private.purge_soft_deleted_content(p_limit int default 500)
returns void language plpgsql security definer set search_path = '' as $$
declare v_n int := 0; v_m int;
begin
  begin                                                   -- r2: 내부 블록 — 실패 시 본문만 롤백
    -- 1) 삭제 댓글 (부모 글 생존) 정리
    with del as (
      delete from public.comments c
      where c.deleted_at is not null and c.deleted_at < now() - interval '30 days'
        and not exists (select 1 from private.moderation_cases mc
                        where mc.target_type = 'comment' and mc.target_id = c.id and mc.status = 'open')
        and c.id in (select id from public.comments
                     where deleted_at is not null and deleted_at < now() - interval '30 days' limit p_limit)
      returning 1)
    select count(*) into v_n from del;
    -- 2) 삭제 글: 하위 트리째 (comments는 FK cascade). 글·하위 댓글의 열린 사건이 없을 때만
    with del as (
      delete from public.posts p
      where p.deleted_at is not null and p.deleted_at < now() - interval '30 days'
        and not exists (select 1 from private.moderation_cases mc
                        where mc.target_type = 'post' and mc.target_id = p.id and mc.status = 'open')
        and not exists (select 1 from private.moderation_cases mc
                        join public.comments c on mc.target_type = 'comment' and mc.target_id = c.id
                        where c.post_id = p.id and mc.status = 'open')
        and p.id in (select id from public.posts
                     where deleted_at is not null and deleted_at < now() - interval '30 days' limit p_limit)
      returning 1)
    select count(*) into v_m from del;
    v_n := v_n + v_m;
  exception when others then
    perform private.record_batch_run('purge_soft_deleted_content', false, v_n, sqlerrm);
    return;                                               -- r2: 실패 기록 유지 (re-raise 안 함)
  end;
  perform private.record_batch_run('purge_soft_deleted_content', true, v_n, null);
end $$;

create or replace function private.purge_expired_holds()
returns void language plpgsql security definer set search_path = '' as $$
declare v_n int := 0;
begin
  begin
    delete from private.enforcement_holds
      where retention_until is not null and retention_until < now();
    get diagnostics v_n = row_count;                      -- hard delete (§9 v1.3)
  exception when others then
    perform private.record_batch_run('purge_expired_holds', false, 0, sqlerrm);
    return;
  end;
  perform private.record_batch_run('purge_expired_holds', true, v_n, null);
end $$;

create or replace function private.purge_expired_guest_reads()
returns void language plpgsql security definer set search_path = '' as $$
declare v_n int := 0; v_m int := 0;
begin
  begin
    delete from private.guest_reads where expires_at < now();
    get diagnostics v_n = row_count;
    delete from private.guest_ip_daily where read_date < (now() at time zone 'Asia/Seoul')::date - 1;
    get diagnostics v_m = row_count;
  exception when others then
    perform private.record_batch_run('purge_expired_guest_reads', false, v_n, sqlerrm);
    return;
  end;
  perform private.record_batch_run('purge_expired_guest_reads', true, v_n + v_m, null);
end $$;

-- ------------------------------------------------------------
-- 3. 계정 삭제 DB 부분 (§13 ①~⑧ — 트랙 B. Storage·Auth 삭제(⑨~⑫)는 서버 잡)
-- ------------------------------------------------------------
-- 서버 잡 delete-accounts가 순서대로 호출:
--   prepare_account_deletion(p_member_id)  → ①~④ (deleting 전이·사건/제재 확인·hold·snapshot)
--   detach_member_content(p_member_id)     → ⑤~⑧ (콘텐츠 구분·표시 대체·연결 제거)
--   (서버) Storage 삭제 ⑨~⑩ → Auth Admin 삭제 ⑪ → 확인 ⑫~⑭
create or replace function private.prepare_account_deletion(p_member_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_hmac text; v_ver smallint; v_reason text; v_case bigint; v_days int;
begin
  perform 1 from private.members where id = p_member_id for update;      -- finalize 경합 잠금
  if not found then return; end if;                                      -- 멱등
  update private.members set verification_status = 'deleting' where id = p_member_id;

  -- ② 열린 사건·활성 제재 확인 → ③ hold 필요 판정·생성 (cascade 전! §13)
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
      -- r2 (GPT 판정 Q2): DB 소유 policy_settings.hold_retention_days가 null이면
      -- hold가 필요한 탈퇴를 거부 (§12-3 — 보존기간 확정 전 production hold 생성 금지)
      select value::int into v_days from private.policy_settings where key = 'hold_retention_days';
      if v_days is null then
        raise exception 'hold retention not configured — deletion requiring hold is blocked';
      end if;
      insert into private.enforcement_holds (student_no_hmac, hmac_key_version, hold_reason, retention_until)
      values (v_hmac, v_ver, v_reason, now() + make_interval(days => v_days))
      on conflict do nothing;
    end if;
  end if;

  -- ④ 열린 사건 스냅샷 (사건 증거 보존 — 콘텐츠만, 개인정보 복제 금지 §5.5)
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
end $$;

create or replace function private.detach_member_content(p_member_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  -- ⑤~⑥ 공개 콘텐츠: 표시 대체 (본인 삭제분 deleted_at은 유지 — 부활 금지 §13)
  update public.posts p set author_nickname = null, author_withdrawn_at = now()
    from public.post_owners o
    where o.post_id = p.id and o.user_id = p_member_id and p.author_withdrawn_at is null;
  update public.comments c set author_nickname = null, author_withdrawn_at = now(), anon_alias_no = null
    from public.comment_owners o
    where o.comment_id = c.id and o.user_id = p_member_id and c.author_withdrawn_at is null;
  -- r2 (GPT 판정 Q3 확정): 탈퇴 회원의 댓글만 anon_alias_no null (§13이 §5.4보다 우선).
  --   다른 활성 회원의 별칭·매핑은 유지. 공개 표시는 전부 "탈퇴한 사용자".

  -- ⑦ 연결 행 삭제
  delete from public.post_owners where user_id = p_member_id;
  delete from public.comment_owners where user_id = p_member_id;
  delete from private.anon_aliases where member_id = p_member_id;
  delete from private.blocks where blocker_id = p_member_id or blocked_id = p_member_id;
  delete from private.post_views where member_id = p_member_id;
  delete from public.bookmarks where member_id = p_member_id;
  delete from public.post_votes where member_id = p_member_id;
  -- r2 (GPT 판정 Q4 확정): 탈퇴자 본인 추천은 명시적 DELETE — vote 트리거가 1회 실행되어
  --   vote_count 감소. 이후 member cascade 시점엔 행이 이미 없어 재처리 없음.
  --   post_views 삭제는 view_count를 감소시키지 않음 (조회수는 참고 통계 §0).
end $$;

-- r2 (GPT 2차 §2): 트랙 B는 public 얇은 래퍼(service_role EXECUTE)로 통일
create or replace function public.prepare_account_deletion(p_member_id uuid)
returns void language sql security definer set search_path = '' as $$
  select private.prepare_account_deletion(p_member_id);
$$;
revoke execute on function public.prepare_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.prepare_account_deletion(uuid) to service_role;

create or replace function public.detach_member_content(p_member_id uuid)
returns void language sql security definer set search_path = '' as $$
  select private.detach_member_content(p_member_id);
$$;
revoke execute on function public.detach_member_content(uuid) from public, anon, authenticated;
grant execute on function public.detach_member_content(uuid) to service_role;

commit;
