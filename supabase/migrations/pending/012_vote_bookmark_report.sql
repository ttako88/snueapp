-- ============================================================
-- 012_vote_bookmark_report.sql — 추천/반대 · 스크랩 · 신고
--
-- ⚠️ PENDING 초안. 운영·dev 미적용. 동결 RC(001~009) 무접촉.
--
-- 002에 post_votes·bookmarks·private.reports 테이블은 이미 있지만 **RPC가 하나도 없어서**
-- 실제로는 쓸 수 없는 상태였다. 여기서 동작을 붙인다.
--
-- 발견한 구조적 문제 2가지와 처리:
--  ① post_votes에 방향 컬럼이 없다 → value(-1/1) 추가. 기존 행은 전부 추천(1)으로 본다.
--  ② posts.vote_count에 `check (vote_count >= 0)`가 걸려 있어 **순점수(추천-반대)를
--     여기 담을 수 없다.** 순점수는 음수가 되기 때문. → down_count를 따로 두고
--     vote_count는 "추천 수"로 유지한다(기존 제약·데이터와 충돌 없음).
--
-- 정책 근거: DATA_AND_MODERATION_CHARTER (자동제재 금지·인간검토·사건중심 모더레이션)
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. 추천/반대
-- ------------------------------------------------------------
alter table public.post_votes
  add column if not exists value smallint not null default 1 check (value in (-1, 1));

alter table public.posts
  add column if not exists down_count int not null default 0 check (down_count >= 0);

-- 카운터는 서버에서만 움직인다 (감사보고서 R7 — 클라이언트 카운터 쓰기 금지)
revoke update (vote_count, down_count) on public.posts from authenticated;
revoke insert, update, delete on public.post_votes from authenticated;
revoke insert, delete on public.bookmarks from authenticated;

-- ★ 003의 post_votes_after_change 트리거를 방향 인식 버전으로 교체한다.
--   기존 트리거의 문제:
--     ① value 컬럼이 없던 시절에 만들어져 **반대표도 추천으로 +1** 한다.
--     ② INSERT/DELETE만 처리해서 추천↔반대 **전환(UPDATE)에 반응하지 않는다.**
--   카운터의 주인을 트리거 하나로 두고 RPC는 투표 행만 다룬다
--   (RPC가 따로 카운터를 만지면 트리거와 이중 계산된다 — dev 실측으로 확인).
--   003 파일 자체는 건드리지 않는다. 증분 마이그레이션으로 덮어쓰는 방식.
drop trigger if exists post_votes_after_change on public.post_votes;

create or replace function private.sync_post_vote_counts()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_up int := 0; v_down int := 0; v_post bigint;
begin
  if tg_op = 'INSERT' then
    v_post := new.post_id;
    if new.value = 1 then v_up := 1; else v_down := 1; end if;
  elsif tg_op = 'DELETE' then
    v_post := old.post_id;
    if old.value = 1 then v_up := -1; else v_down := -1; end if;
  else  -- UPDATE (추천↔반대 전환)
    v_post := new.post_id;
    v_up   := (case when new.value = 1 then 1 else 0 end) - (case when old.value = 1 then 1 else 0 end);
    v_down := (case when new.value = -1 then 1 else 0 end) - (case when old.value = -1 then 1 else 0 end);
  end if;

  update public.posts p
     set vote_count = greatest(p.vote_count + v_up, 0),
         down_count = greatest(p.down_count + v_down, 0)
   where p.id = v_post;

  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke execute on function private.sync_post_vote_counts() from public, anon, authenticated;

create trigger post_votes_sync_counts
  after insert or update or delete on public.post_votes
  for each row execute function private.sync_post_vote_counts();

