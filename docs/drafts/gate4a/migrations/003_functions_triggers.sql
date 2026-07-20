-- ============================================================
-- 003_functions_triggers.sql
-- DRAFT — NOT EXECUTED — NOT APPROVED FOR DEV APPLY
-- 근거: GATE3_DESIGN.md v1.3 §2(트랙 A/B), §3, §4, §5, §6, §8, §13
-- 구성: 1) 헬퍼  2) 함수 의존 RLS 정책  3) 트리거  4) 회원 RPC(트랙 A)
--       5) 상호작용 RPC  6) 신원 (트랙 B: begin/finalize)  7) 심사·모더레이션
--       8) 미리보기 claim  9) 내부 전이·배치 함수
-- 규칙: 전 함수 security definer + set search_path='' + returns table/스칼라 고정
--       + 생성 직후 revoke → 필요한 역할에만 grant (동일 트랜잭션)
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. 헬퍼 (stable, RLS USING에서 사용)
-- ------------------------------------------------------------
create or replace function public.is_active_member()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.members m
    where m.id = auth.uid()
      and m.nickname is not null                       -- 온보딩 완료
      and m.verification_status = 'verified'
      and m.sanction not in ('community_suspended','banned')
  );
$$;
revoke execute on function public.is_active_member() from public, anon, authenticated;
grant execute on function public.is_active_member() to authenticated;

create or replace function public.is_writable_member()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.members m
    where m.id = auth.uid()
      and m.nickname is not null
      and m.verification_status = 'verified'
      and m.sanction = 'none'                          -- write_restricted도 작성 불가
  );
$$;
revoke execute on function public.is_writable_member() from public, anon, authenticated;
grant execute on function public.is_writable_member() to authenticated;

-- 차단 필터 (§5.3 — content_type 시그니처 v1.3)
create or replace function public.is_blocked_author(p_content_type text, p_content_id bigint)
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
revoke execute on function public.is_blocked_author(text, bigint) from public, anon, authenticated;
grant execute on function public.is_blocked_author(text, bigint) to authenticated;

create or replace function public.board_access_ok(p_board_id smallint)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.boards b
    where b.id = p_board_id and b.access in ('preview','members'));  -- hidden 제외
$$;
revoke execute on function public.board_access_ok(smallint) from public, anon, authenticated;
grant execute on function public.board_access_ok(smallint) to authenticated;

-- ------------------------------------------------------------
-- 2. 함수 의존 RLS 정책 (002에서 정책 0 상태였던 것)
-- ------------------------------------------------------------
create policy boards_member_select on public.boards
  for select to authenticated
  using (access = 'preview' or (access = 'members' and public.is_active_member()));

create policy posts_select on public.posts
  for select to authenticated
  using (public.is_active_member() and deleted_at is null and hidden_at is null
         and public.board_access_ok(board_id)
         and not public.is_blocked_author('post', id));
create policy posts_insert on public.posts
  for insert to authenticated
  with check (public.is_writable_member() and public.board_access_ok(board_id));
create policy posts_update on public.posts
  for update to authenticated
  using (public.is_writable_member()
         and exists (select 1 from public.post_owners o where o.post_id = id and o.user_id = auth.uid()))
  with check (public.is_writable_member()
         and exists (select 1 from public.post_owners o where o.post_id = id and o.user_id = auth.uid()));

create policy comments_select on public.comments
  for select to authenticated
  using (public.is_active_member() and deleted_at is null and hidden_at is null
         and not public.is_blocked_author('comment', id)
         and exists (select 1 from public.posts p
                     where p.id = post_id and p.deleted_at is null and p.hidden_at is null
                       and public.board_access_ok(p.board_id)));
create policy comments_insert on public.comments
  for insert to authenticated
  with check (public.is_writable_member()
         and exists (select 1 from public.posts p
                     where p.id = post_id and p.deleted_at is null and p.hidden_at is null
                       and public.board_access_ok(p.board_id)));
create policy comments_update on public.comments
  for update to authenticated
  using (public.is_writable_member()
         and exists (select 1 from public.comment_owners o where o.comment_id = id and o.user_id = auth.uid()))
  with check (public.is_writable_member()
         and exists (select 1 from public.comment_owners o where o.comment_id = id and o.user_id = auth.uid()));

