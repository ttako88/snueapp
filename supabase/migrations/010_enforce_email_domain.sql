-- ============================================================
-- 010_enforce_email_domain.sql — 이메일 도메인 서버측 강제 (신설)
-- ============================================================
-- 배경
--   app/login/page.js 의 주석이 명시한다 — "여기 정규식만 믿으면 API를 직접
--   호출해 우회할 수 있으므로 반드시 서버(DB)에서도 막아야 함".
--   그 서버 잠금은 구 스키마의 enforce_snue_email 트리거였는데, reset 이
--   지웠고 001~009 가 다시 만들지 않았다. 운영 실측으로 확인했다 —
--   auth.users 위 트리거는 on_auth_user_created 하나뿐이고, 도메인을
--   검사하는 제약도 함수도 없다. 즉 지금은 Auth API 직접 호출로 아무
--   도메인이나 가입할 수 있다.
--
-- 설계 판단
--   · INSERT 에만 거는 게 아니라 email 변경 UPDATE 에도 건다. 안 걸면
--     허용 도메인으로 가입한 뒤 아무 주소로 바꾸면 그만이다.
--   · 다만 email 이 실제로 바뀌지 않는 UPDATE 는 통과시킨다. GoTrue 는
--     로그인·토큰 갱신 과정에서 auth.users 를 자주 갱신하는데, 그때
--     도메인 제한을 도입하기 전에 만들어진 기존 계정이 막히면 안 된다.
--   · 기존 행은 소급 검사하지 않는다. 제한 도입 전에 만들어진 계정
--     (운영에 1건 있다)은 계속 로그인할 수 있어야 한다. 소급 차단은
--     사용자를 잠그는 것이지 보안을 올리는 게 아니다.
--   · 서브도메인을 허용한다(dept.snue.ac.kr). 클라이언트 정규식과 같은
--     규칙이어야 화면과 서버가 어긋나지 않는다.
--
-- 검증(적용 후 실측할 것)
--   select tgname from pg_trigger where tgrelid='auth.users'::regclass
--     and not tgisinternal;                      -- enforce_snue_email 존재
--   Auth API 로 비허용 도메인 가입 시도 → 거부되어야 함
-- ============================================================

begin;

create or replace function private.enforce_snue_email()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- email 이 없는 경로(전화 가입 등)는 이 정책의 대상이 아니다
  if new.email is null then
    return new;
  end if;

  -- 값이 바뀌지 않는 UPDATE 는 통과. GoTrue 의 일상적 갱신을 막지 않기 위함이고,
  -- 제한 도입 이전 계정을 소급 차단하지 않기 위함이기도 하다.
  if tg_op = 'UPDATE' and new.email is not distinct from old.email then
    return new;
  end if;

  -- 클라이언트(app/login/page.js)의 SNUE_EMAIL_RE 와 같은 규칙.
  -- 대소문자 무시, 서브도메인 허용.
  if new.email !~* '^[^@[:space:]]+@([a-z0-9-]+\.)*snue\.ac\.kr$' then
    raise exception 'email domain not allowed'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

-- 심층방어: 이 함수를 앱 role 이 직접 부를 이유가 없다
revoke execute on function private.enforce_snue_email() from public, anon, authenticated, service_role;

drop trigger if exists enforce_snue_email on auth.users;
create trigger enforce_snue_email
  before insert or update of email on auth.users
  for each row execute function private.enforce_snue_email();

commit;
