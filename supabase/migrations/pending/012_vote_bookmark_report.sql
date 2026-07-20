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

  select * into v_post from public.posts p
   where p.id = p_post_id and p.deleted_at is null and p.hidden_at is null;
  if v_post.id is null then raise exception 'not found'; end if;

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
  if not exists (select 1 from public.posts p
                  where p.id = p_post_id and p.deleted_at is null and p.hidden_at is null) then
    raise exception 'not found';
  end if;

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

-- 내 스크랩 목록 (삭제·숨김된 글은 빼고)
create or replace function public.list_my_bookmarks(p_limit int default 50, p_before timestamptz default null)
returns table (post_id bigint, board_slug text, title text, author_nickname text,
               comment_count int, created_at timestamptz, bookmarked_at timestamptz)
language sql security definer set search_path='' stable as $$
  select p.id, b.slug, p.title, p.author_nickname, p.comment_count, p.created_at, bm.created_at
    from public.bookmarks bm
    join public.posts  p on p.id = bm.post_id
    join public.boards b on b.id = p.board_id
   where bm.member_id = auth.uid()
     and p.deleted_at is null and p.hidden_at is null
     and (p_before is null or bm.created_at < p_before)
   order by bm.created_at desc
   limit least(coalesce(p_limit, 50), 100);
$$;
revoke execute on function public.list_my_bookmarks(int, timestamptz) from public, anon, authenticated;
grant  execute on function public.list_my_bookmarks(int, timestamptz) to authenticated;

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
create or replace function private.apply_report_auto_hide()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_case      private.moderation_cases%rowtype;
  v_distinct  int;
  v_emergency boolean;
begin
  select * into v_case from private.moderation_cases c where c.id = new.case_id;
  if v_case.id is null then return new; end if;

  -- 긴급 사유는 되돌릴 수 없는 피해(개인정보·불법물)라 즉시 임시 숨김
  v_emergency := v_case.emergency or new.reason_code in ('privacy','obscene_illegal');

  -- 그 외는 신고 1건으로 숨기지 않는다(보복신고 방지).
  -- 서로 다른 인증회원 3명 이상일 때만.
  select count(distinct r.reporter_id) into v_distinct
    from private.reports r where r.case_id = new.case_id and r.reporter_id is not null;

  if v_case.target_type = 'post' and (v_emergency or v_distinct >= 3) then
    update public.posts p set hidden_at = coalesce(p.hidden_at, clock_timestamp())
     where p.id = v_case.target_id and p.hidden_at is null;
    if found then
      insert into private.audit_logs (actor_id, action, target_type, target_id, case_id, reason)
      values (null, 'auto_hide:' || case when v_emergency then 'emergency' else 'threshold' end,
              'post', v_case.target_id::text, v_case.id,
              '자동 임시 숨김 — 운영자 검토 대기 (회원 제재 아님)');
    end if;
  end if;
  return new;
end $$;
revoke execute on function private.apply_report_auto_hide() from public, anon, authenticated;

drop trigger if exists reports_auto_hide on private.reports;
create trigger reports_auto_hide
  after insert on private.reports
  for each row execute function private.apply_report_auto_hide();

commit;

-- ============================================================
-- 다음 배치
--  · 화면(추천/반대 버튼·스크랩 버튼·신고 사유 시트·내 스크랩 페이지)
--  · 자동 임시 숨김 해제 경로 (운영자가 기각하면 hidden_at 복구) — 004 moderate_content와 연결
--  · 댓글 추천, 베스트글(HOT) 승격 기준
-- ============================================================
