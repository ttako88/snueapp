-- ============================================================
-- bootstrap-owner.sql  (P0-4 — 첫 owner 부트스트랩, 일회성)
-- ============================================================
-- 목적: 새 기반(001~009) 적용·사용자 재가입 후, 첫 owner를 안전하게 만든다.
--   일반 grant_role은 "이미 owner인 호출자"가 필요해 첫 owner를 만들 수 없다 —
--   이 스크립트가 그 유일한 예외 경로(12.7 부트스트랩)다.
--
-- 실행 주체: 사용자 본인 (SQL Editor). Claude는 자리표시자 값을 알지 못한다.
-- 실행 조건:
--   1) 런북 Phase 6 도달 (재가입 완료, private.members에 본인 행 존재)
--   2) SQL Editor 대상 ref가 의도한 프로젝트인지 화면에서 직접 확인
--   3) 자리표시자 3곳을 로컬에서 치환 (치환본은 저장·커밋·공유 금지)
--
-- 자리표시자 (전부 사용자 손으로만):
--   __TARGET_AUTH_UUID__ : Supabase Dashboard > Authentication > Users에서 본인 UUID 복사
--   __REAL_NAME__        : 실명 (예: 홍길동)
--   __STUDENT_NO_HMAC__  : scripts/manual/compute-student-hmac.mjs 로컬 실행 결과 (hex 64자)
--
-- 불변조건 (스크립트가 강제):
--   기존 owner 존재 시 거부 / 대상 회원 부재 시 거부 / 동일 HMAC 타회원 점유 시 거부
--   school_identities + verified/owner/none 전이 + 감사기록 = 한 트랜잭션
--   재실행: 동일 대상·동일 HMAC이면 멱등(변경 0으로 성공 종료), 그 외 명시적 거부
--   학번 원문·HMAC 키는 등장하지 않는다 (HMAC hex만)
-- 실패 시: 예외 → 전체 자동 롤백. 로그 저장, 원인 해결 후 재실행.
-- ============================================================

begin;

do $$
declare
  v_target   uuid := '__TARGET_AUTH_UUID__';
  v_name     text := '__REAL_NAME__';
  v_hmac     text := '__STUDENT_NO_HMAC__';
  v_key_ver  smallint := 1;
  v_existing_owner uuid;
  v_member   private.members%rowtype;
  v_already  boolean := false;
begin
  -- [0] 자리표시자 치환 확인
  if v_hmac like '\_\_%' escape '\' or char_length(v_hmac) <> 64
     or v_hmac !~ '^[0-9a-f]{64}$' then
    raise exception 'bootstrap refused: STUDENT_NO_HMAC 자리표시자가 치환되지 않았거나 hex 64자가 아님';
  end if;
  if v_name like '\_\_%' escape '\' or char_length(v_name) < 2 then
    raise exception 'bootstrap refused: REAL_NAME 자리표시자가 치환되지 않음';
  end if;

  -- [1] 대상 존재 확인 (재가입 트리거가 members 행을 만들었어야 함)
  if not exists (select 1 from auth.users where id = v_target) then
    raise exception 'bootstrap refused: auth.users에 대상 UUID 없음';
  end if;
  select * into v_member from private.members where id = v_target;
  if not found then
    raise exception 'bootstrap refused: private.members에 대상 행 없음 (재가입 트리거 확인)';
  end if;

  -- [2] 기존 owner 검사 — 있으면 거부. 단 "대상 본인이 이미 완성된 owner"면 멱등 성공.
  select id into v_existing_owner from private.members where role = 'owner' limit 1;
  if v_existing_owner is not null then
    if v_existing_owner = v_target
       and v_member.verification_status = 'verified'
       and v_member.sanction = 'none'
       and exists (select 1 from private.school_identities
                   where member_id = v_target
                     and student_no_hmac = v_hmac
                     and hmac_key_version = v_key_ver
                     and revoked_at is null) then
      raise notice 'bootstrap idempotent: 대상이 이미 완성된 owner — 변경 0';
      v_already := true;
    else
      raise exception 'bootstrap refused: 다른/불완전 owner가 이미 존재 (%). 수동 조사 필요', v_existing_owner;
    end if;
  end if;

  if not v_already then
    -- [3] 동일 HMAC이 타 회원에 점유되어 있으면 거부 (UNIQUE보다 먼저 명시적 메시지)
    if exists (select 1 from private.school_identities
               where student_no_hmac = v_hmac and hmac_key_version = v_key_ver
                 and member_id <> v_target) then
      raise exception 'bootstrap refused: 동일 학번 HMAC이 다른 회원에 등록됨';
    end if;

    -- [4] school_identities upsert (본인 행만)
    insert into private.school_identities (member_id, real_name, student_no_hmac, hmac_key_version)
    values (v_target, v_name, v_hmac, v_key_ver)
    on conflict (member_id) do update
      set real_name = excluded.real_name,
          student_no_hmac = excluded.student_no_hmac,
          hmac_key_version = excluded.hmac_key_version,
          revoked_at = null;

    -- [5] members 전이: verified · owner · none
    update private.members
       set verification_status = 'verified',
           sanction = 'none',
           sanction_until = null,
           role = 'owner'
     where id = v_target;

    -- [6] 부트스트랩 전용 감사기록
    insert into private.audit_logs (actor_id, action, target_type, target_id, reason)
    values (v_target, 'bootstrap_owner', 'member', v_target::text,
            'Gate 4a 12.7 owner bootstrap (one-time)');
  end if;

  -- [7] 사후검증: owner 정확히 1, 그 1이 verified+none
  if (select count(*) from private.members where role = 'owner') <> 1 then
    raise exception 'bootstrap failed: owner count <> 1';
  end if;
  if (select count(*) from private.members
      where role = 'owner' and verification_status = 'verified' and sanction = 'none') <> 1 then
    raise exception 'bootstrap failed: active owner count <> 1';
  end if;
end $$;

commit;

-- COMMIT 후 별도 확인 (PII 비출력 — count만):
--   select count(*) filter (where role='owner') as owner_count,
--          count(*) filter (where role='owner' and verification_status='verified'
--                           and sanction='none') as active_owner_count
--     from private.members;                        -- 기대: 1, 1
--   select count(*) from private.school_identities; -- 기대: 1
--   select action, created_at from private.audit_logs
--    where action='bootstrap_owner';               -- 기대: 1행
