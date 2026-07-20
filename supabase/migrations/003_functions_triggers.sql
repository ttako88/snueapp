-- ============================================================
-- 003_functions_triggers.sql  (r2 — GPT 2차 배치 검수 8건 반영)
-- PROMOTED for dev rehearsal (P2 승인 2026-07-20) — 운영 적용은 dev 전 항목 통과+B-10 승인 후
-- 근거: GATE3_DESIGN.md v1.3 §2(트랙 A/B), §3~§6, §8, §13
-- r2 변경: RLS 헬퍼를 authz 스키마로 격리 / 보호를 트리거가 아닌 컬럼 권한에 위임 /
--          트랙 B는 public 래퍼→private impl 통일 / claim은 advisory lock /
--          상호작용 RPC에 가시성 검사 / HMAC 배열 검증 강화
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. RLS 전용 헬퍼 (authz 스키마 — PostgREST 비노출, RPC 오라클 차단)
-- ------------------------------------------------------------
create or replace function authz.is_active_member()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.members m
    where m.id = auth.uid()
      and m.nickname is not null
      and m.verification_status = 'verified'
      and m.sanction not in ('community_suspended','banned')
  );
$$;
create or replace function authz.is_writable_member()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.members m
    where m.id = auth.uid()
      and m.nickname is not null
      and m.verification_status = 'verified'
      and m.sanction = 'none'
  );
$$;
create or replace function authz.is_blocked_author(p_content_type text, p_content_id bigint)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_content_type
    when 'post' then exists (
      select 1 from public.post_owners o
      join private.blocks b on b.blocked_id = o.user_id
      where o.post_id = p_content_id and b.blocker_id = auth.uid())
    when 'comment' then exists (
      select 1 from public.comment_owners o
      join private.blocks b on b.blocked_id = o.user_id
      where o.comment_id = p_content_id and b.blocker_id = auth.uid())
    else false end;
$$;
create or replace function authz.board_access_ok(p_board_id smallint)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.boards b
    where b.id = p_board_id and b.access in ('preview','members'));
$$;
-- 내부 공용: 호출자에게 해당 글이 보이는 상태인가 (RPC 가시성 검사용 — GPT 2차 §3)
create or replace function authz.post_visible_to_me(p_post_id bigint)
returns boolean language sql stable security definer set search_path = '' as $$
  select authz.is_active_member() and exists (
    select 1 from public.posts p
    where p.id = p_post_id and p.deleted_at is null and p.hidden_at is null
      and authz.board_access_ok(p.board_id)
      and not authz.is_blocked_author('post', p.id));
$$;
revoke execute on function authz.is_active_member(), authz.is_writable_member(),
  authz.is_blocked_author(text, bigint), authz.board_access_ok(smallint),
  authz.post_visible_to_me(bigint) from public, anon;
grant execute on function authz.is_active_member(), authz.is_writable_member(),
  authz.is_blocked_author(text, bigint), authz.board_access_ok(smallint),
  authz.post_visible_to_me(bigint) to authenticated;
-- authz 스키마는 PostgREST 미노출 → authenticated여도 REST RPC로는 호출 불가 (RLS 평가만)

-- ------------------------------------------------------------
-- 2. 함수 의존 RLS 정책
-- ------------------------------------------------------------
create policy boards_member_select on public.boards
  for select to authenticated
  using (access = 'preview' or (access = 'members' and authz.is_active_member()));

create policy posts_select on public.posts
  for select to authenticated
  using (authz.is_active_member() and deleted_at is null and hidden_at is null
         and authz.board_access_ok(board_id)
         and not authz.is_blocked_author('post', id));
create policy posts_insert on public.posts
  for insert to authenticated
  with check (authz.is_writable_member() and authz.board_access_ok(board_id));
create policy posts_update on public.posts
  for update to authenticated
  using (authz.is_writable_member()
         and exists (select 1 from public.post_owners o where o.post_id = id and o.user_id = auth.uid()))
  with check (authz.is_writable_member()
         and exists (select 1 from public.post_owners o where o.post_id = id and o.user_id = auth.uid()));