create policy post_votes_insert on public.post_votes
  for insert to authenticated
  with check (member_id = auth.uid() and public.is_writable_member()
         and exists (select 1 from public.posts p
                     where p.id = post_id and p.deleted_at is null and p.hidden_at is null
                       and public.board_access_ok(p.board_id)));
create policy post_votes_delete on public.post_votes
  for delete to authenticated
  using (member_id = auth.uid() and public.is_writable_member());

-- bookmarks insert/delete (GPT 검수 — 002는 본인 select만, 쓰기는 여기서 조건부)
create policy bookmarks_insert on public.bookmarks
  for insert to authenticated
  with check (member_id = auth.uid() and public.is_writable_member()
         and exists (select 1 from public.posts p
                     where p.id = post_id and p.deleted_at is null and p.hidden_at is null
                       and public.board_access_ok(p.board_id)));
create policy bookmarks_delete on public.bookmarks
  for delete to authenticated
  using (member_id = auth.uid() and public.is_writable_member());

-- ------------------------------------------------------------
-- 3. 트리거
-- ------------------------------------------------------------
-- 3.1 auth 가입 → members 자동 생성 (§3)
create or replace function private.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into private.members (id) values (new.id) on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

-- 3.2 posts insert: owners 기록·표시명 강제·별칭 0 (§5.2·§5.4)
create or replace function private.on_post_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_nick text;
begin
  -- 카운터·상태 컬럼은 클라이언트 입력 불신 — 서버가 결정
  new.comment_count := 0; new.vote_count := 0; new.view_count := 0;
  new.created_at := now(); new.updated_at := null;
  new.deleted_at := null; new.hidden_at := null; new.author_withdrawn_at := null;
  if new.is_anonymous then
    new.author_nickname := null;
  else
    select m.nickname into v_nick from private.members m where m.id = auth.uid();
    new.author_nickname := v_nick;                    -- 클라이언트 값 덮어쓰기
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

-- 3.3 posts update: 보호 컬럼 변경 거부 (soft delete는 같은 경로 허용)
create or replace function private.on_post_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.board_id <> old.board_id or new.created_at <> old.created_at
     or new.comment_count <> old.comment_count or new.vote_count <> old.vote_count
     or new.view_count <> old.view_count
     or new.is_anonymous <> old.is_anonymous
     or coalesce(new.author_nickname,'') <> coalesce(old.author_nickname,'')
     or new.hidden_at is distinct from old.hidden_at            -- 숨김은 definer만
     or new.author_withdrawn_at is distinct from old.author_withdrawn_at
  then raise exception 'protected column'; end if;
  if old.deleted_at is not null then raise exception 'already deleted'; end if;
  new.updated_at := now();
  return new;
end $$;
create trigger posts_before_update before update on public.posts
  for each row execute function private.on_post_update();
-- 주: definer 함수(모더레이션·탈퇴 파이프라인)의 정당한 변경은 session_replication_role
--     또는 별도 내부 update 경로로 우회 — 방식은 dev 리허설에서 확정 (TODO: 트리거 우회 전략)

-- 3.4 comments insert/update — posts와 동일 원칙 + 별칭 부여·comment_count
create or replace function private.on_comment_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_nick text; v_alias smallint;
begin
  new.created_at := now(); new.updated_at := null;
  new.deleted_at := null; new.hidden_at := null; new.author_withdrawn_at := null;
  if new.is_anonymous then
    new.author_nickname := null;
    -- 부모 글 행 잠금 후 별칭 부여 (§5.4 동시성)
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
  if new.post_id <> old.post_id or new.created_at <> old.created_at
     or new.is_anonymous <> old.is_anonymous
     or new.anon_alias_no is distinct from old.anon_alias_no
     or coalesce(new.author_nickname,'') <> coalesce(old.author_nickname,'')
     or new.hidden_at is distinct from old.hidden_at
     or new.author_withdrawn_at is distinct from old.author_withdrawn_at
  then raise exception 'protected column'; end if;
  if old.deleted_at is not null then raise exception 'already deleted'; end if;
  new.updated_at := now();
  return new;
end $$;
create trigger comments_before_update before update on public.comments
  for each row execute function private.on_comment_update();

-- 삭제 시 comment_count 감소는 soft delete update에서 처리: deleted_at 전이 감지
create or replace function private.on_comment_soft_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update public.posts set comment_count = greatest(comment_count - 1, 0) where id = new.post_id;
  end if;
  return new;
end $$;
-- 주: on_comment_update가 deleted 전이를 허용하도록 위 함수와 통합할지 dev에서 결정 (TODO)

