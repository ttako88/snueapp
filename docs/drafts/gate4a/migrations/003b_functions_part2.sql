-- ============================================================
-- 003b_functions_part2.sql  (승격 시 003에 병합 또는 별도 파일 — GPT 검수 시 결정)
-- DRAFT — NOT EXECUTED — NOT APPROVED FOR DEV APPLY
-- 근거: GATE3_DESIGN.md v1.3 §5.5·§6(모더레이션), §9(배치), §13(계정 삭제 DB 부분)
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 0. batch_runs (실행 기록 — §9 공통. 승격 시 002로 이동 검토)
-- ------------------------------------------------------------
create table private.batch_runs (
  job_name        text primary key,
  last_success_at timestamptz,
  last_run_at     timestamptz,
  last_processed  int,
  fail_streak     int not null default 0,
  last_error      text
);
alter table private.batch_runs enable row level security;
revoke all on private.batch_runs from anon, authenticated;

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
  if v_target.member_id is null then raise exception 'no author';       -- 탈퇴자 콘텐츠는 §13 경로
  end if;
  if v_target.member_id = auth.uid() then raise exception 'self target'; end if;
  if not private.target_within_limit(v_actor_role, v_target.member_role) then
    raise exception 'target beyond limit'; end if;                       -- §6 매트릭스

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
  if p_action in ('suspend_7d','suspend_30d','release') then
    v_actor_role := private.actor_role_check('operator');
  elsif p_action = 'ban' then
    v_actor_role := private.actor_role_check('owner');
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
  if p_member_id = auth.uid() and p_role <> 'owner' then
    if (select count(*) from private.members where role = 'owner') <= 1 then
      raise exception 'last owner'; end if;                              -- 마지막 owner 강등 금지
  end if;
  select role into v_old from private.members where id = p_member_id for update;
  if v_old is null then raise exception 'no member'; end if;
  if v_old = 'owner' and p_role <> 'owner'
     and (select count(*) from private.members where role = 'owner') <= 1 then
    raise exception 'last owner'; end if;
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
  perform private.record_batch_run('expire_sanctions', true, v_n, null);
exception when others then
  perform private.record_batch_run('expire_sanctions', false, v_n, sqlerrm);
  raise;
end $$;

create or replace function private.purge_soft_deleted_content(p_limit int default 500)
returns void language plpgsql security definer set search_path = '' as $$
declare v_n int := 0;
begin
  -- 열린 사건 대상 제외 (§0). comments 먼저(FK cascade와 무관하게 명시), posts 다음
  with del as (
    delete from public.comments c
    where c.deleted_at is not null and c.deleted_at < now() - interval '30 days'
      and not exists (select 1 from private.moderation_cases mc
                      where mc.target_type = 'comment' and mc.target_id = c.id and mc.status = 'open')
      and c.id in (select id from public.comments
                   where deleted_at is not null and deleted_at < now() - interval '30 days' limit p_limit)
    returning 1)
  select count(*) into v_n from del;
  with del as (
    delete from public.posts p
    where p.deleted_at is not null and p.deleted_at < now() - interval '30 days'
      and not exists (select 1 from private.moderation_cases mc
                      where mc.target_type = 'post' and mc.target_id = p.id and mc.status = 'open')
      and not exists (select 1 from public.comments c where c.post_id = p.id and c.deleted_at is null)
      and p.id in (select id from public.posts
                   where deleted_at is not null and deleted_at < now() - interval '30 days' limit p_limit)
    returning 1)
  select v_n + count(*) into v_n from del;
  perform private.record_batch_run('purge_soft_deleted_content', true, v_n, null);
exception when others then
  perform private.record_batch_run('purge_soft_deleted_content', false, v_n, sqlerrm);
  raise;
end $$;
-- TODO(검수 질문): 삭제 글에 살아있는 댓글이 달린 경우의 처리 — 위 초안은 보류(글 유지).
--   대안: 댓글도 함께 삭제. GATE3에 명시가 없어 GPT 판단 요청.

create or replace function private.purge_expired_holds()
returns void language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  delete from private.enforcement_holds
    where retention_until is not null and retention_until < now();
  get diagnostics v_n = row_count;                        -- hard delete (§9 v1.3)
  perform private.record_batch_run('purge_expired_holds', true, v_n, null);
exception when others then
  perform private.record_batch_run('purge_expired_holds', false, 0, sqlerrm);
  raise;
end $$;

create or replace function private.purge_expired_guest_reads()
returns void language plpgsql security definer set search_path = '' as $$
declare v_n int; v_m int;
begin
  delete from private.guest_reads where expires_at < now();
  get diagnostics v_n = row_count;
  delete from private.guest_ip_daily where read_date < (now() at time zone 'Asia/Seoul')::date - 1;
  get diagnostics v_m = row_count;
  perform private.record_batch_run('purge_expired_guest_reads', true, v_n + v_m, null);
exception when others then
  perform private.record_batch_run('purge_expired_guest_reads', false, 0, sqlerrm);
  raise;
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
declare v_hmac text; v_ver smallint; v_reason text; v_case bigint;
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
      -- 보존기간 미확정 시 production hold 생성 금지 (§12-3): retention_until 정책값이
      -- 확정되기 전에는 예외를 던져 파이프라인을 중단한다 (환경 플래그 HOLD_RETENTION_CONFIRMED)
      -- TODO: 플래그 구현 방식 dev에서 확정 (settings 테이블 vs env → 함수 인자)
      insert into private.enforcement_holds (student_no_hmac, hmac_key_version, hold_reason, retention_until)
      values (v_hmac, v_ver, v_reason, null)
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
  -- TODO(검수 질문): 익명 댓글의 anon_alias_no 비정규화 값을 null로 지울지(연결 추론 차단 강화)
  --   유지할지(화면 번호 유지 — §5.4는 "표시 유지"라 했으나 §13은 "연결 식별자 제거") — GPT 판단 요청.
  --   위 초안은 §13 우선으로 null 처리.

  -- ⑦ 연결 행 삭제
  delete from public.post_owners where user_id = p_member_id;
  delete from public.comment_owners where user_id = p_member_id;
  delete from private.anon_aliases where member_id = p_member_id;
  delete from private.blocks where blocker_id = p_member_id or blocked_id = p_member_id;
  delete from private.post_views where member_id = p_member_id;
  delete from public.bookmarks where member_id = p_member_id;
  delete from public.post_votes where member_id = p_member_id;
  -- TODO(검수 질문): 탈퇴자의 추천 삭제 시 vote_count 감소 여부 — 트리거가 처리하지만
  --   "타인의 추천 수 유지" 관점에서 탈퇴자 본인이 남긴 추천만 삭제되는 것이 §13 취지에 맞는지 확인.
end $$;

-- EXECUTE: service_role만
revoke execute on function private.prepare_account_deletion(uuid) from public, anon, authenticated;
grant execute on function private.prepare_account_deletion(uuid) to service_role;
revoke execute on function private.detach_member_content(uuid) from public, anon, authenticated;
grant execute on function private.detach_member_content(uuid) to service_role;

commit;