create policy comments_select on public.comments
  for select to authenticated
  using (authz.is_active_member() and deleted_at is null and hidden_at is null
         and not authz.is_blocked_author('comment', id)
         and exists (select 1 from public.posts p
                     where p.id = post_id and p.deleted_at is null and p.hidden_at is null
                       and authz.board_access_ok(p.board_id)
                       and not authz.is_blocked_author('post', p.id)));
create policy comments_insert on public.comments
  for insert to authenticated
  with check (authz.is_writable_member() and authz.post_visible_to_me(post_id));
create policy comments_update on public.comments
  for update to authenticated
  using (authz.is_writable_member()
         and exists (select 1 from public.comment_owners o where o.comment_id = id and o.user_id = auth.uid()))
  with check (authz.is_writable_member()
         and exists (select 1 from public.comment_owners o where o.comment_id = id and o.user_id = auth.uid()));

create policy post_votes_insert on public.post_votes
  for insert to authenticated
  with check (member_id = auth.uid() and authz.is_writable_member()
              and authz.post_visible_to_me(post_id));
create policy post_votes_delete on public.post_votes
  for delete to authenticated
  using (member_id = auth.uid() and authz.is_writable_member());
create policy bookmarks_insert on public.bookmarks
  for insert to authenticated
  with check (member_id = auth.uid() and authz.is_writable_member()
              and authz.post_visible_to_me(post_id));
create policy bookmarks_delete on public.bookmarks
  for delete to authenticated
  using (member_id = auth.uid() and authz.is_writable_member());

-- ------------------------------------------------------------
-- 3. 트리거 (r2 — 보호는 컬럼 권한이 담당. 트리거는 허용 컬럼의 "규칙"만 검사)
--    클라이언트는 posts(title,body,deleted_at)·comments(body,deleted_at)만 UPDATE 가능
--    → hidden_at·author_withdrawn_at·카운터는 definer 함수가 자유 변경 (트리거 미차단)
-- ------------------------------------------------------------
create or replace function private.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into private.members (id) values (new.id) on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

create or replace function private.on_post_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_nick text;
begin
  if new.is_anonymous then
    new.author_nickname := null;
  else
    select m.nickname into v_nick from private.members m where m.id = auth.uid();
    new.author_nickname := v_nick;
  end if;
  return new;
end $$;
create trigger posts_before_insert before insert on public.posts
  for each row execute function private.on_post_insert();

create or replace function private.on_post_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.post_owners (post_id, user_id) values (new.id, auth.uid());
  if new.is_anonymous then
    insert into private.anon_aliases (post_id, member_id, alias_no) values (new.id, auth.uid(), 0);
  end if;
  return new;
end $$;
create trigger posts_after_insert after insert on public.posts
  for each row execute function private.on_post_after_insert();

-- deleted_at 규칙 (GPT 2차 §4): NULL → DB 현재 시각 전이만. 복구·재삭제·임의 시각 금지
create or replace function private.on_post_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.deleted_at is not null then raise exception 'already deleted'; end if;
  if new.deleted_at is distinct from old.deleted_at then
    new.deleted_at := now();               -- NULL→now() 전이만 (컬럼 권한이 나머지 보호)
  end if;
  new.updated_at := now();
  return new;
end $$;
-- r3 (GPT 3차 §1): pg_trigger_depth 폐기 — 작성자 변경 가능 컬럼에만 트리거를 건다.
-- hidden_at·author_withdrawn_at·카운터만 바꾸는 definer 작업에는 아예 발동하지 않음
-- → soft-delete된 콘텐츠에도 탈퇴 파이프라인이 author_withdrawn_at을 안전하게 설정 가능.
create trigger posts_before_update before update of title, body, deleted_at on public.posts
  for each row execute function private.on_post_update();

