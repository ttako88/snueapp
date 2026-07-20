-- ============================================================
-- 007_soft_delete_rpc.sql — 소프트 삭제를 definer RPC로 (RLS UPDATE 구조 결함 우회)
-- PROMOTED for dev rehearsal (dev 검증 2026-07-20)
-- 배경(dev 실측 T-W/T-R): posts_select 정책의 `deleted_at is null` 때문에,
--   작성자가 자기 글을 soft delete(deleted_at을 not-null로)하는 authenticated UPDATE의
--   결과 행이 SELECT 가시성을 잃어 "new row violates RLS"로 거부됨(PostgreSQL RLS UPDATE는
--   결과 행이 SELECT 정책으로도 보이길 요구). → 사용자가 자기 글을 삭제할 수 없는 치명 결함.
-- 해법: 클라이언트 직접 deleted_at UPDATE 권한 제거 + 소유권 검증하는 definer RPC로 삭제.
--   (GATE3 §5.2의 "soft delete=같은 update 경로"를 "definer RPC 경로"로 조정 — v1.4 반영 예정)
-- ============================================================
begin;

-- 1. 클라이언트 직접 deleted_at UPDATE 차단 (title/body만 직접 수정 허용)
revoke update (deleted_at) on public.posts    from authenticated;
revoke update (deleted_at) on public.comments from authenticated;

-- 2. 소프트 삭제 RPC (definer — RLS 우회, 함수 내부 소유권+writable 검증)
-- 불변조건(GPT 3차 검수): authenticated만 EXECUTE / auth.uid()로만 행위자 판정(id 인자 금지) /
--   is_writable_member() / owners 소유권 / deleted_at is null 행만 / 삭제시각 clock_timestamp() /
--   존재하지않음·타인·이미삭제는 동일한 no-op(void 반환, 존재정보·본문 미노출) /
--   comment_count는 "현재 공개 댓글 수" — 최초 삭제 성공 시 1회만 감소.
create or replace function public.soft_delete_post(p_post_id bigint)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not authz.is_writable_member() then raise exception 'not allowed'; end if;
  -- 본인 소유 + 미삭제 행만 삭제. 아니면 아무 일도 하지 않음(no-op) — 존재 정보 비노출
  update public.posts p set deleted_at = clock_timestamp(), updated_at = clock_timestamp()
    where p.id = p_post_id and p.deleted_at is null
      and exists (select 1 from public.post_owners o where o.post_id = p.id and o.user_id = auth.uid());
end $$;
revoke execute on function public.soft_delete_post(bigint) from public, anon, authenticated;
grant  execute on function public.soft_delete_post(bigint) to authenticated;

create or replace function public.soft_delete_comment(p_comment_id bigint)
returns void language plpgsql security definer set search_path='' as $$
declare v_post bigint;
begin
  if not authz.is_writable_member() then raise exception 'not allowed'; end if;
  -- 본인 소유+미삭제 행만. update가 실제 1행 삭제했을 때만 comment_count 1회 감소(중복 감소 방지)
  update public.comments c set deleted_at = clock_timestamp(), updated_at = clock_timestamp()
    where c.id = p_comment_id and c.deleted_at is null
      and exists (select 1 from public.comment_owners o where o.comment_id = c.id and o.user_id = auth.uid())
    returning c.post_id into v_post;
  if v_post is not null then
    update public.posts pp set comment_count = greatest(pp.comment_count - 1, 0) where pp.id = v_post;
  end if;
end $$;
revoke execute on function public.soft_delete_comment(bigint) from public, anon, authenticated;
grant  execute on function public.soft_delete_comment(bigint) to authenticated;

commit;
