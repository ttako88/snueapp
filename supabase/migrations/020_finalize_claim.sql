-- ============================================================
-- 020_finalize_claim.sql — 동시 finalize 차단 (token-fenced lease)
-- ============================================================
-- ⚠️ pending/. GPT 검수 + 소유자 승인 전에는 적용하지 않는다.
--
-- 무엇이 문제인가 (COLLAB_STATE "미해결 결함": 동시 finalize claim 전이·락 부재)
--
--   /api/verification/finalize 는 이렇게 돈다.
--     ① status='uploading' 인지 **읽어서** 확인
--     ② staging 객체를 내려받아 바이트 검증 (여기서 수백 ms~수 초)
--     ③ verified 경로에 업로드
--     ④ 되읽어 digest 대조
--     ⑤ svc_set_verification_storage_path → finalize_verification
--
--   ①과 ⑤ 사이에 아무 잠금도 없다. 같은 요청으로 finalize 가 동시에 둘
--   들어오면 둘 다 ①을 통과하고 각자 ②를 수행한다.
--
-- 왜 rev1 의 "시각만 있는 선점" 이 부족한가 (GPT BLOCKER P-20260722-PACKET_020_..._REVIEW_01)
--   finalize_claimed_at 만으로 만든 **만료형(TTL) 선점은 "지연됐지만 아직 살아
--   있는 기존 작업자(stale worker)" 를 fencing 하지 못한다.** A 가 선점하고 작업을
--   시작한 뒤 지연되면(외부 I/O·Storage 작업이 60초 요청 상한 뒤에도 살아 있을 수
--   있다), 2분 후 B 가 만료된 선점을 인수한다. 그러면 A·B 가 **같은 verified 경로**에
--   쓰게 되고, B 만 finalize 돼도 A 의 뒤늦은 쓰기가 정본을 덮는다.
--   maxDuration=60 은 HTTP 요청 상한이지, 이미 시작된 Storage 작업이 60초 안에
--   반드시 끝난다는 fencing 증거가 아니다.
--
-- 어떻게 고치나 — TTL 은 liveness 만, 무결성은 token 으로
--   1. finalize_claim_token(uuid) 을 선점마다 새로 발급한다.
--   2. 정본 경로 결합·해제는 **자신이 받은 token 이 현재 token 과 같을 때만** 성공한다.
--      B 가 인수하면 token 이 갈리므로 A 의 늦은 결합·해제는 0건이 되어 격리된다.
--   3. 각 claimant 는 **자기 token 이 든 고유 경로**(verified/<id>/<token>/document)에
--      upsert:false 로 쓴다. 그래서 A 의 늦은 write 는 자기 경로에만 떨어지고
--      B 의 정본을 건드리지 못한다. 패배한 경로는 고아로 남아 021 배치가 정리한다.
--   TTL(2분)은 그대로 두되, 역할이 "죽은 선점을 언젠가 재시도 가능하게" 로 한정된다.
--
-- 왜 새 status 값을 안 쓰나
--   'finalizing' 을 넣으려면 운영 테이블의 CHECK 제약을 바꿔야 한다. status 는 7종이
--   여러 CHECK·부분 인덱스·배치 쿼리에 얽혀 값 하나 늘리는 비용이 크다. 선점은
--   업무 상태와 직교하므로 nullable lease 메타데이터(시각+token) 컬럼이 옳다.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. 선점 lease 컬럼: 시각(liveness) + token(무결성 fencing)
--    nullable 이라 기존 행·제약·인덱스에 영향이 없다.
-- ------------------------------------------------------------
alter table private.verification_requests
  add column if not exists finalize_claimed_at timestamptz;
alter table private.verification_requests
  add column if not exists finalize_claim_token uuid;

comment on column private.verification_requests.finalize_claimed_at is
  'finalize 선점 시각. liveness 전용 — TTL(2분)이 지나면 죽은 선점으로 보고 재인수를 허용한다.';
comment on column private.verification_requests.finalize_claim_token is
  'finalize 선점 토큰. 무결성 fencing 전용. 정본 경로 결합·해제·고유 경로가 모두 '
  '이 token 에 묶인다. 재인수되면 token 이 갈려 기존 작업자의 늦은 쓰기가 격리된다.';