-- 3.5 vote_count 동기 (원자적)
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

-- 닉네임 검증 공통 (§3): trim·빈문자 금지·NFC·연속공백 축약·제어문자 금지·금칙어
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
    where id = auth.uid() and nickname is null;      -- 최초 설정만. changed_at은 null 유지 (§3)
  if not found then raise exception 'nickname already set or no member'; end if;
exception when unique_violation then
  raise exception 'nickname in use';                  -- 일반 메시지 (§3)
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
-- 5. 상호작용 RPC (트랙 A)
-- ------------------------------------------------------------
create or replace function public.record_member_view(p_post_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_active_member() then return; end if;
  insert into private.post_views (post_id, member_id) values (p_post_id, auth.uid())
    on conflict do nothing;
  if found then
    update public.posts set view_count = view_count + 1 where id = p_post_id;
  end if;
end $$;
revoke execute on function public.record_member_view(bigint) from public, anon, authenticated;
grant execute on function public.record_member_view(bigint) to authenticated;

-- 차단 (§5.3): 대상 id는 내부 해석, 중복/신규 동일 응답
create or replace function public.block_author(p_content_type text, p_content_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare v_target uuid;
begin
  if not public.is_active_member() then raise exception 'not allowed'; end if;
  if p_content_type = 'post' then
    select o.user_id into v_target from public.post_owners o where o.post_id = p_content_id;
  elsif p_content_type = 'comment' then
    select o.user_id into v_target from public.comment_owners o where o.comment_id = p_content_id;
  else raise exception 'invalid type'; end if;
  if v_target is null then return; end if;            -- 탈퇴 작성자 등 — 동일한 조용한 성공
  if v_target = auth.uid() then raise exception 'cannot block self'; end if;
  insert into private.blocks (blocker_id, blocked_id) values (auth.uid(), v_target)
    on conflict (blocker_id, blocked_id) do nothing;  -- 중복도 동일 성공 (§5.3)
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

-- 신고 (§5.5): open 사건에 병합, unique 충돌은 조회 재시도
create or replace function public.submit_report(p_target_type text, p_target_id bigint,
                                                p_reason_code text, p_detail text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_case bigint;
begin
  if not public.is_active_member() then raise exception 'not allowed'; end if;
  if p_target_type not in ('post','comment') then raise exception 'invalid type'; end if;
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
  if found then
    update private.moderation_cases set report_count = report_count + 1,
      emergency = emergency or p_reason_code in ('privacy','obscene_illegal')
      where id = v_case;
  end if;
end $$;
revoke execute on function public.submit_report(text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.submit_report(text, bigint, text, text) to authenticated;

-- ------------------------------------------------------------
-- 6. 신원 — 트랙 B (EXECUTE=service_role만. p_member_id는 서버가 검증한 세션 subject)
-- ------------------------------------------------------------
-- begin_verification (§4.1 1단계): hold·기존 신원 대조 → uploading 생성. member 불변
create or replace function private.begin_verification(
  p_member_id uuid, p_hmacs text[], p_key_vers smallint[], p_current_ver smallint,
  p_real_name text, p_doc_type text, p_storage_path text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint; i int;
begin
  -- p_member_id 재검증 (§2 트랙 B)
  perform 1 from private.members m where m.id = p_member_id
    and m.verification_status in ('pending','rejected') and m.sanction <> 'banned'
    for update;
  if not found then raise exception 'not eligible'; end if;
  if array_length(p_hmacs,1) is distinct from array_length(p_key_vers,1)
     then raise exception 'bad input'; end if;
  -- 전 키버전 대조: school_identities + 활성 hold (§4.1)
  for i in 1..coalesce(array_length(p_hmacs,1),0) loop
    if char_length(p_hmacs[i]) <> 64 then raise exception 'bad hmac'; end if;
    perform 1 from private.school_identities s
      where s.hmac_key_version = p_key_vers[i] and s.student_no_hmac = p_hmacs[i] and s.revoked_at is null;
    if found then raise exception 'unverifiable student number'; end if;   -- 기존 계정 정보 비노출
    perform 1 from private.enforcement_holds h
      where h.hmac_key_version = p_key_vers[i] and h.student_no_hmac = p_hmacs[i];
    if found then raise exception 'unverifiable student number'; end if;   -- 동일 메시지 (§4.1)
    -- (released_at 폐기 — 테이블에는 활성 hold만 존재. GPT 검수 반영)
  end loop;
  insert into private.verification_requests
    (member_id, doc_type, real_name, student_no_hmac, hmac_key_version, storage_path, status)
  values (p_member_id, p_doc_type, p_real_name,
          p_hmacs[array_position(p_key_vers, p_current_ver)], p_current_ver,
          p_storage_path, 'uploading')
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function private.begin_verification(uuid, text[], smallint[], smallint, text, text, text)
  from public, anon, authenticated;
grant execute on function private.begin_verification(uuid, text[], smallint[], smallint, text, text, text)
  to service_role;

-- finalize_verification (§4.1 2단계): 서버가 Storage 재검증을 마친 뒤에만 호출
create or replace function private.finalize_verification(p_member_id uuid, p_request_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from private.members m where m.id = p_member_id for update;   -- 삭제 경합 잠금 (§4.1)
  if not found then raise exception 'no member'; end if;
  update private.verification_requests
    set status = 'submitted', submitted_at = now()
    where id = p_request_id and member_id = p_member_id and status = 'uploading';
  if not found then raise exception 'not uploading'; end if;
  update private.members set verification_status = 'submitted' where id = p_member_id;
  insert into private.member_status_history (member_id, changed_field, old_value, new_value, reason)
    values (p_member_id, 'verification_status', 'pending', 'submitted', 'verification submitted');
end $$;
revoke execute on function private.finalize_verification(uuid, bigint) from public, anon, authenticated;
grant execute on function private.finalize_verification(uuid, bigint) to service_role;

-- 본인 조회 (트랙 A — 7필드 §4.3)
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

-- 본인 철회 (트랙 A — §4.4)
create or replace function public.withdraw_verification(p_request_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  update private.verification_requests
    set status = 'withdrawn', purge_after = now()
    where id = p_request_id and member_id = auth.uid() and status in ('uploading','submitted')
    returning status into v_status;
  if not found then raise exception 'not withdrawable'; end if;
  update private.members set verification_status = 'pending',
    verification_deadline = now() + interval '7 days'
    where id = auth.uid() and verification_status = 'submitted';
end $$;
revoke execute on function public.withdraw_verification(bigint) from public, anon, authenticated;
grant execute on function public.withdraw_verification(bigint) to authenticated;

-- ------------------------------------------------------------
-- 7. 심사·모더레이션 (트랙 A — operator/owner. 대상 상한 매트릭스 §6)
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

-- 대상 상한 매트릭스 (§6 v1.3): 호출자 역할 → 조치 가능한 대상 역할
create or replace function private.target_within_limit(p_actor_role text, p_target_role text)
returns boolean language sql immutable set search_path = '' as $$
  select case p_actor_role
    when 'moderator' then p_target_role = 'member'
    when 'operator'  then p_target_role in ('member','moderator')
    when 'owner'     then p_target_role in ('member','moderator','operator')
    else false end;
$$;

-- 심사 목록·처리 (operator+). 원본 열람용 단기 signed URL은 서버 라우트 담당 (§4.3)
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
  if v_req.member_id = auth.uid() then raise exception 'self review'; end if;   -- self-target 금지
  if p_approve then
    -- 승인: identities 생성(unique가 동시 승인 최종 차단 §4.1) + verified 전이
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

-- moderate_content (moderator+): 숨김/복구/경고/1일 제한. 대상 id 미반환 (§6)
-- apply_sanction (operator+/owner), grant_role/revoke_role (owner), admin_reveal_author (operator+)
-- 구현 방침은 §6 매트릭스·§5.5 projection·감사 동일 트랜잭션. 상세 본문은 003 후속 검수분에서
-- 확정 (TODO: GPT 배치 검수 2차에서 본문 확정 — 시그니처·불변조건은 TEST_CONTRACT D그룹 참조)

-- ------------------------------------------------------------
-- 8. 미리보기 claim (§8 v1.3 — public 래퍼 + private 구현)
-- ------------------------------------------------------------
create or replace function private.claim_guest_read_impl(p_cookie_hmac text, p_ip_hmac text,
                                                         p_post_id bigint, p_ip_cap int)
returns table (allowed boolean, reason text, title text, body text, author_display text,
               created_at timestamptz, comment_count int, vote_count int, view_count int,
               comments_json jsonb)
language plpgsql security definer set search_path = '' as $$
declare v_date date; v_post public.posts%rowtype; v_board text; v_new boolean := false; v_cnt int;
begin
  v_date := (now() at time zone 'Asia/Seoul')::date;   -- read_date는 내부 결정 (v1.3)
  if p_ip_cap is null or p_ip_cap < 1 or p_ip_cap > 100000 then raise exception 'bad cap'; end if;
  -- 접근조건 직접 검증 (service_role은 RLS 우회 — §8 v1.3)
  select p.* into v_post from public.posts p where p.id = p_post_id
    and p.deleted_at is null and p.hidden_at is null;
  if not found then return query select false, 'not_available', null::text, null::text, null::text,
    null::timestamptz, null::int, null::int, null::int, null::jsonb; return; end if;
  select b.access into v_board from public.boards b where b.id = v_post.board_id;
  if v_board <> 'preview' then return query select false, 'not_available', null::text, null::text,
    null::text, null::timestamptz, null::int, null::int, null::int, null::jsonb; return; end if;

  -- 재열람: 무차감 허용
  perform 1 from private.guest_reads g
    where g.cookie_hmac = p_cookie_hmac and g.post_id = p_post_id and g.read_date = v_date;
  if not found then
    -- 신규: 쿠키 3글 + IP 캡 원자 확인 (잠금 하)
    select count(*) into v_cnt from private.guest_reads g
      where g.cookie_hmac = p_cookie_hmac and g.read_date = v_date for update;
    if v_cnt >= 3 then return query select false, 'quota', null::text, null::text, null::text,
      null::timestamptz, null::int, null::int, null::int, null::jsonb; return; end if;
    insert into private.guest_ip_daily (ip_hmac, read_date, count) values (p_ip_hmac, v_date, 1)
      on conflict (ip_hmac, read_date) do update set count = private.guest_ip_daily.count + 1
      returning count into v_cnt;
    if v_cnt > p_ip_cap then return query select false, 'quota', null::text, null::text, null::text,
      null::timestamptz, null::int, null::int, null::int, null::jsonb; return; end if;
    insert into private.guest_reads (cookie_hmac, post_id, read_date, expires_at)
      values (p_cookie_hmac, p_post_id, v_date, now() + interval '48 hours')
      on conflict do nothing;
    if found then v_new := true; end if;
  end if;
  if v_new then update public.posts set view_count = view_count + 1 where id = p_post_id; end if;

  -- 안전 payload (allowlist — §8): 탈퇴 작성자는 '탈퇴한 사용자'
  return query select true, null::text, v_post.title, v_post.body,
    case when v_post.author_withdrawn_at is not null then '탈퇴한 사용자'
         when v_post.is_anonymous then '익명'
         else coalesce(v_post.author_nickname, '알 수 없음') end,
    v_post.created_at, v_post.comment_count, v_post.vote_count, v_post.view_count + (case when v_new then 1 else 0 end),
    (select coalesce(jsonb_agg(jsonb_build_object(
        'body', c.body,
        'author', case when c.author_withdrawn_at is not null then '탈퇴한 사용자'
                       when c.is_anonymous then '익명' || coalesce(c.anon_alias_no::text, '')
                       else coalesce(c.author_nickname, '알 수 없음') end,
        'created_at', c.created_at)), '[]'::jsonb)
     from (select * from public.comments c where c.post_id = p_post_id
             and c.deleted_at is null and c.hidden_at is null
           order by c.id desc limit 3) c);   -- 최신 3개 (B안 §0)
end $$;
revoke execute on function private.claim_guest_read_impl(text, text, bigint, int) from public, anon, authenticated;
grant execute on function private.claim_guest_read_impl(text, text, bigint, int) to service_role;

-- public 래퍼 (v1.3 보완 — PostgREST 노출점. EXECUTE=service_role만)
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

-- ------------------------------------------------------------
-- 9. 내부 전이·배치 (트랙 B / pg_cron — 상세 본문은 2차 검수분)
-- ------------------------------------------------------------
-- transition_member_status / expire_sanctions / purge_soft_deleted_content /
-- purge_expired_holds / purge_expired_guest_reads / 계정 삭제 파이프라인 DB 부분(§13 ①~⑧)
-- TODO: 위 함수들의 확정 본문은 003 후속 검수분에서 — 불변조건은 GATE3 §9·§13,
--       테스트는 TEST_CONTRACT G·W그룹. (초안 분량 관리를 위해 2차 배치로 분리)

commit;
