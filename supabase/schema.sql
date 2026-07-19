-- ============================================================
-- 서울교대 새록이 앱 — 게시판 스키마 v1 (2026-07-20)
-- Supabase SQL Editor에 통째로 붙여넣고 Run 하면 됩니다.
-- 다시 실행해도 안전하도록 drop ... if exists를 앞에 둡니다.
--
-- 설계 원칙
--  1. 작성자(user id)는 posts/comments에 저장하지 않는다.
--     별도 *_owners 테이블에 두고 "본인만 조회"로 잠근다.
--     → 익명글이어도 API 응답으로 작성자를 추적할 수 없음.
--  2. 화면에 보여줄 닉네임은 글에 복사해두되(author_nickname),
--     값은 서버 트리거가 강제로 채운다(클라이언트 위조 불가).
--  3. 삭제는 soft delete(deleted_at)만. 진짜 DELETE는 아무도 못 함.
--  4. 읽기·쓰기 모두 로그인 사용자만(학교 커뮤니티 프라이버시).
--     나중에 특정 게시판만 공개로 열려면 select 정책만 바꾸면 됨.
-- ============================================================

-- ---------- 초기화(재실행 대비) ----------
-- 테이블을 먼저 지운다(트리거는 테이블과 함께 사라짐) → 그 다음 함수.
drop table if exists public.comment_owners;
drop table if exists public.comments;
drop table if exists public.post_owners;
drop table if exists public.posts;
drop table if exists public.profiles;
drop function if exists public.handle_new_post();
drop function if exists public.record_post_owner();
drop function if exists public.handle_post_update();
drop function if exists public.handle_new_comment();
drop function if exists public.record_comment_owner();
drop function if exists public.handle_comment_update();

-- ---------- 프로필 (auth.users 1:1, 닉네임) ----------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nickname text not null unique check (char_length(nickname) between 2 and 16),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create policy "프로필 읽기: 로그인 사용자"
  on public.profiles for select to authenticated using (true);
create policy "프로필 생성: 본인 것만"
  on public.profiles for insert to authenticated with check (auth.uid() = id);
create policy "프로필 수정: 본인 것만"
  on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

-- ---------- 게시글 ----------
create table public.posts (
  id bigint generated always as identity primary key,
  board text not null check (board in
    ('free','secret','practicum','promo','club','teacher-exam','market','alumni','dorm')),
  title text not null check (char_length(title) between 1 and 100),
  body text not null check (char_length(body) between 1 and 10000),
  author_nickname text,                   -- 익명글이면 null (화면에선 '익명')
  is_anonymous boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  deleted_at timestamptz
);
create index posts_board_idx on public.posts (board, id desc);
alter table public.posts enable row level security;

