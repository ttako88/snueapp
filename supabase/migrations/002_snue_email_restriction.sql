-- ============================================================
-- 마이그레이션: 서울교대 이메일만 닉네임(프로필) 생성 허용
-- schema.sql과 달리 테이블을 지우지 않음 — 기존 글·프로필 데이터 안전.
-- SQL Editor에 그대로 붙여넣고 Run 하세요. 여러 번 실행해도 안전합니다.
--
-- 허용 패턴: xxx@snue.ac.kr, xxx@st.snue.ac.kr, xxx@student.snue.ac.kr,
--           xxx@o365.snue.ac.kr 등 "무엇이든.snue.ac.kr"로 끝나는 전부.
-- ============================================================

drop trigger if exists enforce_snue_email_on_profile on public.profiles;
drop function if exists public.enforce_snue_email();

create function public.enforce_snue_email()
returns trigger language plpgsql security definer set search_path = public as $$
declare em text;
begin
  select email into em from auth.users where id = new.id;
  if em is null or em !~* '^[^@]+@([a-z0-9-]+\.)*snue\.ac\.kr$' then
    raise exception '서울교대 이메일(@snue.ac.kr 계열)로만 닉네임을 만들 수 있어요';
  end if;
  return new;
end $$;

create trigger enforce_snue_email_on_profile before insert on public.profiles
  for each row execute function public.enforce_snue_email();
