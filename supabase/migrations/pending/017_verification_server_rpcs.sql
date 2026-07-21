-- ============================================================
-- 017_verification_server_rpcs.sql — 인증 라우트용 service_role RPC
-- ============================================================
-- ⚠️ pending. GPT 검수 전 적용하지 않는다.
--
-- 배경 (실측 2026-07-22)
--   시크릿을 등록하자마자 드러난 결함이다. 인증 라우트들이
--   `svc.schema("private").from(...)` 로 private 스키마에 직접 접근하는데,
--   PostgREST 노출 스키마는 public 과 graphql_public 뿐이라 service_role
--   이라도 406 PGRST106 이 난다:
--     "Only the following schemas are exposed: public, graphql_public"
--
--   private 을 노출하는 방향은 **금지**다. 그 비노출이 이 프로젝트 보안 설계의
--   전제이고(002 에서 anon/authenticated 권한을 전부 revoke 했다), 노출하면
--   RLS 뒤에 숨겨둔 개인정보 테이블이 API 표면으로 나온다.
--
--   대신 필요한 동작만 public 스키마의 SECURITY DEFINER 함수로 뚫고,
--   service_role 에게만 EXECUTE 를 준다.
--
-- 설계 원칙
--   · 함수는 라우트가 실제로 필요한 것만. 범용 조회 창구를 만들지 않는다
--   · 소유자 조건을 **함수 안에서** 강제한다. 호출부가 빠뜨릴 수 없게
--   · 반환에 hmac·key_version·reviewer_id 를 넣지 않는다 (GATE3 §4.3)
--   · 전부 service_role 전용. authenticated 에게 주지 않는다
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. 본인 신청 조회 (finalize 용)
--    member_id 를 인자로 받아 함수 안에서 대조한다 — 호출부가 소유자
--    조건을 빠뜨려도 남의 신청을 볼 수 없다.
-- ------------------------------------------------------------
create or replace function public.svc_get_own_verification_request(
  p_request_id bigint, p_member_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
           'id', r.id, 'status', r.status, 'storage_path', r.storage_path)
    from private.verification_requests r
   where r.id = p_request_id and r.member_id = p_member_id;
