-- ============================================================
-- 011_board_notice.sql — 게시판별 운영자 공지(상단 고정)
--
-- ⚠️ PENDING 초안. 운영·dev 미적용. 동결 RC(001~009) 무접촉.
--
-- 설계 판단: 별도 notices 테이블을 만들지 않고 **기존 posts에 핀을 단다.**
--   이유 — 공지도 글이다. 별도 테이블로 빼면 목록 조회·댓글·신고·숨김·검색을
--   전부 두 벌로 만들어야 하고, 두 경로의 권한 정책이 시간이 지나면 어긋난다.
--   (감사보고서 12.6 "같은 정책의 두 번째 소비자가 생길 때만 분리" 원칙)
--
-- 권한: operator/owner만. moderator는 불가 (권한표 12.8에서 공지는 운영 행위).
-- 모든 고정·해제는 audit_logs에 남는다.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. 컬럼 추가
-- ------------------------------------------------------------
alter table public.posts
  add column if not exists pinned_at    timestamptz,
  add column if not exists pinned_until timestamptz,
  add column if not exists pinned_by    uuid references private.members (id) on delete set null;

-- 고정 상태의 정합성: 고정이면 고정시각·고정자가 있어야 한다.
-- (pinned_by는 운영자 탈퇴 시 null이 될 수 있으므로 pinned_at만 기준으로 삼는다)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'posts_pin_consistent') then
    alter table public.posts add constraint posts_pin_consistent
      check (pinned_until is null or pinned_at is not null);
  end if;
end $$;

-- 목록에서 "고정 먼저, 그다음 최신순"을 싸게 뽑기 위한 부분 인덱스
create index if not exists posts_pinned_by_board
  on public.posts (board_id, pinned_at desc)
  where pinned_at is not null and deleted_at is null and hidden_at is null;

-- ------------------------------------------------------------
-- 2. 클라이언트 직접 수정 차단
--    007이 deleted_at을 막은 것과 같은 이유 — 고정은 운영 행위라
--    RLS로 "본인 글 수정" 경로를 타면 안 된다. RPC로만.
-- ------------------------------------------------------------
revoke update (pinned_at, pinned_until, pinned_by) on public.posts from authenticated;

-- ------------------------------------------------------------
-- 3. 공지 고정/해제 RPC (operator/owner 전용, 감사기록 필수)
--    p_pin=true  → 고정 (p_until이 null이면 무기한)
--    p_pin=false → 해제
-- ------------------------------------------------------------
create or replace function public.set_post_notice(
  p_post_id bigint, p_pin boolean, p_until timestamptz, p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare
  v_role     text;
  v_post     public.posts%rowtype;
  v_pinned   integer;
  v_max      constant integer := 5;   -- 게시판당 고정 상한 (공지가 목록을 삼키지 않게)
begin
  -- 행위자: verified + 제재 없음 + operator 이상
  select m.role into v_role
    from private.members m
   where m.id = auth.uid()
     and m.verification_status = 'verified'
     and m.sanction = 'none';
  if v_role is null or v_role not in ('operator', 'owner') then
    raise exception 'not allowed';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason required';   -- 운영 행위는 사유 없이 남기지 않는다
  end if;

  select * into v_post from public.posts p where p.id = p_post_id;
  if v_post.id is null then raise exception 'not found'; end if;

  if p_pin then
    -- 삭제·숨김된 글은 공지로 올리지 않는다
    if v_post.deleted_at is not null or v_post.hidden_at is not null then
      raise exception 'cannot pin removed post';
    end if;
    -- 익명 글은 공지로 쓰지 않는다 — 공지는 출처가 분명해야 한다
    if v_post.is_anonymous then
      raise exception 'cannot pin anonymous post';
    end if;
    if p_until is not null and p_until <= now() then
      raise exception 'pinned_until must be in the future';
    end if;

    select count(*) into v_pinned
      from public.posts p
     where p.board_id = v_post.board_id
       and p.pinned_at is not null
       and p.id <> p_post_id
       and p.deleted_at is null and p.hidden_at is null
       and (p.pinned_until is null or p.pinned_until > now());
    if v_pinned >= v_max then
      raise exception 'too many notices on this board (max %)', v_max;
    end if;

    update public.posts
       set pinned_at = clock_timestamp(), pinned_until = p_until, pinned_by = auth.uid()
     where id = p_post_id;
  else
    update public.posts
       set pinned_at = null, pinned_until = null, pinned_by = null
     where id = p_post_id;
  end if;

  insert into private.audit_logs (actor_id, action, target_type, target_id, reason)
  values (auth.uid(), case when p_pin then 'board_notice:pin' else 'board_notice:unpin' end,
          'post', p_post_id::text, p_reason);
end $$;
revoke execute on function public.set_post_notice(bigint, boolean, timestamptz, text)
  from public, anon, authenticated;
grant  execute on function public.set_post_notice(bigint, boolean, timestamptz, text) to authenticated;

-- ------------------------------------------------------------
-- 4. 만료된 고정 정리 (기한부 공지)
--    009의 서버잡 패턴과 같은 형태 — maintenance Route에서 호출한다.
-- ------------------------------------------------------------
create or replace function public.job_expire_notices()
returns integer language plpgsql security definer set search_path='' as $$
declare v_n integer;
begin
  update public.posts
     set pinned_at = null, pinned_until = null, pinned_by = null
   where pinned_at is not null
     and pinned_until is not null
     and pinned_until <= now();
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke execute on function public.job_expire_notices() from public, anon, authenticated;
grant  execute on function public.job_expire_notices() to service_role;

commit;

-- ============================================================
-- 다음 배치
--  · 전 게시판 공통 공지(global) — 지금은 게시판별만. 필요해지면 scope 컬럼 추가.
--  · 목록 조회 RPC/뷰에서 "고정 먼저" 정렬 반영 (화면 쪽 작업과 함께)
--  · maintenance Route의 job 레지스트리에 expire-notices 등록
-- ============================================================