-- 작성자 기록 (본인만 볼 수 있음 → 익명성 보장 + "내가 쓴 글" 조회 + 수정권한 판단)
create table public.post_owners (
  post_id bigint primary key references public.posts (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade
);
create index post_owners_user_idx on public.post_owners (user_id);
alter table public.post_owners enable row level security;

create policy "글 읽기: 로그인 사용자"
  on public.posts for select to authenticated using (true);
create policy "글 쓰기: 로그인 사용자(검증은 트리거)"
  on public.posts for insert to authenticated with check (true);
create policy "글 수정·삭제: 작성자 본인만"
  on public.posts for update to authenticated
  using (exists (select 1 from public.post_owners o
                 where o.post_id = id and o.user_id = auth.uid()))
  with check (exists (select 1 from public.post_owners o
                      where o.post_id = id and o.user_id = auth.uid()));
-- delete 정책 없음 = 하드삭제 불가(soft delete만)

create policy "글 소유확인: 본인 것만"
  on public.post_owners for select to authenticated using (user_id = auth.uid());
-- post_owners에 insert/update/delete 정책 없음 = 아래 security definer 트리거만 기록 가능

-- 글 작성 시: 로그인·프로필 확인 + 닉네임을 서버가 강제 결정(위조 불가)
create function public.handle_new_post()
returns trigger language plpgsql security definer set search_path = public as $$
declare nick text;
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다';
  end if;
  select nickname into nick from profiles where id = auth.uid();
  if nick is null then
    raise exception '닉네임(프로필)을 먼저 만들어주세요';
  end if;
  new.author_nickname := case when new.is_anonymous then null else nick end;
  new.created_at := now();
  new.updated_at := null;
  new.deleted_at := null;
  return new;
end $$;
create trigger on_post_insert before insert on public.posts
  for each row execute function public.handle_new_post();

-- 글 작성 직후: 소유 기록(작성자만 아는 연결고리)
create function public.record_post_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into post_owners (post_id, user_id) values (new.id, auth.uid());
  return new;
end $$;
create trigger on_post_owner after insert on public.posts
  for each row execute function public.record_post_owner();

-- 글 수정 시: 작성자 표시·작성일은 못 바꿈, updated_at 자동, soft delete 허용
create function public.handle_post_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.author_nickname := old.author_nickname;
  new.is_anonymous := old.is_anonymous;
  new.created_at := old.created_at;
  new.board := old.board;
  if new.deleted_at is distinct from old.deleted_at then
    new.updated_at := old.updated_at;      -- 삭제 처리는 수정시각 안 건드림
  else
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger on_post_update before update on public.posts
  for each row execute function public.handle_post_update();

-- ---------- 댓글 (대댓글 1단계: parent_id) ----------
create table public.comments (
  id bigint generated always as identity primary key,
  post_id bigint not null references public.posts (id) on delete cascade,
  parent_id bigint references public.comments (id) on delete set null,
  body text not null check (char_length(body) between 1 and 2000),
  author_nickname text,
  is_anonymous boolean not null default false,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index comments_post_idx on public.comments (post_id, id);
alter table public.comments enable row level security;

create table public.comment_owners (
  comment_id bigint primary key references public.comments (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade
);
create index comment_owners_user_idx on public.comment_owners (user_id);
alter table public.comment_owners enable row level security;

create policy "댓글 읽기: 로그인 사용자"
  on public.comments for select to authenticated using (true);
create policy "댓글 쓰기: 로그인 사용자(검증은 트리거)"
  on public.comments for insert to authenticated with check (true);
create policy "댓글 수정·삭제: 작성자 본인만"
  on public.comments for update to authenticated
  using (exists (select 1 from public.comment_owners o
                 where o.comment_id = id and o.user_id = auth.uid()))
  with check (exists (select 1 from public.comment_owners o
                      where o.comment_id = id and o.user_id = auth.uid()));

create policy "댓글 소유확인: 본인 것만"
  on public.comment_owners for select to authenticated using (user_id = auth.uid());

create function public.handle_new_comment()
returns trigger language plpgsql security definer set search_path = public as $$
declare nick text;
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다';
  end if;
  select nickname into nick from profiles where id = auth.uid();
  if nick is null then
    raise exception '닉네임(프로필)을 먼저 만들어주세요';
  end if;
  new.author_nickname := case when new.is_anonymous then null else nick end;
  new.created_at := now();
  new.deleted_at := null;
  return new;
end $$;
create trigger on_comment_insert before insert on public.comments
  for each row execute function public.handle_new_comment();

create function public.record_comment_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into comment_owners (comment_id, user_id) values (new.id, auth.uid());
  return new;
end $$;
create trigger on_comment_owner after insert on public.comments
  for each row execute function public.record_comment_owner();

create function public.handle_comment_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.author_nickname := old.author_nickname;
  new.is_anonymous := old.is_anonymous;
  new.created_at := old.created_at;
  new.post_id := old.post_id;
  new.parent_id := old.parent_id;
  return new;
end $$;
create trigger on_comment_update before update on public.comments
  for each row execute function public.handle_comment_update();