create or replace function private.on_comment_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_nick text; v_alias smallint;
begin
  if new.is_anonymous then
    new.author_nickname := null;
    perform 1 from public.posts p where p.id = new.post_id for update;
    select a.alias_no into v_alias from private.anon_aliases a
      where a.post_id = new.post_id and a.member_id = auth.uid();
    if v_alias is null then
      select coalesce(max(a.alias_no), 0) + 1 into v_alias
        from private.anon_aliases a where a.post_id = new.post_id;
      insert into private.anon_aliases (post_id, member_id, alias_no)
        values (new.post_id, auth.uid(), v_alias);
    end if;
    new.anon_alias_no := v_alias;
  else
    select m.nickname into v_nick from private.members m where m.id = auth.uid();
    new.author_nickname := v_nick; new.anon_alias_no := null;
  end if;
  return new;
end $$;
create trigger comments_before_insert before insert on public.comments
  for each row execute function private.on_comment_insert();

create or replace function private.on_comment_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.comment_owners (comment_id, user_id) values (new.id, auth.uid());
  update public.posts set comment_count = comment_count + 1 where id = new.post_id;
  return new;
end $$;
create trigger comments_after_insert after insert on public.comments
  for each row execute function private.on_comment_after_insert();

create or replace function private.on_comment_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.deleted_at is not null then raise exception 'already deleted'; end if;
  if new.deleted_at is distinct from old.deleted_at then
    new.deleted_at := now();
    update public.posts set comment_count = greatest(comment_count - 1, 0) where id = new.post_id;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger comments_before_update before update of body, deleted_at on public.comments
  for each row execute function private.on_comment_update();

create or replace function private.on_vote_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set vote_count = vote_count + 1 where id = new.post_id; return new;
  elsif tg_op = 'DELETE' then
    update public.posts set vote_count = greatest(vote_count - 1, 0) where id = old.post_id; return old;
  end if; return null;
end $$;
create trigger post_votes_after_change after insert or delete on public.post_votes
  for each row execute function private.on_vote_change();

