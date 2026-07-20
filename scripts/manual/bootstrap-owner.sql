-- ============================================================
-- bootstrap-owner.sql  v2 (P0-4 — GPT 검수 B-1~B-9 반영, 일회성)
-- ============================================================
-- 목적: 새 기반(001~009) 적용·사용자 재가입 후, 첫 owner를 안전하게 만든다.
--   일반 grant_role은 "이미 owner인 호출자"가 필요해 첫 owner를 만들 수 없다 —
--   이 스크립트가 그 유일한 예외 경로(12.7 부트스트랩)다.
--
-- 실행 주체: 사용자 본인 (SQL Editor). Claude는 자리표시자 값을 알지 못한다.
-- 실행 조건:
--   1) 런북 Phase 6 도달 (재가입 + 닉네임 온보딩 완료)
--   2) SQL Editor 대상 ref가 의도한 프로젝트인지 화면에서 직접 확인
--   3) 자리표시자 4곳을 로컬에서 치환 (치환본은 저장·커밋·공유 금지)
--
-- 자리표시자 (전부 사용자 손으로만):
--   __TARGET_AUTH_UUID__  : Dashboard > Authentication > Users에서 본인 UUID 복사
--   __REAL_NAME__         : 실명 (예: 홍길동)
--   __STUDENT_NO_HMAC__   : scripts/manual/compute-student-hmac.mjs 결과 (hex 64자)
--   __HMAC_KEY_VERSION__  : 도구가 함께 출력한 key version 숫자 (예: 1)
--     ⚠️ 도구 출력의 version과 여기 값이 같은지 직접 대조할 것 (B-5)
--
-- 불변조건 (스크립트가 강제):
--   grant_role과 동일한 advisory lock + 대상 행 FOR UPDATE (동시 실행 경쟁 차단)
--   "새 정상 계정" 시작상태 엄격 검사 — 다르면 덮어쓰지 않고 중단
--   school_identities는 신규 INSERT만 (기존 신원·hold 덮어쓰기 금지)
--   전이 이력(member_status_history) 기록 / 부트스트랩 감사기록 / owner=1 사후검증
--   재실행: 동일 대상·동일 실명·동일 HMAC·이미 완성 owner면 멱등(변경 0), 그 외 거부
--
-- 실행 후 위생 (B-9 — 실명·HMAC이 SQL Editor에 남지 않게):
--   · 실행 후 치환된 쿼리 탭은 저장하지 말고 즉시 폐기
--   · 화면을 스크린샷·채팅에 붙이지 말 것, 클립보드 동기화 앱 주의
--   · 사후검증 출력은 count뿐 — 실명·HMAC을 다시 조회하지 말 것
-- 실패 시: 예외 → 전체 자동 롤백. 로그 저장, 원인 해결 후 재실행.
-- ============================================================

begin;

do $$
declare
  v_target_raw text := '__TARGET_AUTH_UUID__';   -- B-8: text로 받고 검증 후 cast
  v_name       text := '__REAL_NAME__';
  v_hmac       text := '__STUDENT_NO_HMAC__';
  v_key_raw    text := '__HMAC_KEY_VERSION__';   -- B-5: 하드코딩 금지, 자리표시자
  v_target   uuid;
  v_key_ver  smallint;
  v_member   private.members%rowtype;
  v_email_ok timestamptz;
  v_existing_owner uuid;
  v_already  boolean := false;
