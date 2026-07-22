-- ============================================================
-- 021_orphan_detection.sql — 고아 Storage 객체 판정용 조회 RPC
-- ============================================================
-- ⚠️ pending/. GPT 검수 + 소유자 승인 전에는 적용하지 않는다.
--
-- 왜 필요한가 (#26 — 계정 삭제가 Storage 고아를 남긴다)
--   Storage 에 남은 객체가 고아인지 판정하려면 DB 를 봐야 하는데,
--   `private` 스키마는 PostgREST 에 노출되지 않아 service_role 로도
--   직접 조회가 안 된다(406 PGRST106). 그래서 RPC 로 뚫는다.
--
-- 이 배치는 **읽기 전용이다.** 지우는 함수는 만들지 않는다.
--   대상이 학생의 재학증명서·학생증이고 삭제는 되돌릴 수 없다.
--   목록을 사람이 확인한 뒤에 삭제 도구를 별도로 만든다.
--
-- 반환값 설계
--   판정에 필요한 **최소한**만 준다. 신청 내용·실명·학번은 주지 않는다.
--   고아 판정에는 "존재하는가 / 파기됐는가" 두 비트면 충분하다.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. 이 회원에게 살아 있는 업로드가 몇 건인가
--    staging/<user_id>/ 아래 객체가 고아인지 판정한다.
--    uploading 이 하나도 없으면 그 폴더의 객체는 쓰일 곳이 없다.
--
--    회원 행이 없어도(계정 삭제) 0 을 돌려준다 — 그 경우가 바로
--    "지워야 할 고아" 이므로 예외로 끊으면 안 된다.
-- ------------------------------------------------------------
create or replace function public.svc_count_open_uploads(p_member_id uuid)
returns jsonb language sql security definer set search_path = '' stable as $$
  select jsonb_build_object(
    'open', (select count(*) from private.verification_requests r
              where r.member_id = p_member_id and r.status = 'uploading'),
    -- 회원이 아직 있는지도 함께 준다. 없으면 staging 전체가 고아다.
    'member_exists', exists (select 1 from private.members m where m.id = p_member_id));
$$;
revoke execute on function public.svc_count_open_uploads(uuid)
  from public, anon, authenticated;
grant  execute on function public.svc_count_open_uploads(uuid) to service_role;

-- ------------------------------------------------------------
-- 2. 이 객체 경로가 현재 정본과 일치하는가 (verified/<id>/<token>/document 판정용)
--
--    ★ GPT 021 MUST: 정본 경로·token 자체를 **반환하지 않는다.** 탐지기가 이미
--      찾은 객체 경로를 넘기면, DB 는 그 경로가 현재 정본과 같은지(path_matches)만
--      돌려준다(최소 권한). 020 token-fence 는 정본을 verified/<id>/<token>/document
--      에 두므로, 재인수·실패한 stale 작업자의 업로드는 **패배 token 경로**로 남는다.
--      그 판정 = exists=true + path_matches=false (신청은 있는데 이 경로는 정본 아님).
--
--    p_request_id 를 text 로 받는 이유: bigint 를 JS Number 로 다루면 정밀도를
--    잃는다. 형식이 어긋나거나 bigint 범위를 넘으면 bad_id 로 답한다
--    (탐지기가 INVALID_PATH 로 분류한다 — 고아로 오인하지 않는다).
-- ------------------------------------------------------------
create or replace function public.svc_verification_object_status(
  p_request_id text, p_object_path text)
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare v_id bigint; r record;
begin
  if p_request_id !~ '^[1-9][0-9]*$' then
    return jsonb_build_object('exists', false, 'reason', 'bad_id');
  end if;
  begin
    v_id := p_request_id::bigint;   -- overflow 도 bad_id 로 (INVALID_PATH)
  exception when others then
    return jsonb_build_object('exists', false, 'reason', 'bad_id');
  end;

  select status, purged_at, storage_path into r
    from private.verification_requests where id = v_id;
  if not found then
    return jsonb_build_object('exists', false);
  end if;

  return jsonb_build_object(
    'exists', true,
    'purged', (r.purged_at is not null),
    'status', r.status,
    -- 경로·token 자체는 안 준다. 넘겨받은 경로가 현재 정본과 같은지만.
    'path_matches', (r.storage_path is not null and r.storage_path = p_object_path));
end $$;
revoke execute on function public.svc_verification_object_status(text, text)
  from public, anon, authenticated;
grant  execute on function public.svc_verification_object_status(text, text) to service_role;

commit;

-- ============================================================
-- 다음 단계 (이 배치 아님)
--   · 목록을 사람이 확인
--   · 확인된 것만 지우는 도구 (승인 필요, 삭제 전 크기·개수 재확인)
--   · 정기 배치로 승격할지는 그때 판단한다 — 자동 삭제는 되돌릴 수 없으므로
--     수동 확인을 몇 번 거친 뒤에 결정한다
-- ============================================================