-- ------------------------------------------------------------
-- 2. 선점 — 새 token 발급, 반환
--    성공한 한 요청만 updated=1 을 받는다. UPDATE 는 행 잠금을 잡으므로 같은 행을
--    노리는 동시 UPDATE 는 직렬화된다. 죽은 선점(TTL 경과)만 재인수한다.
-- ------------------------------------------------------------
create or replace function public.svc_claim_verification_finalize(
  p_request_id bigint, p_member_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  n integer;
  v_path text;
  v_token uuid;
  v_claimed timestamptz;
begin
  v_token := gen_random_uuid();
  update private.verification_requests
     set finalize_claimed_at = now(),
         finalize_claim_token = v_token
   where id = p_request_id
     and member_id = p_member_id
     and status = 'uploading'
     and (finalize_claimed_at is null
          or finalize_claimed_at < now() - interval '2 minutes')
  returning storage_path into v_path;
  get diagnostics n = row_count;

  if n = 1 then
    return jsonb_build_object('claimed', true, 'storage_path', v_path,
                              'claim_token', v_token);
  end if;

  -- 못 가져간 이유를 구분한다. "이미 처리 중" 과 "상태가 다름" 은 할 말이 다르다.
  select finalize_claimed_at into v_claimed
    from private.verification_requests
   where id = p_request_id and member_id = p_member_id and status = 'uploading';

  if v_claimed is not null then
    return jsonb_build_object('claimed', false, 'reason', 'in_progress',
                              'retry_after_seconds',
                              greatest(0, 120 - extract(epoch from (now() - v_claimed))::int));
  end if;
  return jsonb_build_object('claimed', false, 'reason', 'not_uploading');
end $$;
revoke execute on function public.svc_claim_verification_finalize(bigint, uuid)
  from public, anon, authenticated;
grant  execute on function public.svc_claim_verification_finalize(bigint, uuid)
  to service_role;

-- ------------------------------------------------------------
-- 3. 정본 결합 + 상태 전이 — **하나의 token-gated 원자적 commit** (GPT rev2 BLOCKER)
--
--    rev2 는 경로 결합(svc_bind_verified_path)과 상태 전이(finalize_verification)를
--    **두 개의 별도 RPC** 로 나눴다. 그러면 그 사이 TTL 인수가 끼어들 수 있어,
--    A 가 결합에 성공한 뒤 지연되고 B 가 재인수하면 최종 상태와 storage_path 가
--    서로 다른 claimant 기준으로 엮일 수 있었다. 또 결합 후 실패 시 storage_path 를
--    복원하지 않아 재시도가 검증 전 경로를 원본처럼 읽을 위험도 있었다.
--
--    그래서 **한 함수(=한 트랜잭션)** 로 합친다:
--      ① id+member_id+status='uploading'+claim_token 일치 시에만 (행 잠금)
--      ② storage_path 를 이 token 경로로 설정
--      ③ 기존 finalize 상태 전이(private.finalize_verification_impl)를 그대로 수행
--      ④ claim metadata 정리
--    ①의 UPDATE 가 행을 잠그므로 이 함수 실행 동안 재인수가 끼어들 수 없다.
--    내 token 이 현재 token 과 다르면(재인수당함) ①이 0건 → finalize 하지 않는다.
--
--    경로를 인자로 받지 않는다 — 함수가 id+token 으로 직접 만든다(017 의 교훈).
-- ------------------------------------------------------------
create or replace function public.svc_finalize_verified(
  p_request_id bigint, p_member_id uuid, p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n integer; v_path text;
begin
  if p_claim_token is null then
    return jsonb_build_object('finalized', false, 'reason', 'no_token');
  end if;
  v_path := 'verified/' || p_request_id::text || '/' || p_claim_token::text || '/document';

  -- ① token 게이트 + ② 경로 결합 + ④ claim 정리 (한 문장, 행 잠금)
  update private.verification_requests
     set storage_path = v_path,
         finalize_claimed_at = null,
         finalize_claim_token = null
   where id = p_request_id
     and member_id = p_member_id
     and status = 'uploading'
     and finalize_claim_token = p_claim_token;
  get diagnostics n = row_count;
  if n <> 1 then
    -- 재인수당했거나(내 token 이 더는 현재가 아님) 상태가 변했다. finalize 안 한다.
    return jsonb_build_object('finalized', false, 'reason', 'claim_lost');
  end if;

  -- ③ 같은 트랜잭션에서 기존 finalize 상태 전이 수행 (원자적). impl 이 다시
  --    status='uploading' 을 확인하고 submitted 로 넘긴다. 방금 우리가 행을
  --    잠갔으므로 그 사이 아무도 status·경로를 못 바꾼다.
  --    impl(003, 동결)은 모든 실패에서 raise exception 하지만(확인함), perform 은
  --    반환값을 무시하므로 **방어적 post-check** 를 둔다(GPT rev3 MUST2): 전이가
  --    실제로 됐고 경로가 내 것인지 확인하고, 아니면 예외로 전체 tx 를 롤백한다.
  --    단순 return false 는 선행 UPDATE 를 커밋하므로 불충분하다.
  perform private.finalize_verification_impl(p_member_id, p_request_id);
  if not exists (
    select 1 from private.verification_requests
     where id = p_request_id and member_id = p_member_id
       and status = 'submitted' and storage_path = v_path
  ) then
    raise exception 'finalize post-check failed for request %', p_request_id;
  end if;
  return jsonb_build_object('finalized', true, 'path', v_path);
end $$;
revoke execute on function public.svc_finalize_verified(bigint, uuid, uuid)
  from public, anon, authenticated;
grant  execute on function public.svc_finalize_verified(bigint, uuid, uuid)
  to service_role;

-- ------------------------------------------------------------
-- 4. 선점 해제 (token 게이트)
--    finalize 가 실패로 끝났을 때만 부른다. **자기 token 일 때만** 푼다 — 재인수한
--    B 의 선점을 stale A 가 실수로 풀어 버리는 일을 막는다. 성공 finalize 면 status
--    가 'submitted' 로 넘어가 선점 조건이 자연히 거짓이 되므로 따로 풀 필요가 없다.
-- ------------------------------------------------------------
create or replace function public.svc_release_verification_finalize(
  p_request_id bigint, p_member_id uuid, p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update private.verification_requests
     set finalize_claimed_at = null,
         finalize_claim_token = null
   where id = p_request_id
     and member_id = p_member_id
     and status = 'uploading'
     and finalize_claim_token = p_claim_token;
  get diagnostics n = row_count;
  return jsonb_build_object('released', n);
end $$;
revoke execute on function public.svc_release_verification_finalize(bigint, uuid, uuid)
  from public, anon, authenticated;
grant  execute on function public.svc_release_verification_finalize(bigint, uuid, uuid)
  to service_role;

-- ------------------------------------------------------------
-- 5. 레거시 우회 경로 차단 (GPT rev3 MUST1)
--    token fence 를 우회할 수 있는 기존 경로를 service_role 에서 회수한다.
--      · public.svc_set_verification_storage_path : storage_path 를 **무조건** 바꾼다(token 없음)
--      · public.finalize_verification            : 상태 전이를 **무조건** 한다(token 없음)
--    이제 정본 결합·상태 전이는 svc_finalize_verified(token 게이트) 하나만 할 수 있다.
--    새 라우트는 이 둘을 부르지 않는다(svc_finalize_verified + private impl 사용).
--    런타임 호출처 전수 확인: 앱에서 이 둘을 부르던 유일한 곳은 옛 finalize 라우트뿐이고
--    이미 재작성했다(verificationSubmit.js 는 주석만, 나머지는 smoke/diag 스크립트).
--    ⚠️ 이 회수로 **적용~새 라우트 배포 사이 구 라우트의 finalize 가 실패**한다. 그게
--       의도다(그 창에서 우회를 막는다). 그래서 적용 직후 바로 배포한다.
--       private.finalize_verification_impl 은 회수하지 않는다 — svc_finalize_verified 가 쓴다.
-- ------------------------------------------------------------
revoke execute on function public.svc_set_verification_storage_path(bigint, uuid)
  from service_role;
revoke execute on function public.finalize_verification(uuid, bigint)
  from service_role;

commit;

-- ============================================================
-- 라우트 쪽 변경 (같이 배포해야 의미가 있다)
--   ① 조회 직후 svc_claim_verification_finalize 를 부르고 claim_token 을 받는다
--   ② claimed=false 면 409 로 끝낸다 (파일을 건드리지 않는다)
--   ③ verified/<id>/<token>/document 에 upsert:false 로 올린다 (경로 격리) →
--      되읽어 digest 대조 (검증 완료)
--   ④ **svc_finalize_verified(id, member, token)** 하나로 경로결합+상태전이를 원자적으로.
--      finalized=true 일 때만 성공. stale 은 claim_lost 로 격리(별도 bind+비조건부
--      finalize 조합은 쓰지 않는다 — GPT rev2 MUST).
--   ⑤ 실패·예외 경로 전부에서 svc_release_verification_finalize(id, member, token)
--   ⑥ 라우트 시작 시 RPC capability 확인 — 없으면 503, 구형 비선점 경로로 fallback 금지
--   ⑦ 모든 외부 I/O(Storage 다운로드·업로드·RPC)에 명시적 timeout
--
-- ⚠️ 배포 순서: 마이그레이션 → (배포 전 prod-verify-020-applied.mjs 로 함수 존재 확인)
--    → 라우트 배포. 역전하면 RPC 가 없어 finalize 가 전부 실패한다.
-- ============================================================