$$;
revoke execute on function public.svc_get_own_verification_request(bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.svc_get_own_verification_request(bigint, uuid)
  to service_role;

-- ------------------------------------------------------------
-- 2. storage_path 확정 (finalize 용)
--    status='uploading' 조건을 함께 건다 — 그 사이 철회된 신청을 되살리지 않는다.
--    갱신된 행 수를 돌려줘 호출부가 "정말 1건 바뀌었나" 를 확인할 수 있게 한다.
-- ------------------------------------------------------------
-- ★ 경로를 **인자로 받지 않는다.** 함수가 p_request_id 로 직접 만든다.
--   원안은 정규식으로 형식만 검사했는데, 그러면 신청 123 이
--   verified/999/document 를 저장할 수 있어 다른 신청자의 서류 경로와 엮인다.
--   호출부가 올바른 경로를 만든다는 전제에 의존하지 않는 것이 유일한 해법이다.
--   (GPT 검수 P-20260722-PACKET_017_VERIFICATION_RECOVERY_REVIEW_01 BLOCKER)
--   설정한 경로를 함께 돌려줘 호출부가 자기가 올린 위치와 대조할 수 있게 한다.
create or replace function public.svc_set_verification_storage_path(
  p_request_id bigint, p_member_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n integer; v_path text;
begin
  v_path := 'verified/' || p_request_id::text || '/document';
  update private.verification_requests
     set storage_path = v_path
   where id = p_request_id and member_id = p_member_id and status = 'uploading';
  get diagnostics n = row_count;
  return jsonb_build_object('updated', n, 'path', v_path);
end $$;
revoke execute on function public.svc_set_verification_storage_path(bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.svc_set_verification_storage_path(bigint, uuid)
  to service_role;

-- ------------------------------------------------------------
-- 3. uploading 상태 신청 철회 (begin 의 보상 롤백용)
--    signed URL 발급 실패처럼 사용자에게 쓰기 권한이 나가기 **전** 실패에만 쓴다.
--    status 조건이 있어 이미 제출된 신청은 건드리지 못한다.
-- ------------------------------------------------------------
create or replace function public.svc_abort_uploading_request(
  p_request_id bigint, p_member_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update private.verification_requests
     set status = 'withdrawn', purge_after = now()
   where id = p_request_id and member_id = p_member_id and status = 'uploading';
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.svc_abort_uploading_request(bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.svc_abort_uploading_request(bigint, uuid)
  to service_role;

-- ------------------------------------------------------------
-- 4. 심사자 자격 확인 (document 라우트용)
--    003 의 actor_role_check 는 auth.uid() 를 보므로 service_role 경로에서
--    쓸 수 없다. 같은 조건을 인자로 받아 판정하는 판을 따로 만든다.
--    반환은 역할 문자열 하나뿐 — 회원 정보를 노출하지 않는다.
-- ------------------------------------------------------------
create or replace function public.svc_reviewer_role(p_actor_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select m.role from private.members m
   where m.id = p_actor_id
     and m.nickname is not null
     and m.verification_status = 'verified'
     and m.sanction = 'none'
     and m.role in ('moderator','operator','owner');
$$;
revoke execute on function public.svc_reviewer_role(uuid)
  from public, anon, authenticated;
grant execute on function public.svc_reviewer_role(uuid) to service_role;

-- ------------------------------------------------------------
-- 5. 심사 대상 신청 조회 (document 라우트용)
--    ★ 자격 검사를 **함수 안에서** 한다. 호출부가 4번을 먼저 부르는 것에
--      의존하지 않는다 — 나중에 다른 라우트가 이 함수를 쓰면서 자격 확인을
--      빠뜨리면 남의 인증서류 경로가 그대로 새기 때문이다.
--      "규칙을 기억해야 지켜지는 구조" 를 DB 안으로 옮긴다.
--    실명·hmac 은 반환하지 않는다 — 문서를 여는 데 필요 없다.
-- ------------------------------------------------------------
create or replace function public.svc_get_verification_request_for_review(
  p_request_id bigint, p_actor_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_role text; v jsonb;
begin
  -- 자격 없는 actor 에게는 신청의 존재 여부조차 알려주지 않는다
  select m.role into v_role from private.members m
   where m.id = p_actor_id
     and m.nickname is not null
     and m.verification_status = 'verified'
     and m.sanction = 'none'
     and m.role in ('moderator','operator','owner');
  if v_role is null then raise exception 'not allowed'; end if;

  select jsonb_build_object(
           'id', r.id, 'status', r.status,
           'storage_path', r.storage_path,
           'purged', (r.purged_at is not null))
    into v
    from private.verification_requests r
   where r.id = p_request_id;
  return v;
end $$;
revoke execute on function public.svc_get_verification_request_for_review(bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.svc_get_verification_request_for_review(bigint, uuid)
  to service_role;

-- ------------------------------------------------------------
-- 6. 감사 기록 (document 라우트용)
--    문서 열람은 기록이 남아야만 허용된다(fail-closed). 기록에 실패하면
--    호출부가 URL 을 주지 않으므로, 여기서는 성공 여부만 정확히 돌려주면 된다.
--    action 을 자유 문자열로 받지 않는다 — 허용 목록으로 고정한다.
-- ------------------------------------------------------------
create or replace function public.svc_log_verification_access(
  p_actor_id uuid, p_action text, p_request_id bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_role text;
begin
  if p_action not in ('verification_document_signed_url_issued') then
    raise exception 'unknown action';
  end if;
  -- 5번과 같은 이유로 자격을 여기서도 확인한다. 감사 로그에 자격 없는 actor 가
  -- 기록되면 로그 자체가 오염되고, "기록됐으니 정당한 열람" 이라는 잘못된
  -- 증거가 남는다.
  select m.role into v_role from private.members m
   where m.id = p_actor_id
     and m.nickname is not null
     and m.verification_status = 'verified'
     and m.sanction = 'none'
     and m.role in ('moderator','operator','owner');
  if v_role is null then raise exception 'not allowed'; end if;

  insert into private.audit_logs (actor_id, action, target_type, target_id)
  values (p_actor_id, p_action, 'verification_request', p_request_id::text);
  return true;
end $$;
revoke execute on function public.svc_log_verification_access(uuid, text, bigint)
  from public, anon, authenticated;
grant execute on function public.svc_log_verification_access(uuid, text, bigint)
  to service_role;

commit;

-- ============================================================
-- 적용 후 라우트 수정 대상 (같은 배포에 포함해야 한다)
--   app/lib/server/verification/auth.mjs   requireModerator → svc_reviewer_role
--   app/api/verification/begin/route.js    롤백 → svc_abort_uploading_request
--   app/api/verification/finalize/route.js 조회·경로확정 → 1·2번
--   app/api/verification/document/route.js 조회·감사 → 5·6번
--   scripts/manual/verify-e2e-smoke.mjs    상태 확인 → 1번
-- ============================================================