-- p_value: 1=추천, -1=반대, 0=취소. 같은 값을 다시 누르면 취소로 본다(토글).
create or replace function public.vote_post(p_post_id bigint, p_value smallint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_prev   smallint;
  v_new    smallint;
  v_post   public.posts%rowtype;
begin
  if not authz.is_writable_member() then raise exception 'not allowed'; end if;
  if p_value not in (-1, 0, 1) then raise exception 'invalid value'; end if;

  -- (REQUIRED-012-1) deleted/hidden만 보면 ID를 추측해 **접근 불가 게시판·차단한
  -- 작성자의 글**에도 투표할 수 있다. 기존 가시성 헬퍼를 그대로 쓴다.
  if not authz.post_visible_to_me(p_post_id) then raise exception 'not found'; end if;
  select * into v_post from public.posts p where p.id = p_post_id;

  -- 자기 글에는 투표하지 않는다 (자가 추천 어뷰징 차단)
  if exists (select 1 from public.post_owners o
              where o.post_id = p_post_id and o.user_id = auth.uid()) then
    raise exception 'cannot vote on own post';
  end if;

  -- 같은 행을 동시에 두 번 누르는 경합 방지
  select v.value into v_prev from public.post_votes v
   where v.post_id = p_post_id and v.member_id = auth.uid() for update;

  v_new := p_value;
  if v_prev is not null and v_prev = p_value then v_new := 0; end if;  -- 토글 취소

  if v_new = 0 then
    delete from public.post_votes v where v.post_id = p_post_id and v.member_id = auth.uid();
  else
    insert into public.post_votes (post_id, member_id, value)
    values (p_post_id, auth.uid(), v_new)
    on conflict (post_id, member_id) do update set value = excluded.value;
  end if;

  -- 카운터는 건드리지 않는다 — post_votes_sync_counts 트리거가 유일한 주인이다.
  -- (여기서 또 더하면 트리거와 이중 계산된다)
  select * into v_post from public.posts p where p.id = p_post_id;
  return jsonb_build_object('my_vote', v_new, 'up', v_post.vote_count, 'down', v_post.down_count);
end $$;
revoke execute on function public.vote_post(bigint, smallint) from public, anon, authenticated;
grant  execute on function public.vote_post(bigint, smallint) to authenticated;

-- ------------------------------------------------------------
-- 2. 스크랩 (토글)
-- ------------------------------------------------------------
create or replace function public.toggle_bookmark(p_post_id bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_exists boolean;
begin
  if not authz.is_writable_member() then raise exception 'not allowed'; end if;
  -- (REQUIRED-012-1) 투표와 같은 이유로 가시성 헬퍼를 쓴다
  if not authz.post_visible_to_me(p_post_id) then raise exception 'not found'; end if;

  delete from public.bookmarks b
   where b.member_id = auth.uid() and b.post_id = p_post_id
  returning true into v_exists;

  if v_exists is null then
    insert into public.bookmarks (member_id, post_id) values (auth.uid(), p_post_id)
      on conflict do nothing;
    return jsonb_build_object('bookmarked', true);
  end if;
  return jsonb_build_object('bookmarked', false);
end $$;
revoke execute on function public.toggle_bookmark(bigint) from public, anon, authenticated;
grant  execute on function public.toggle_bookmark(bigint) to authenticated;

-- 내 스크랩 목록
--  · (REQUIRED-012-1) 각 글이 지금도 나에게 보이는지 post_visible_to_me로 확인한다.
--    안 그러면 community_suspended·banned 상태에서 북마크 목록으로 제목을 우회 열람하거나,
--    접근 권한이 사라진 게시판의 글이 계속 보인다.
--  · (FOLLOW-UP) 커서는 (bookmarked_at, post_id) 복합 — 같은 시각 행이 페이지 경계에서
--    누락되는 것을 막는다. p_limit은 1~100으로 정규화.
create or replace function public.list_my_bookmarks(
  p_limit int default 50,
  p_before timestamptz default null,
  p_before_post bigint default null)
returns table (post_id bigint, board_slug text, title text, author_nickname text,
               comment_count int, created_at timestamptz, bookmarked_at timestamptz)
language sql security definer set search_path='' stable as $$
  select p.id, b.slug, p.title, p.author_nickname, p.comment_count, p.created_at, bm.created_at
    from public.bookmarks bm
    join public.posts  p on p.id = bm.post_id
    join public.boards b on b.id = p.board_id
   where bm.member_id = auth.uid()
     and authz.is_active_member()
     and authz.post_visible_to_me(p.id)
     and (p_before is null
          or bm.created_at < p_before
          or (bm.created_at = p_before and p_before_post is not null and p.id < p_before_post))
   order by bm.created_at desc, p.id desc
   limit greatest(least(coalesce(p_limit, 50), 100), 1);
$$;
revoke execute on function public.list_my_bookmarks(int, timestamptz, bigint) from public, anon, authenticated;
grant  execute on function public.list_my_bookmarks(int, timestamptz, bigint) to authenticated;

-- ------------------------------------------------------------
-- 3. 신고
--    사건(moderation_cases) 중심 구조. 같은 대상의 열린 사건에 신고가 쌓인다.
--
--    자동 숨김 정책 (헌장 §6 "자동제재 금지"와의 관계):
--      · 회원 제재는 절대 자동으로 하지 않는다. 여기서 하는 건 **콘텐츠 임시 숨김**뿐이고
--        운영자 검토 전까지의 잠정 조치다.
--      · 긴급 사유(개인정보·불법/음란)는 즉시 임시 숨김 — 피해가 되돌릴 수 없는 종류라서.
--      · 그 외는 신고 1건으로 숨기지 않는다(보복신고 방지). 서로 다른 인증회원
--        3명 이상일 때만 임시 숨김.
-- ------------------------------------------------------------
-- ⚠️ public.submit_report는 **이미 003(동결 RC)에 있고 여기서 다시 만들지 않는다.**
--    기존 구현이 더 낫다: authz.post_visible_to_me로 가시성까지 검증하고,
--    write_restricted 회원도 신고할 수 있게 허용한다(권한표 12.8 — 신고는 제재 중에도 가능).
--    동결 파일은 재개봉하지 않으므로, **새 정책은 트리거로 붙인다.**
--    이렇게 하면 어떤 경로로 신고가 들어와도 정책이 동일하게 적용된다.
-- (REQUIRED-012-6) 운영자가 "왜 숨겨졌는지"를 사건 화면에서 볼 수 있어야 한다.
-- audit_logs만 남기면 moderator용 get_case에서 원인을 못 본다.
-- (REQUIRED-012-N4) 복구해도 "언제·왜 숨겨졌고 누가 어떻게 판단했는지"는 남겨야 한다.
-- 검토 결과는 지우는 게 아니라 덧붙인다. 사건을 dismissed로 닫으면 그 사건에는
-- 새 신고가 붙지 않으므로(새 신고는 새 open case), 이력을 지워야 재숨김이 막히는 게 아니다.
alter table private.moderation_cases
  add column if not exists auto_hidden_at timestamptz,
  add column if not exists auto_hide_kind text check (auto_hide_kind in ('emergency','threshold')),
  add column if not exists auto_hide_reviewed_at timestamptz,
  add column if not exists auto_hide_decision text check (auto_hide_decision in ('restored','kept_hidden'));

-- (REQUIRED-012-N10) 네 컬럼이 독립 nullable이면 "kind 없이 auto_hidden_at만",
-- "reviewed_at 없이 decision만", "restored인데 status=resolved" 같은 상태가 생긴다.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'moderation_cases_auto_hide_consistent'
                    and conrelid = 'private.moderation_cases'::regclass) then
    alter table private.moderation_cases add constraint moderation_cases_auto_hide_consistent check (
      (auto_hidden_at is null) = (auto_hide_kind is null)
      and (auto_hide_reviewed_at is null) = (auto_hide_decision is null)
      and (auto_hide_decision is null or auto_hidden_at is not null)
      and (auto_hide_decision is distinct from 'restored'    or status = 'dismissed')
      and (auto_hide_decision is distinct from 'kept_hidden' or status = 'resolved')
    );
  end if;
end $$;

-- (REQUIRED-012-N8) 기존 close_case로 자동숨김 사건을 검토 없이 닫는 우회를 막는다.
-- UI가 아니라 DB가 모든 종결 경로를 통제하게 한다.
create or replace function private.guard_auto_hidden_case_close()
returns trigger language plpgsql set search_path='' as $$
begin
  if old.status = 'open' and old.auto_hidden_at is not null
     and new.status in ('resolved','dismissed')
     and (new.auto_hide_reviewed_at is null or new.auto_hide_decision is null) then
    raise exception 'auto-hidden case must be closed via resolve_auto_hidden_case';
  end if;
  return new;
end $$;
revoke execute on function private.guard_auto_hidden_case_close() from public, anon, authenticated;

drop trigger if exists moderation_cases_auto_hide_close on private.moderation_cases;
create trigger moderation_cases_auto_hide_close
  before update on private.moderation_cases
  for each row execute function private.guard_auto_hidden_case_close();

-- (REQUIRED-012-N7) 기존 moderate_content('restore'/'hide')가 자동숨김 콘텐츠를
-- 직접 건드리면 사건은 open인 채 콘텐츠만 바뀌어, 새 원자 경로를 우회한다.
-- 함수 본문을 복사해 재정의하는 대신(동결 RC 본문 중복 = 드리프트 위험),
-- **콘텐츠 쪽에 가드**를 걸고 정식 경로만 세션 플래그로 통과시킨다.
create or replace function private.guard_auto_hidden_content()
returns trigger language plpgsql set search_path='' as $$
declare v_open boolean;
begin
  if new.hidden_at is not distinct from old.hidden_at then return new; end if;
  -- resolve_auto_hidden_case가 세운 플래그면 통과
  if coalesce(current_setting('app.auto_hide_review', true), '') = '1' then return new; end if;
  select exists (
    select 1 from private.moderation_cases c
     where c.target_type = tg_argv[0] and c.target_id = old.id
       and c.status = 'open' and c.auto_hidden_at is not null) into v_open;
  if v_open then
    raise exception 'use resolve_auto_hidden_case for auto-hidden content';
  end if;
  return new;
end $$;
revoke execute on function private.guard_auto_hidden_content() from public, anon, authenticated;

drop trigger if exists posts_auto_hidden_guard on public.posts;
create trigger posts_auto_hidden_guard
  before update on public.posts
  for each row execute function private.guard_auto_hidden_content('post');

drop trigger if exists comments_auto_hidden_guard on public.comments;
create trigger comments_auto_hidden_guard
  before update on public.comments
  for each row execute function private.guard_auto_hidden_content('comment');

create or replace function private.apply_report_auto_hide()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_case      private.moderation_cases%rowtype;
  v_distinct  int;
  v_emergency boolean;
  v_recent    int;
  v_hidden    boolean := false;
  v_post      bigint;
  v_author    record;
begin
  -- (REQUIRED-012-N1) 잠그지 않고 세면, 세 명이 거의 동시에 신고할 때 각 트랜잭션이
  -- 서로의 미커밋 신고를 못 봐서 **최종 3건인데도 아무도 숨기지 않는** 일이 생긴다.
  -- 같은 신고자의 긴급 신고가 동시에 실행되면 일일 상한도 함께 통과한다.
  -- 잠금 순서를 사건 → 신고자로 고정한다(교착 방지).
  select * into v_case from private.moderation_cases c where c.id = new.case_id for update;
  if v_case.id is null then return new; end if;

  v_emergency := new.reason_code in ('privacy','obscene_illegal');
  if v_emergency and new.reporter_id is not null then
    perform 1 from private.members m where m.id = new.reporter_id for update;
  end if;

  -- (REQUIRED-012-3) 긴급 신고 악용 방지.
  --  ① 긴급 사유는 상세 설명이 있어야 한다 — 근거 없이 즉시 숨기는 버튼이 되면 안 된다.
  --  ② 한 신고자가 24시간에 일으킬 수 있는 긴급 자동숨김은 3건까지.
  --     초과분은 **사건에는 접수하되 자동숨김만 하지 않는다**(진짜 대량 유출을 발견한
  --     사람은 계속 신고할 수 있고, 운영진이 일괄 대응한다).
  if v_emergency then
    if new.detail is null or btrim(new.detail) = '' then
      raise exception 'emergency report requires detail';
    end if;
    select count(*) into v_recent
      from private.reports r
      join private.moderation_cases c2 on c2.id = r.case_id
     where r.reporter_id = new.reporter_id
       and r.reason_code in ('privacy','obscene_illegal')
       and r.created_at > now() - interval '24 hours'
       and r.id <> new.id
       and c2.auto_hide_kind = 'emergency';
    if v_recent >= 3 then
      v_emergency := false;   -- 접수는 하되 자동숨김은 하지 않음
    end if;
  end if;

  -- 일반 신고는 1건으로 숨기지 않는다(보복신고 방지). 서로 다른 인증회원 3명 이상.
  select count(distinct r.reporter_id) into v_distinct
    from private.reports r where r.case_id = new.case_id and r.reporter_id is not null;

  if not (v_emergency or v_distinct >= 3) then return new; end if;

  -- (REQUIRED-012-N9) owner가 쓴 콘텐츠는 자동숨김하지 않는다.
  -- Gate 3 불변조건이기도 하고, 1인 owner 운영기에는 self-target 금지 때문에
  -- **그 사건을 복구할 수 있는 사람이 아무도 없어진다.**
  -- 사건·신고는 정상 접수하고 우선검토 표시만 남긴다(실제 조치는 break-glass 정책).
  select * into v_author from private.content_author(v_case.target_type, v_case.target_id);
  if v_author.member_role = 'owner' then
    update private.moderation_cases c
       set emergency = c.emergency or v_emergency
     where c.id = v_case.id;
    insert into private.audit_logs (actor_id, action, target_type, target_id, case_id, reason)
    values (null, 'auto_hide:skipped_owner', v_case.target_type, v_case.target_id::text, v_case.id,
            'owner 콘텐츠는 자동숨김 대상 아님 — 우선 검토 필요');
    return new;
  end if;

  if v_case.target_type = 'post' then
    update public.posts p set hidden_at = clock_timestamp()
     where p.id = v_case.target_id and p.hidden_at is null;
    v_hidden := found;
  else
    -- (REQUIRED-012-2) 댓글도 같은 정책으로 보호한다. 개인정보가 담긴 댓글을
    -- 긴급 신고해도 자동 보호가 안 되던 구멍.
    update public.comments c set hidden_at = clock_timestamp()
     where c.id = v_case.target_id and c.hidden_at is null and c.deleted_at is null
    returning c.post_id into v_post;
    v_hidden := v_post is not null;
    -- 실제 null→hidden 전이일 때만 1회 감소 (중복 신고·이미 숨김이면 재감소 금지)
    if v_hidden then
      update public.posts p set comment_count = greatest(p.comment_count - 1, 0) where p.id = v_post;
    end if;
  end if;

  if v_hidden then
    update private.moderation_cases c
       set emergency = c.emergency or v_emergency,
           auto_hidden_at = clock_timestamp(),
           auto_hide_kind = case when v_emergency then 'emergency' else 'threshold' end
     where c.id = v_case.id;
    insert into private.audit_logs (actor_id, action, target_type, target_id, case_id, reason)
    values (null, 'auto_hide:' || case when v_emergency then 'emergency' else 'threshold' end,
            v_case.target_type, v_case.target_id::text, v_case.id,
            '자동 임시 숨김 — 운영자 검토 대기 (회원 제재 아님)');
  end if;
  return new;
end $$;
revoke execute on function private.apply_report_auto_hide() from public, anon, authenticated;

drop trigger if exists reports_auto_hide on private.reports;
create trigger reports_auto_hide
  after insert on private.reports
  for each row execute function private.apply_report_auto_hide();

-- ------------------------------------------------------------
-- 4. 자동숨김 사건의 복구·종결 (REQUIRED-012-4)
--    moderate_content('restore') 후 close_case('dismissed')를 따로 호출하면
--    그 사이에 새 신고가 들어와 다시 숨겨지는 경합이 생긴다. 특히 emergency가
--    true로 남아 있으면 일반 신고 한 건에도 재숨김된다.
--    → 복구와 종결을 한 트랜잭션으로 처리하는 전용 RPC.
--    이미 처리된 사건은 예외 없이 멱등 수렴한다.
-- ------------------------------------------------------------
create or replace function public.resolve_auto_hidden_case(
  p_case_id bigint, p_decision text, p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_role   text;
  v_case   private.moderation_cases%rowtype;
  v_post   bigint;
  v_author record;
begin
  -- (REQUIRED-012-N3) 기존 §6 권한 경계를 그대로 재사용한다.
  v_role := private.actor_role_check('moderator');
  if p_decision not in ('restore','keep_hidden') then raise exception 'invalid decision'; end if;
  -- (REQUIRED-012-N5) 사유도 다른 관리 함수와 같은 기준
  if p_reason is null or btrim(p_reason) = '' then raise exception 'reason required'; end if;
  if char_length(btrim(p_reason)) > 500 then raise exception 'reason too long'; end if;
  if p_reason ~ E'[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' then raise exception 'reason has control characters'; end if;

  select * into v_case from private.moderation_cases c where c.id = p_case_id for update;
  if v_case.id is null then raise exception 'not found'; end if;

  -- (REQUIRED-012-N2) 자동숨김 사건 전용이다. 일반 사건에 호출해 종결하거나
  -- 다른 경로로 숨겨진 콘텐츠를 복구하는 데 쓰이면 안 된다.
  if v_case.auto_hidden_at is null or v_case.auto_hide_kind is null then
    return jsonb_build_object('status','not_applicable');
  end if;

  -- (REQUIRED-012-N3) 자기 사건 처리 금지 + 대상 역할 상한.
  -- 탈퇴한 작성자(연결 없음)는 콘텐츠 판정만 허용한다.
  select * into v_author from private.content_author(v_case.target_type, v_case.target_id);
  if v_author.member_id is not null then
    if v_author.member_id = auth.uid() then
      raise exception 'cannot resolve your own case';
    end if;
    if not private.target_within_limit(v_role, v_author.member_role) then
      raise exception 'target role exceeds your limit';
    end if;
  end if;

  if v_case.status <> 'open' then
    return jsonb_build_object('status','already_resolved','case_status',v_case.status);  -- 멱등
  end if;

  -- 아래 콘텐츠 변경은 정식 검토 경로이므로 가드를 통과시킨다 (N7)
  perform set_config('app.auto_hide_review', '1', true);

  if p_decision = 'restore' then
    if v_case.target_type = 'post' then
      update public.posts p set hidden_at = null where p.id = v_case.target_id and p.hidden_at is not null;
    else
      update public.comments c set hidden_at = null
       where c.id = v_case.target_id and c.hidden_at is not null and c.deleted_at is null
      returning c.post_id into v_post;
      -- 실제 복구된 경우에만 정확히 1회 증가
      if v_post is not null then
        update public.posts p set comment_count = p.comment_count + 1 where p.id = v_post;
      end if;
    end if;
    -- (N4) 자동숨김 이력은 **지우지 않는다**. 검토 결과만 덧붙인다.
    update private.moderation_cases c
       set status = 'dismissed', closed_at = clock_timestamp(), closed_by = auth.uid(),
           emergency = false,
           auto_hide_reviewed_at = clock_timestamp(), auto_hide_decision = 'restored'
     where c.id = p_case_id;
  else
    -- (REQUIRED-012-N11) keep_hidden인데 콘텐츠가 이미 보이는 상태일 수 있다
    -- (다른 관리 경로·예외로 복구된 경우). 사건만 '숨김 유지'로 닫고 콘텐츠는
    -- 노출된 채 남는 모순을 막기 위해 같은 트랜잭션에서 다시 숨긴다.
    if v_case.target_type = 'post' then
      update public.posts p set hidden_at = clock_timestamp()
       where p.id = v_case.target_id and p.hidden_at is null and p.deleted_at is null;
    else
      update public.comments c set hidden_at = clock_timestamp()
       where c.id = v_case.target_id and c.hidden_at is null and c.deleted_at is null
      returning c.post_id into v_post;
      -- 실제 visible→hidden 전이일 때만 1회 감소
      if v_post is not null then
        update public.posts p set comment_count = greatest(p.comment_count - 1, 0) where p.id = v_post;
      end if;
    end if;
    update private.moderation_cases c
       set status = 'resolved', closed_at = clock_timestamp(), closed_by = auth.uid(),
           auto_hide_reviewed_at = clock_timestamp(), auto_hide_decision = 'kept_hidden'
     where c.id = p_case_id;
  end if;

  -- 플래그는 쓰자마자 내린다. set_config(local)은 **트랜잭션 끝까지** 유지되므로,
  -- 그대로 두면 같은 트랜잭션 안의 이후 직접 조작까지 가드를 통과해 버린다
  -- (dev 행동검증에서 실제로 재현됨).
  perform set_config('app.auto_hide_review', '0', true);

  insert into private.moderation_actions (case_id, action, actor_id, reason)
  values (p_case_id, case when p_decision = 'restore' then 'restore' else 'hide' end, auth.uid(), p_reason);
  insert into private.audit_logs (actor_id, action, target_type, target_id, case_id, reason)
  values (auth.uid(), 'auto_hide_review:' || p_decision, v_case.target_type,
          v_case.target_id::text, p_case_id, p_reason);

  return jsonb_build_object('status','ok','decision',p_decision);
end $$;
revoke execute on function public.resolve_auto_hidden_case(bigint, text, text)
  from public, anon, authenticated;
grant  execute on function public.resolve_auto_hidden_case(bigint, text, text) to authenticated;

-- ------------------------------------------------------------
-- 4-2. get_case에 자동숨김 정보 노출 (REQUIRED-012-N6)
--   audit_logs만 남기면 moderator 화면에서 "왜 숨겨졌는지"를 볼 수 없다.
--   반환 컬럼이 늘어나므로 create or replace로는 안 되고 drop 후 재생성해야 한다
--   (012에서 003 트리거를 교체한 것과 같은 "증분이 최종 상태를 만든다" 방식).
--   ★ 신고자 ID는 여전히 반환하지 않는다.
-- ------------------------------------------------------------
drop function if exists public.get_case(bigint);
create or replace function public.get_case(p_case_id bigint)
returns table (id bigint, target_type text, target_id bigint, status text, report_count int,
               emergency boolean, opened_at timestamptz,
               reports jsonb, actions jsonb, snapshot text,
               auto_hidden boolean, auto_hidden_at timestamptz, auto_hide_kind text,
               auto_hide_reviewed_at timestamptz, auto_hide_decision text,
               review_required boolean)
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
     order by s.captured_at desc limit 1),
    (c.auto_hidden_at is not null),
    c.auto_hidden_at, c.auto_hide_kind, c.auto_hide_reviewed_at, c.auto_hide_decision,
    (c.status = 'open' and c.auto_hidden_at is not null)
  from private.moderation_cases c where c.id = p_case_id;
end $$;
revoke execute on function public.get_case(bigint) from public, anon, authenticated;
grant execute on function public.get_case(bigint) to authenticated;

-- ------------------------------------------------------------
-- 5. 기존 카운터 드리프트 1회 재계산 (REQUIRED-012-5)
--    greatest(...,0)은 런타임 음수만 막고 과거에 어긋난 값은 복구하지 못한다.
--    기존 post_votes는 value 기본값 1로 이관되므로 여기서 실제 행 수로 맞춘다.
-- ------------------------------------------------------------
update public.posts p
   set vote_count = coalesce(v.up, 0),
       down_count = coalesce(v.down, 0)
  from (select pv.post_id,
               count(*) filter (where pv.value = 1)  up,
               count(*) filter (where pv.value = -1) down
          from public.post_votes pv group by pv.post_id) v
 where v.post_id = p.id
   and (p.vote_count is distinct from coalesce(v.up, 0)
     or p.down_count is distinct from coalesce(v.down, 0));

-- 투표 행이 하나도 없는 글은 카운터가 0이어야 한다
update public.posts p set vote_count = 0, down_count = 0
 where (p.vote_count <> 0 or p.down_count <> 0)
   and not exists (select 1 from public.post_votes pv where pv.post_id = p.id);

commit;

-- ============================================================
-- 다음 배치
--  · 화면(추천/반대 버튼·스크랩 버튼·신고 사유 시트·내 스크랩 페이지)
--  · 자동 임시 숨김 해제 경로 (운영자가 기각하면 hidden_at 복구) — 004 moderate_content와 연결
--  · 댓글 추천, 베스트글(HOT) 승격 기준
-- ============================================================