begin
  -- [0] 자리표시자 치환·형식 검증 (덜 치환된 채 실행되면 여기서 전부 중단)
  if v_target_raw like '\_\_%' escape '\'
     or v_target_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'bootstrap refused: TARGET_AUTH_UUID가 치환되지 않았거나 UUID 형식이 아님';
  end if;
  v_target := v_target_raw::uuid;

  if v_key_raw like '\_\_%' escape '\' or v_key_raw !~ '^[0-9]{1,4}$' or v_key_raw::int < 1 then
    raise exception 'bootstrap refused: HMAC_KEY_VERSION이 치환되지 않았거나 양의 정수가 아님';
  end if;
  v_key_ver := v_key_raw::smallint;

  if v_hmac like '\_\_%' escape '\' or v_hmac !~ '^[0-9a-f]{64}$' then
    raise exception 'bootstrap refused: STUDENT_NO_HMAC이 치환되지 않았거나 소문자 hex 64자가 아님';
  end if;

  v_name := btrim(v_name);
  if v_name like '\_\_%' escape '\' or char_length(v_name) < 2 or char_length(v_name) > 30
     or v_name ~ '[\n\r\t]' or v_name ~ '[[:cntrl:]]' then
    raise exception 'bootstrap refused: REAL_NAME이 치환되지 않았거나 형식 위반(2~30자, 제어문자 금지)';
  end if;

  -- [1] 동시 실행 경쟁 차단 (B-1: grant_role과 정확히 같은 잠금 키)
  perform pg_advisory_xact_lock(hashtext('owner_role_change'));

  -- [2] 대상 존재 + Auth 인증 완료 확인
  select email_confirmed_at into v_email_ok from auth.users where id = v_target;
  if not found then
    raise exception 'bootstrap refused: auth.users에 대상 UUID 없음';
  end if;
  if v_email_ok is null then
    raise exception 'bootstrap refused: 이메일 미인증 계정 (email_confirmed_at null)';
  end if;

  select * into v_member from private.members where id = v_target for update;
  if not found then
    raise exception 'bootstrap refused: private.members에 대상 행 없음 (재가입 트리거 확인)';
  end if;

  -- [3] 기존 owner 검사 — 있으면 거부. 단 "대상 본인이 이미 완성된 owner"면 멱등 성공.
  select id into v_existing_owner from private.members where role = 'owner' limit 1;
  if v_existing_owner is not null then
    if v_existing_owner = v_target
       and v_member.verification_status = 'verified'
       and v_member.sanction = 'none'
       and exists (select 1 from private.school_identities
                   where member_id = v_target
                     and student_no_hmac = v_hmac
                     and hmac_key_version = v_key_ver
                     and real_name = v_name              -- B-3: 실명까지 동일해야 멱등
                     and revoked_at is null) then
      raise notice 'bootstrap idempotent: 대상이 이미 완성된 owner — 변경 0';
      v_already := true;
    else
      raise exception 'bootstrap refused: 다른/불완전 owner가 이미 존재 (%). 수동 조사 필요', v_existing_owner;
    end if;
  end if;

  if not v_already then
    -- [4] "새 정상 계정" 시작상태 엄격 검사 (B-2 — 하나라도 다르면 덮어쓰지 않고 중단)
    if v_member.nickname is null then
      raise exception 'bootstrap refused: 닉네임 미설정 (온보딩 미완료)';
    end if;
    if v_member.role <> 'member' then
      raise exception 'bootstrap refused: role이 member가 아님 (%) — 새 계정이 아님', v_member.role;
    end if;
    if v_member.verification_status <> 'pending' then
      raise exception 'bootstrap refused: verification_status가 pending이 아님 (%)', v_member.verification_status;
    end if;
    if v_member.sanction <> 'none' or v_member.sanction_until is not null then
      raise exception 'bootstrap refused: 제재 상태가 깨끗하지 않음 (%)', v_member.sanction;
    end if;
    if exists (select 1 from private.verification_requests
               where member_id = v_target and status in ('uploading','submitted')) then
      raise exception 'bootstrap refused: 진행 중 인증 요청 존재 — 정식 심사 경로와 충돌';
    end if;

    -- [5] 신원 충돌 검사 (B-3 — 어떤 기존 기록도 덮어쓰지 않는다)
    if exists (select 1 from private.school_identities where member_id = v_target) then
      raise exception 'bootstrap refused: 대상에 이미 school_identities 존재 — 덮어쓰기 금지';
    end if;
    if exists (select 1 from private.school_identities
               where student_no_hmac = v_hmac and hmac_key_version = v_key_ver) then
      raise exception 'bootstrap refused: 동일 학번 HMAC이 이미 등록됨';
    end if;
    if exists (select 1 from private.enforcement_holds
               where student_no_hmac = v_hmac and hmac_key_version = v_key_ver) then
      raise exception 'bootstrap refused: 동일 학번 HMAC에 enforcement hold 존재 — 재가입 차단 대상';
    end if;

    -- [6] 신규 INSERT만 (ON CONFLICT 없음 — 경쟁 시 UNIQUE 위반으로 실패해야 정상)
    insert into private.school_identities (member_id, real_name, student_no_hmac, hmac_key_version)
    values (v_target, v_name, v_hmac, v_key_ver);

    -- [7] members 전이: verified · owner (sanction은 [4]에서 none 확인됨)
    update private.members
       set verification_status = 'verified',
           role = 'owner'
     where id = v_target;

    -- [8] 전이 이력 (B-4) + 부트스트랩 전용 감사기록
    insert into private.member_status_history (member_id, changed_field, old_value, new_value, actor_id, reason)
    values
      (v_target, 'verification_status', 'pending', 'verified', v_target, 'Gate 4a 12.7 owner bootstrap'),
      (v_target, 'role', 'member', 'owner', v_target, 'Gate 4a 12.7 owner bootstrap');

    insert into private.audit_logs (actor_id, action, target_type, target_id, reason)
    values (v_target, 'bootstrap_owner', 'member', v_target::text,
            'Gate 4a 12.7 owner bootstrap (one-time)');
  end if;

  -- [9] 사후검증: owner 정확히 1, 그 1이 verified+none
  if (select count(*) from private.members where role = 'owner') <> 1 then
    raise exception 'bootstrap failed: owner count <> 1';
  end if;
  if (select count(*) from private.members
      where role = 'owner' and verification_status = 'verified' and sanction = 'none') <> 1 then
    raise exception 'bootstrap failed: active owner count <> 1';
  end if;
end $$;

commit;

-- COMMIT 후 별도 확인 (PII 비출력 — count만. 실명·HMAC 재조회 금지):
--   select count(*) filter (where role='owner') as owner_count,
--          count(*) filter (where role='owner' and verification_status='verified'
--                           and sanction='none') as active_owner_count
--     from private.members;                        -- 기대: 1, 1
--   select count(*) from private.school_identities; -- 기대: 1
--   select count(*) from private.member_status_history
--    where reason like '%owner bootstrap%';        -- 기대: 2
--   select count(*) from private.audit_logs
--    where action='bootstrap_owner';               -- 기대: 1
-- 확인 후: 이 쿼리 탭을 저장하지 말고 폐기할 것 (실명·HMAC 잔존 방지)