-- ------------------------------------------------------------
-- 4. 회원 RPC (트랙 A)
-- ------------------------------------------------------------
create or replace function public.get_my_member()
returns table (id uuid, nickname text, verification_status text, verification_deadline timestamptz,
               sanction text, sanction_until timestamptz, role text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select m.id, m.nickname, m.verification_status, m.verification_deadline,
         m.sanction, m.sanction_until, m.role, m.created_at
  from private.members m where m.id = auth.uid();
$$;
revoke execute on function public.get_my_member() from public, anon, authenticated;
grant execute on function public.get_my_member() to authenticated;

create or replace function private.validate_nickname(p_nick text)
returns text language plpgsql immutable set search_path = '' as $$
declare v text;
begin
  v := trim(regexp_replace(coalesce(p_nick,''), '\s+', ' ', 'g'));
  v := normalize(v, nfc);
  if v = '' or char_length(v) not between 2 and 16 then raise exception 'invalid nickname length'; end if;
  if v ~ '[ -]' then raise exception 'invalid characters'; end if;
  if lower(v) ~ '(운영자|관리자|공식|공지|admin|administrator|moderator|operator|owner)' then
    raise exception 'reserved nickname'; end if;
  return v;
end $$;

create or replace function public.set_initial_nickname(p_nick text)
returns void language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  v := private.validate_nickname(p_nick);
  update private.members set nickname = v
    where id = auth.uid() and nickname is null;
  if not found then raise exception 'nickname already set or no member'; end if;
exception when unique_violation then
  raise exception 'nickname in use';
end $$;
revoke execute on function public.set_initial_nickname(text) from public, anon, authenticated;
grant execute on function public.set_initial_nickname(text) to authenticated;

create or replace function public.change_nickname(p_nick text)
returns void language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  v := private.validate_nickname(p_nick);
  update private.members set nickname = v, nickname_changed_at = now()
    where id = auth.uid() and nickname is not null
      and (nickname_changed_at is null or nickname_changed_at < now() - interval '30 days');
  if not found then raise exception 'nickname change not allowed yet'; end if;
exception when unique_violation then
  raise exception 'nickname in use';
end $$;
revoke execute on function public.change_nickname(text) from public, anon, authenticated;
grant execute on function public.change_nickname(text) to authenticated;

create or replace function public.mark_message_read(p_id bigint)
returns void language sql security definer set search_path = '' as $$
  update public.operational_messages set read_at = now()
    where id = p_id and member_id = auth.uid() and read_at is null;
$$;
revoke execute on function public.mark_message_read(bigint) from public, anon, authenticated;
grant execute on function public.mark_message_read(bigint) to authenticated;

-- ------------------------------------------------------------
-- 5. 상호작용 RPC (트랙 A — r2: 가시성 검사 적용)
-- ------------------------------------------------------------
create or replace function public.record_member_view(p_post_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not authz.post_visible_to_me(p_post_id) then return; end if;   -- 원본 SELECT와 동일 조건
  insert into private.post_views (post_id, member_id) values (p_post_id, auth.uid())
    on conflict do nothing;
  if found then
    update public.posts set view_count = view_count + 1 where id = p_post_id;
  end if;
end $$;
revoke execute on function public.record_member_view(bigint) from public, anon, authenticated;
grant execute on function public.record_member_view(bigint) to authenticated;

-- 차단 (r2): 열람 가능한 콘텐츠만 해석. 부재·자기 콘텐츠·중복·신규 전부 동일한 무응답 성공
create or replace function public.block_author(p_content_type text, p_content_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare v_target uuid;
begin
  if not authz.is_active_member() then raise exception 'not allowed'; end if;
  if p_content_type = 'post' then
    if not authz.post_visible_to_me(p_content_id) then return; end if;
    select o.user_id into v_target from public.post_owners o where o.post_id = p_content_id;
  elsif p_content_type = 'comment' then
    if not exists (select 1 from public.comments c
                   where c.id = p_content_id and c.deleted_at is null and c.hidden_at is null
                     and authz.post_visible_to_me(c.post_id)) then return; end if;
    select o.user_id into v_target from public.comment_owners o where o.comment_id = p_content_id;
  else raise exception 'invalid type'; end if;
  if v_target is null or v_target = auth.uid() then return; end if;  -- 동일한 조용한 성공 (오라클 방지)
  insert into private.blocks (blocker_id, blocked_id) values (auth.uid(), v_target)
    on conflict (blocker_id, blocked_id) do nothing;
end $$;
revoke execute on function public.block_author(text, bigint) from public, anon, authenticated;
grant execute on function public.block_author(text, bigint) to authenticated;

create or replace function public.list_my_blocks()
returns table (block_id uuid, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select b.id, b.created_at from private.blocks b where b.blocker_id = auth.uid()
  order by b.created_at desc;
$$;
revoke execute on function public.list_my_blocks() from public, anon, authenticated;
grant execute on function public.list_my_blocks() to authenticated;

create or replace function public.unblock_author(p_block_id uuid)
returns void language sql security definer set search_path = '' as $$
  delete from private.blocks where id = p_block_id and blocker_id = auth.uid();
$$;
revoke execute on function public.unblock_author(uuid) from public, anon, authenticated;
grant execute on function public.unblock_author(uuid) to authenticated;

-- 신고 (r2): verified + sanction ∈ {none, write_restricted}만, 대상 존재·상태 검증
create or replace function public.submit_report(p_target_type text, p_target_id bigint,
                                                p_reason_code text, p_detail text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_case bigint; v_ok boolean;
begin
  perform 1 from private.members m where m.id = auth.uid()
    and m.nickname is not null and m.verification_status = 'verified'
    and m.sanction in ('none','write_restricted');                  -- 신고는 write_restricted도 가능 (권한표)
  if not found then raise exception 'not allowed'; end if;
  -- r3 (GPT 3차 §2): 신고 대상도 호출자 가시성 기준으로 검증
  if p_target_type = 'post' then
    v_ok := authz.post_visible_to_me(p_target_id);
  elsif p_target_type = 'comment' then
    v_ok := exists (select 1 from public.comments c where c.id = p_target_id
                    and c.deleted_at is null and c.hidden_at is null
                    and authz.post_visible_to_me(c.post_id));
  else raise exception 'invalid type'; end if;
  if not v_ok then raise exception 'not reportable'; end if;
  if char_length(coalesce(p_detail,'')) > 500 then raise exception 'detail too long'; end if;

  select c.id into v_case from private.moderation_cases c
    where c.target_type = p_target_type and c.target_id = p_target_id and c.status = 'open';
  if v_case is null then
    begin
      insert into private.moderation_cases (target_type, target_id, emergency)
        values (p_target_type, p_target_id, p_reason_code in ('privacy','obscene_illegal'))
        returning id into v_case;
    exception when unique_violation then
      select c.id into v_case from private.moderation_cases c
        where c.target_type = p_target_type and c.target_id = p_target_id and c.status = 'open';
    end;
  end if;
  insert into private.reports (case_id, reporter_id, reason_code, detail)
    values (v_case, auth.uid(), p_reason_code, nullif(p_detail, ''))
    on conflict (case_id, reporter_id) do nothing;
  if found then                                                      -- 실제 insert된 경우만 +1
    update private.moderation_cases set report_count = report_count + 1,
      emergency = emergency or p_reason_code in ('privacy','obscene_illegal')
      where id = v_case;
  end if;
end $$;
revoke execute on function public.submit_report(text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.submit_report(text, bigint, text, text) to authenticated;

-- ------------------------------------------------------------
-- 6. 신원 — 트랙 B (r2: public 얇은 래퍼(service_role) → private impl 통일)
-- ------------------------------------------------------------
create or replace function private.begin_verification_impl(
  p_member_id uuid, p_hmacs text[], p_key_vers smallint[], p_current_ver smallint,
  p_real_name text, p_doc_type text, p_storage_path text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint; v_n int; i int; v_cur_idx int;
begin
  -- 배열 검증 (r2 — GPT §8)
  v_n := coalesce(array_length(p_hmacs,1), 0);
  if v_n = 0 or v_n > 10 then raise exception 'bad input'; end if;
  if array_length(p_key_vers,1) is distinct from v_n then raise exception 'bad input'; end if;
  if (select count(distinct v) from unnest(p_key_vers) v) <> v_n then raise exception 'bad input'; end if;
  for i in 1..v_n loop
    if p_key_vers[i] is null or p_key_vers[i] < 1 then raise exception 'bad input'; end if;
    if p_hmacs[i] !~ '^[0-9a-f]{64}$' then raise exception 'bad input'; end if;
  end loop;
  v_cur_idx := array_position(p_key_vers, p_current_ver);
  if v_cur_idx is null then raise exception 'bad input'; end if;      -- 저장할 현재 버전 쌍 명확화

  perform 1 from private.members m where m.id = p_member_id
    and m.verification_status in ('pending','rejected') and m.sanction <> 'banned'
    for update;
  if not found then raise exception 'not eligible'; end if;

  for i in 1..v_n loop                                                -- 전 버전 대조
    perform 1 from private.school_identities s
      where s.hmac_key_version = p_key_vers[i] and s.student_no_hmac = p_hmacs[i] and s.revoked_at is null;
    if found then raise exception 'unverifiable student number'; end if;
    perform 1 from private.enforcement_holds h
      where h.hmac_key_version = p_key_vers[i] and h.student_no_hmac = p_hmacs[i];
    if found then raise exception 'unverifiable student number'; end if;
  end loop;

  insert into private.verification_requests
    (member_id, doc_type, real_name, student_no_hmac, hmac_key_version, storage_path, status)
  values (p_member_id, p_doc_type, p_real_name, p_hmacs[v_cur_idx], p_current_ver,
          p_storage_path, 'uploading')
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.begin_verification(
  p_member_id uuid, p_hmacs text[], p_key_vers smallint[], p_current_ver smallint,
  p_real_name text, p_doc_type text, p_storage_path text)
returns bigint language sql security definer set search_path = '' as $$
  select private.begin_verification_impl(p_member_id, p_hmacs, p_key_vers, p_current_ver,
                                         p_real_name, p_doc_type, p_storage_path);
$$;
revoke execute on function public.begin_verification(uuid, text[], smallint[], smallint, text, text, text)
  from public, anon, authenticated;
grant execute on function public.begin_verification(uuid, text[], smallint[], smallint, text, text, text)
  to service_role;

create or replace function private.finalize_verification_impl(p_member_id uuid, p_request_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from private.members m where m.id = p_member_id for update;
  if not found then raise exception 'no member'; end if;
  update private.verification_requests
    set status = 'submitted', submitted_at = now()
    where id = p_request_id and member_id = p_member_id and status = 'uploading';
  if not found then raise exception 'not uploading'; end if;
  update private.members set verification_status = 'submitted' where id = p_member_id;
  insert into private.member_status_history (member_id, changed_field, old_value, new_value, reason)
    values (p_member_id, 'verification_status', 'pending', 'submitted', 'verification submitted');
end $$;

create or replace function public.finalize_verification(p_member_id uuid, p_request_id bigint)
returns void language sql security definer set search_path = '' as $$
  select private.finalize_verification_impl(p_member_id, p_request_id);
$$;
revoke execute on function public.finalize_verification(uuid, bigint) from public, anon, authenticated;
grant execute on function public.finalize_verification(uuid, bigint) to service_role;

create or replace function public.get_my_verification_requests()
returns table (id bigint, doc_type text, status text, submitted_at timestamptz,
               reviewed_at timestamptz, reject_reason_code text, purged boolean)
language sql stable security definer set search_path = '' as $$
  select r.id, r.doc_type, r.status, r.submitted_at, r.reviewed_at, r.reject_reason_code,
         (r.purged_at is not null)
  from private.verification_requests r where r.member_id = auth.uid()
  order by r.created_at desc;
$$;
revoke execute on function public.get_my_verification_requests() from public, anon, authenticated;
grant execute on function public.get_my_verification_requests() to authenticated;

-- 철회 (r2: uploading·submitted 어느 쪽이든 결과 일관 — pending 확인+deadline 동일 적용)
create or replace function public.withdraw_verification(p_request_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from private.members m where m.id = auth.uid() for update;
  update private.verification_requests
    set status = 'withdrawn', purge_after = now()
    where id = p_request_id and member_id = auth.uid() and status in ('uploading','submitted');
  if not found then raise exception 'not withdrawable'; end if;
  update private.members
    set verification_status = 'pending', verification_deadline = now() + interval '7 days'
    where id = auth.uid() and verification_status in ('pending','submitted');
end $$;
revoke execute on function public.withdraw_verification(bigint) from public, anon, authenticated;
grant execute on function public.withdraw_verification(bigint) to authenticated;

-- ------------------------------------------------------------
-- 7. 심사 헬퍼 (모더레이션 본문은 003b r2)
-- ------------------------------------------------------------
create or replace function private.actor_role_check(p_min text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_role text;
begin
  select m.role into v_role from private.members m
    where m.id = auth.uid() and m.nickname is not null
      and m.verification_status = 'verified' and m.sanction = 'none';
  if v_role is null then raise exception 'not allowed'; end if;
  if p_min = 'moderator' and v_role not in ('moderator','operator','owner') then raise exception 'not allowed'; end if;
  if p_min = 'operator'  and v_role not in ('operator','owner') then raise exception 'not allowed'; end if;
  if p_min = 'owner'     and v_role <> 'owner' then raise exception 'not allowed'; end if;
  return v_role;
end $$;

create or replace function private.target_within_limit(p_actor_role text, p_target_role text)
returns boolean language sql immutable set search_path = '' as $$
  select case p_actor_role
    when 'moderator' then p_target_role = 'member'
    when 'operator'  then p_target_role in ('member','moderator')
    when 'owner'     then p_target_role in ('member','moderator','operator')
    else false end;
$$;

create or replace function public.list_verification_requests()
returns table (id bigint, doc_type text, status text, submitted_at timestamptz, real_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.actor_role_check('operator');
  return query select r.id, r.doc_type, r.status, r.submitted_at, r.real_name
    from private.verification_requests r where r.status = 'submitted'
    order by r.submitted_at;
end $$;
revoke execute on function public.list_verification_requests() from public, anon, authenticated;
grant execute on function public.list_verification_requests() to authenticated;

create or replace function public.review_verification(p_request_id bigint, p_approve boolean, p_reject_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_req private.verification_requests%rowtype;
begin
  perform private.actor_role_check('operator');
  select * into v_req from private.verification_requests
    where id = p_request_id and status = 'submitted' for update;
  if not found then raise exception 'not reviewable'; end if;
  if v_req.member_id = auth.uid() then raise exception 'self review'; end if;
  perform 1 from private.members where id = v_req.member_id for update;   -- r2: 대상 행 잠금
  if p_approve then
    insert into private.school_identities (member_id, real_name, student_no_hmac, hmac_key_version)
      values (v_req.member_id, v_req.real_name, v_req.student_no_hmac, v_req.hmac_key_version);
    update private.verification_requests
      set status = 'approved', reviewed_at = now(), reviewer_id = auth.uid(),
          purge_after = now() + interval '7 days'
      where id = p_request_id;
    update private.members set verification_status = 'verified' where id = v_req.member_id;
    insert into private.member_status_history (member_id, changed_field, old_value, new_value, actor_id)
      values (v_req.member_id, 'verification_status', 'submitted', 'verified', auth.uid());
    insert into public.operational_messages (member_id, kind, title, body)
      values (v_req.member_id, 'verification_approved', '학생 인증 승인', '학생 인증이 승인되었습니다.');
  else
    if p_reject_code is null then raise exception 'reject code required'; end if;
    update private.verification_requests
      set status = 'rejected', reviewed_at = now(), reviewer_id = auth.uid(),
          reject_reason_code = p_reject_code, purge_after = now() + interval '7 days'
      where id = p_request_id;
    update private.members set verification_status = 'rejected',
      verification_deadline = now() + interval '7 days' where id = v_req.member_id;
    insert into private.member_status_history (member_id, changed_field, old_value, new_value, actor_id, reason)
      values (v_req.member_id, 'verification_status', 'submitted', 'rejected', auth.uid(), p_reject_code);
    insert into public.operational_messages (member_id, kind, title, body)
      values (v_req.member_id, 'verification_rejected', '학생 인증 반려',
              '학생 인증이 반려되었습니다. 7일 내 재제출해 주세요.');
  end if;
end $$;
revoke execute on function public.review_verification(bigint, boolean, text) from public, anon, authenticated;
grant execute on function public.review_verification(bigint, boolean, text) to authenticated;

-- ------------------------------------------------------------
-- 8. 미리보기 claim (r2 — advisory lock 방식·형식 검증·이중 증가 방지)
-- ------------------------------------------------------------
create or replace function private.claim_guest_read_impl(p_cookie_hmac text, p_ip_hmac text,
                                                         p_post_id bigint, p_ip_cap int)
returns table (allowed boolean, reason text, title text, body text, author_display text,
               created_at timestamptz, comment_count int, vote_count int, view_count int,
               comments_json jsonb)
language plpgsql security definer set search_path = '' as $$
declare v_date date; v_post public.posts%rowtype; v_board text;
        v_new boolean := false; v_cnt int; v_ipcnt int;
begin
  v_date := (now() at time zone 'Asia/Seoul')::date;
  if p_cookie_hmac !~ '^[0-9a-f]{64}$' then raise exception 'bad cookie'; end if;    -- r2
  if p_ip_hmac is not null and p_ip_hmac !~ '^[0-9a-f]{64}$' then raise exception 'bad ip'; end if;
  if p_ip_cap is null or p_ip_cap < 1 or p_ip_cap > 100000 then raise exception 'bad cap'; end if;

  select p.* into v_post from public.posts p where p.id = p_post_id
    and p.deleted_at is null and p.hidden_at is null;
  if not found then return query select false, 'not_available', null::text, null::text, null::text,
    null::timestamptz, null::int, null::int, null::int, null::jsonb; return; end if;
  select b.access into v_board from public.boards b where b.id = v_post.board_id;
  if v_board <> 'preview' then return query select false, 'not_available', null::text, null::text,
    null::text, null::timestamptz, null::int, null::int, null::int, null::jsonb; return; end if;

  -- 쿠키+날짜 단위 트랜잭션 advisory lock (r2 — count(*) for update 폐기)
  perform pg_advisory_xact_lock(hashtextextended(p_cookie_hmac || v_date::text, 42));

  perform 1 from private.guest_reads g
    where g.cookie_hmac = p_cookie_hmac and g.post_id = p_post_id and g.read_date = v_date;
  if not found then
    select count(*) into v_cnt from private.guest_reads g
      where g.cookie_hmac = p_cookie_hmac and g.read_date = v_date;
    if v_cnt >= 3 then return query select false, 'quota', null::text, null::text, null::text,
      null::timestamptz, null::int, null::int, null::int, null::jsonb; return; end if;
    if p_ip_hmac is not null then                                     -- 백스톱: 파싱 실패 시 생략
      insert into private.guest_ip_daily (ip_hmac, read_date, count) values (p_ip_hmac, v_date, 1)
        on conflict (ip_hmac, read_date) do update set count = private.guest_ip_daily.count + 1
        returning count into v_ipcnt;
      if v_ipcnt > p_ip_cap then
        -- cap 초과: 이번 증가는 유효 카운트로 남되 read는 기록하지 않음 (초과 시도 자체가 신호)
        return query select false, 'quota', null::text, null::text, null::text,
          null::timestamptz, null::int, null::int, null::int, null::jsonb; return;
      end if;
    end if;
    insert into private.guest_reads (cookie_hmac, post_id, read_date, expires_at)
      values (p_cookie_hmac, p_post_id, v_date, now() + interval '48 hours');
    v_new := true;                                                    -- advisory lock 하 재확인이므로 충돌 없음
    update public.posts set view_count = view_count + 1 where id = p_post_id;
  end if;

  return query select true, null::text, v_post.title, v_post.body,
    case when v_post.author_withdrawn_at is not null then '탈퇴한 사용자'
         when v_post.is_anonymous then '익명'
         else coalesce(v_post.author_nickname, '알 수 없음') end,
    v_post.created_at, v_post.comment_count, v_post.vote_count,
    v_post.view_count + (case when v_new then 1 else 0 end),
    (select coalesce(jsonb_agg(jsonb_build_object(
        'body', c.body,
        'author', case when c.author_withdrawn_at is not null then '탈퇴한 사용자'
                       when c.is_anonymous then '익명' || coalesce(c.anon_alias_no::text, '')
                       else coalesce(c.author_nickname, '알 수 없음') end,
        'created_at', c.created_at)), '[]'::jsonb)
     from (select * from public.comments c where c.post_id = p_post_id
             and c.deleted_at is null and c.hidden_at is null
           order by c.id desc limit 3) c);
end $$;

create or replace function public.claim_guest_read(p_cookie_hmac text, p_ip_hmac text,
                                                   p_post_id bigint, p_ip_cap int)
returns table (allowed boolean, reason text, title text, body text, author_display text,
               created_at timestamptz, comment_count int, vote_count int, view_count int,
               comments_json jsonb)
language sql security definer set search_path = '' as $$
  select * from private.claim_guest_read_impl(p_cookie_hmac, p_ip_hmac, p_post_id, p_ip_cap);
$$;
revoke execute on function public.claim_guest_read(text, text, bigint, int) from public, anon, authenticated;
grant execute on function public.claim_guest_read(text, text, bigint, int) to service_role;

commit;
