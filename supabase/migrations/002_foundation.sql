-- ============================================================
-- 002_foundation.sql
-- PROMOTED for dev rehearsal (P2 승인 2026-07-20) — 운영 적용은 dev 전 항목 통과+B-10 승인 후
-- 근거: GATE3_DESIGN.md v1.3 §1 표(테이블), §3, §4.3~4.4, §5, §10(인덱스·CHECK), §0(시드)
-- 정책 배치: RLS enable(정책 0=전면 거부)+함수 무의존 정책은 여기,
--            is_active_member() 등 함수 의존 정책은 003에서 함수와 함께 생성
-- ============================================================

begin;

-- ------------------------------------------------------------
-- A. public: boards
-- ------------------------------------------------------------
create table public.boards (
  id     smallint generated always as identity primary key,
  slug   text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name   text not null,
  icon   text not null,
  teaser text not null,
  sort   smallint not null,
  access text not null check (access in ('members','preview','hidden'))
);

alter table public.boards enable row level security;
revoke all on public.boards from anon, authenticated;
grant select on public.boards to anon, authenticated;

-- anon 정책: 함수 호출 없음 (§5.1 v1.3 — 정책 분리)
create policy boards_anon_preview on public.boards
  for select to anon using (access = 'preview');
-- authenticated 정책은 is_active_member() 의존 → 003에서 생성

-- 시드 9행 (§0 — slug는 app/lib/boards.js와 일치 확인 완료)
insert into public.boards (slug, name, icon, teaser, sort, access) values
  ('free',         '자유게시판',     '🗣️', '자유롭게 이야기해요',                    1, 'preview'),
  ('secret',       '비밀게시판',     '🤫', '교수님·강의 후기, 익명으로 편하게',       2, 'members'),
  ('practicum',    '실습게시판',     '👩‍🏫', '실습 정보 공유와 동기들과의 소통',        3, 'preview'),
  ('promo',        '홍보게시판',     '📣', '동아리·행사·프로그램 홍보',              4, 'preview'),
  ('club',         '동아리게시판',   '🎨', '동아리·학회 소식과 모집',                5, 'preview'),
  ('teacher-exam', '임용고시 게시판', '📖', '임고 정보와 스터디 모집',                6, 'preview'),
  ('market',       '장터게시판',     '🛒', '교재·물품 거래',                        7, 'members'),
  ('alumni',       '졸업생게시판',   '🎓', '졸업생과 재학생의 소통',                 8, 'hidden'),
  ('dorm',         '서록관 게시판',  '🌲', '기숙사(서록관) 생활 정보',               9, 'members');

-- ------------------------------------------------------------
-- B. private: members (auth.users 1:1 — §3)
-- ------------------------------------------------------------
create table private.members (
  id                    uuid primary key references auth.users (id) on delete cascade,
  nickname              text check (nickname is null or char_length(nickname) between 2 and 16),
  nickname_changed_at   timestamptz,
  verification_status   text not null default 'pending'
    check (verification_status in ('pending','submitted','verified','rejected','expired','deleting')),
  verification_deadline timestamptz not null default (now() + interval '7 days'),
  sanction              text not null default 'none'
    check (sanction in ('none','write_restricted','community_suspended','banned')),
  sanction_until        timestamptz,
  role                  text not null default 'member'
    check (role in ('member','moderator','operator','owner')),
  reverify_after        timestamptz,   -- v1 미사용 예약
  created_at            timestamptz not null default now(),
  -- 구조 CHECK (§10): sanction ↔ sanction_until
  check (
    (sanction = 'none'   and sanction_until is null) or
    (sanction = 'banned' and sanction_until is null) or
    (sanction in ('write_restricted','community_suspended') and sanction_until is not null)
  )
);
create unique index members_nickname_ci_unique
  on private.members (lower(nickname)) where nickname is not null;
create index members_vstatus_deadline on private.members (verification_status, verification_deadline);
create index members_sanction_until   on private.members (sanction, sanction_until);

alter table private.members enable row level security;   -- 정책 0 = 전면 거부
revoke all on private.members from anon, authenticated;

-- ------------------------------------------------------------
-- C. private: school_identities (§4 — RLS 정책 0, definer 내부만)
-- ------------------------------------------------------------
create table private.school_identities (
  member_id        uuid primary key references private.members (id) on delete cascade,
  real_name        text not null,
  student_no_hmac  text not null check (char_length(student_no_hmac) = 64),
  hmac_key_version smallint not null default 1,
  verified_at      timestamptz not null default now(),
  revoked_at       timestamptz,
  unique (hmac_key_version, student_no_hmac)   -- §4.1 동시 승인 최종 차단
);
alter table private.school_identities enable row level security;
revoke all on private.school_identities from anon, authenticated;

-- ------------------------------------------------------------
-- D. private: verification_requests (§4.3 — status 7종 v1.3)
-- ------------------------------------------------------------
create table private.verification_requests (
  id               bigint generated always as identity primary key,
  member_id        uuid not null references private.members (id) on delete cascade,
  doc_type         text not null
    check (doc_type in ('student_card','smart_id','enrollment_cert','leave_cert')),
  real_name        text,              -- 파기 시 null
  student_no_hmac  text not null check (char_length(student_no_hmac) = 64),
  hmac_key_version smallint not null,
  storage_path     text,              -- 서버 생성 경로만. 파기 시 null
  status           text not null default 'uploading'
    check (status in ('uploading','submitted','approved','rejected','withdrawn','upload_expired','expired_unreviewed')),
  created_at       timestamptz not null default now(),
  submitted_at     timestamptz,       -- finalize 성공 시각 (uploading 동안 null)
  reviewed_at      timestamptz,
  reviewer_id      uuid,
  reject_reason_code text
    check (reject_reason_code in ('unreadable','mismatch','expired_doc','wrong_doc','suspected_forgery','other')),
  -- 장기 미처리 알림 발송 기록 (r4 — 중복 발송 방지, 메시지 조회 대조 금지)
  owner_warned_3_at    timestamptz,
  owner_warned_7_at    timestamptz,
  user_delay_notified_at timestamptz,
  -- 파기 추적 (§4.4)
  purge_after      timestamptz,       -- 큐 진입 시 계산된 실제 파기 가능 시각 (v1.3)
  purge_started_at timestamptz,
  purged_at        timestamptz,
  purge_attempts   int not null default 0 check (purge_attempts >= 0),
  purge_last_error text,
  -- 구조 CHECK (§10 v1.3 + GPT 검수 보강 — 사유별 시차 CHECK 없음)
  check (status not in ('approved','rejected')
         or (submitted_at is not null and reviewed_at is not null and reviewer_id is not null)),
  check ((status = 'rejected') = (reject_reason_code is not null)),   -- 양방향
  check (status <> 'submitted' or submitted_at is not null),
  check (purged_at is null or purge_started_at is not null),
  check (purged_at is null or purged_at >= purge_started_at),
  check (purged_at is null or (storage_path is null and real_name is null))
);
-- 동시 제한: uploading+submitted 합산 1건 (§4.1 v1.3)
create unique index verification_requests_one_active
  on private.verification_requests (member_id) where status in ('uploading','submitted');
create index verification_requests_purge on private.verification_requests (status, purge_after);
create index verification_requests_member on private.verification_requests (member_id, submitted_at desc);

alter table private.verification_requests enable row level security;
revoke all on private.verification_requests from anon, authenticated;

-- ------------------------------------------------------------
-- E. private: enforcement_holds (members와 FK 없음 — §2.6/부록 I)
-- ------------------------------------------------------------
-- (GPT 검수 반영) released_at 폐기 — 만료·수동 해제 모두 행 hard delete.
-- 테이블에는 활성 hold만 존재, 해제 사실은 HMAC 없는 audit log로만 기록.
create table private.enforcement_holds (
  id               bigint generated always as identity primary key,
  student_no_hmac  text not null check (char_length(student_no_hmac) = 64),
  hmac_key_version smallint not null,
  hold_reason      text not null
    check (hold_reason in ('banned','active_sanction_withdrawal','open_case_withdrawal')),
  source_case_id   bigint,            -- 의도적 FK 없음 (독립성)
  retained_at      timestamptz not null default now(),
  retention_until  timestamptz,       -- null=미확정. 미확정 상태에서 production 생성은 함수가 거부 (§12-3)
  unique (hmac_key_version, student_no_hmac)
);
create index enforcement_holds_retention on private.enforcement_holds (retention_until);

alter table private.enforcement_holds enable row level security;
revoke all on private.enforcement_holds from anon, authenticated;

-- ------------------------------------------------------------
-- F. private: member_status_history (불변 이력 — §2.3)
-- ------------------------------------------------------------
create table private.member_status_history (
  id            bigint generated always as identity primary key,
  member_id     uuid not null references private.members (id) on delete cascade,
  changed_field text not null check (changed_field in ('verification_status','sanction','role')),
  old_value     text,
  new_value     text,
  reason        text,
  actor_id      uuid,
  created_at    timestamptz not null default now()
);
create index member_status_history_member on private.member_status_history (member_id, created_at desc);
alter table private.member_status_history enable row level security;
revoke all on private.member_status_history from anon, authenticated;

-- ------------------------------------------------------------
-- G. public: posts / comments (+ owners) — §5.2, §13
-- ------------------------------------------------------------
create table public.posts (
  id                  bigint generated always as identity primary key,
  board_id            smallint not null references public.boards (id),
  title               text not null check (char_length(title) between 1 and 100),
  body                text not null check (char_length(body) between 1 and 10000),
  author_nickname     text,            -- 익명 글이면 null (화면 '익명'), 탈퇴 시 null
  is_anonymous        boolean not null default false,
  comment_count       int not null default 0 check (comment_count >= 0),
  vote_count          int not null default 0 check (vote_count >= 0),
  view_count          int not null default 0 check (view_count >= 0),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz,
  deleted_at          timestamptz,     -- 작성자 삭제
  hidden_at           timestamptz,     -- 운영 숨김
  author_withdrawn_at timestamptz,     -- 작성자 탈퇴 (§13 — 정상 노출+표시 대체)
  check (author_withdrawn_at is null or author_nickname is null)   -- §10 v1.3
);
create index posts_board_list on public.posts (board_id, deleted_at, id desc);

create table public.comments (
  id                  bigint generated always as identity primary key,
  post_id             bigint not null references public.posts (id) on delete cascade,
  body                text not null check (char_length(body) between 1 and 2000),
  author_nickname     text,
  is_anonymous        boolean not null default false,
  anon_alias_no       smallint,        -- 익명 표시 번호 비정규화 (글쓴이=0)
  created_at          timestamptz not null default now(),
  updated_at          timestamptz,
  deleted_at          timestamptz,
  hidden_at           timestamptz,
  author_withdrawn_at timestamptz,
  check (author_withdrawn_at is null or author_nickname is null)
);
create index comments_post_list on public.comments (post_id, deleted_at, id);

-- owners: 작성자 연결 (private가 아닌 public에 두되 RLS로 본인 select만 — 기존 설계 계승)
create table public.post_owners (
  post_id    bigint primary key references public.posts (id) on delete cascade,
  user_id    uuid not null references private.members (id) on delete cascade,
  -- member FK cascade (GPT 검수 반영): 탈퇴 파이프라인 ⑦이 먼저 지우지만, cascade가 최종 방어선
  created_at timestamptz not null default now()
);
create index post_owners_user on public.post_owners (user_id);

create table public.comment_owners (
  comment_id bigint primary key references public.comments (id) on delete cascade,
  user_id    uuid not null references private.members (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index comment_owners_user on public.comment_owners (user_id);

alter table public.posts          enable row level security;
alter table public.comments       enable row level security;
alter table public.post_owners    enable row level security;
alter table public.comment_owners enable row level security;

revoke all on public.posts, public.comments, public.post_owners, public.comment_owners
  from anon, authenticated;
-- 컬럼 단위 권한 (GPT 검수 반영 — 트리거 의존을 줄이고 클라이언트 지정 가능 컬럼을 DDL로 제한)
-- DELETE 정책·권한 없음 = hard delete 불가
grant select on public.posts to authenticated;
grant insert (board_id, title, body, is_anonymous)  on public.posts to authenticated;
grant update (title, body, deleted_at)              on public.posts to authenticated;
grant select on public.comments to authenticated;
grant insert (post_id, body, is_anonymous)          on public.comments to authenticated;
grant update (body, deleted_at)                     on public.comments to authenticated;
-- author_nickname·author_withdrawn_at·hidden_at·카운터·created_at은 클라이언트 지정 불가 (definer·트리거만)
-- identity 직접 INSERT에 필요한 sequence만 개별 grant (전체 sequence 권한 복구 금지)
grant usage on sequence public.posts_id_seq    to authenticated;   -- TODO: 실제 시퀀스명 dev 확인
grant usage on sequence public.comments_id_seq to authenticated;   -- (identity는 pg_get_serial_sequence로 확인)
grant select on public.post_owners    to authenticated;
grant select on public.comment_owners to authenticated;

-- 함수 무의존 정책: owners 본인 select만
create policy post_owners_self on public.post_owners
  for select to authenticated using (user_id = auth.uid());
create policy comment_owners_self on public.comment_owners
  for select to authenticated using (user_id = auth.uid());
-- posts/comments의 select/insert/update 정책은 is_active_member()/is_writable_member()/
-- is_blocked_author() 의존 → 003에서 생성 (그 전까지 정책 0 = 전면 거부)

-- ------------------------------------------------------------
-- H. private: anon_aliases (§5.4)
-- ------------------------------------------------------------
create table private.anon_aliases (
  post_id   bigint not null references public.posts (id) on delete cascade,
  member_id uuid not null references private.members (id) on delete cascade,
  alias_no  smallint not null check (alias_no >= 0),   -- 글쓴이=0
  primary key (post_id, member_id),
  unique (post_id, alias_no)
);
alter table private.anon_aliases enable row level security;
revoke all on private.anon_aliases from anon, authenticated;

-- ------------------------------------------------------------
-- I. 상호작용: post_votes / bookmarks (public), post_views / blocks (private)
-- ------------------------------------------------------------
create table public.post_votes (
  post_id    bigint not null references public.posts (id) on delete cascade,
  member_id  uuid not null references private.members (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, member_id)    -- 1인 1글 1회 — 스키마 보장 (§2.9)
);
alter table public.post_votes enable row level security;
revoke all on public.post_votes from anon, authenticated;
grant select, insert, delete on public.post_votes to authenticated;
-- select 본인 행만 (남의 추천 여부 비공개) — 함수 무의존
create policy post_votes_self_select on public.post_votes
  for select to authenticated using (member_id = auth.uid());
-- insert/delete 정책은 is_writable_member() 의존 → 003

create table public.bookmarks (
  member_id  uuid not null references private.members (id) on delete cascade,
  post_id    bigint not null references public.posts (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (member_id, post_id)
);
alter table public.bookmarks enable row level security;
revoke all on public.bookmarks from anon, authenticated;
grant select, insert, delete on public.bookmarks to authenticated;
-- (GPT 검수 반영) 002는 본인 select만 — insert/delete 정책은 003에서
-- is_writable_member()+대상 post 열람 가능 조건과 함께 생성
create policy bookmarks_self_select on public.bookmarks
  for select to authenticated using (member_id = auth.uid());

create table private.post_views (
  post_id   bigint not null references public.posts (id) on delete cascade,
  member_id uuid not null references private.members (id) on delete cascade,
  primary key (post_id, member_id)    -- 회원 조회수 글당 1회 판정
);
alter table private.post_views enable row level security;
revoke all on private.post_views from anon, authenticated;

create table private.blocks (
  id         uuid primary key default gen_random_uuid(),   -- 외부 노출용 opaque id (§5.3 v1.3)
  blocker_id uuid not null references private.members (id) on delete cascade,
  blocked_id uuid not null references private.members (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index blocks_blocker on private.blocks (blocker_id);
create index blocks_blocked on private.blocks (blocked_id);
alter table private.blocks enable row level security;
revoke all on private.blocks from anon, authenticated;

-- ------------------------------------------------------------
-- J. private: 신고·사건·제재 (§5.5)
-- ------------------------------------------------------------
create table private.moderation_cases (
  id           bigint generated always as identity primary key,
  target_type  text not null check (target_type in ('post','comment')),
  target_id    bigint not null,
  status       text not null default 'open' check (status in ('open','resolved','dismissed')),
  report_count int not null default 0 check (report_count >= 0),
  emergency    boolean not null default false,
  opened_at    timestamptz not null default now(),
  closed_at    timestamptz,
  closed_by    uuid
);
-- open 사건은 대상당 1개 (partial unique — §5.5 v1.1 정정)
create unique index moderation_cases_one_open_target
  on private.moderation_cases (target_type, target_id) where status = 'open';
create index moderation_cases_status on private.moderation_cases (status, opened_at);

create table private.reports (
  id          bigint generated always as identity primary key,
  case_id     bigint not null references private.moderation_cases (id),
  reporter_id uuid references private.members (id) on delete set null,  -- 신고자 탈퇴 시 익명화·사건 보존
  reason_code text not null check (reason_code in
    ('abuse','hate','privacy','obscene_illegal','spam','fraud','misinfo','copyright','off_topic','other')),
  detail      text check (char_length(detail) <= 500),
  created_at  timestamptz not null default now(),
  unique (case_id, reporter_id)       -- 동일인 중복신고 방지 (reporter null은 unique 미적용 — 의도)
);
create index reports_case on private.reports (case_id);

create table private.case_snapshots (
  id          bigint generated always as identity primary key,
  case_id     bigint not null references private.moderation_cases (id),
  captured_at timestamptz not null default now(),
  content     text not null check (octet_length(content) <= 102400)  -- 실제 바이트 기준 100KB (GPT 검수)
);
create index case_snapshots_case on private.case_snapshots (case_id);

create table private.moderation_actions (
  id               bigint generated always as identity primary key,
  case_id          bigint not null references private.moderation_cases (id),
  action           text not null check (action in
    ('hide','restore','warn','write_restrict','suspend_7d','suspend_30d','ban','release','dismiss')),
  target_member_id uuid,              -- projection에서 미반환 (§5.5)
  actor_id         uuid not null,
  reason_code      text,              -- 표준화 코드 (GPT 검수 — 자유 서술과 구분)
  reason           text check (char_length(reason) <= 500),
  expires_at       timestamptz,       -- 제재성 조치의 만료 시점 (GPT 검수)
  created_at       timestamptz not null default now()
);
create index moderation_actions_case on private.moderation_actions (case_id, created_at);

create table private.audit_logs (
  id          bigint generated always as identity primary key,
  actor_id    uuid,
  action      text not null,
  target_type text,
  target_id   text,
  case_id     bigint,
  reason      text,
  created_at  timestamptz not null default now()
);
create index audit_logs_actor on private.audit_logs (actor_id, created_at desc);

alter table private.moderation_cases  enable row level security;
alter table private.reports           enable row level security;
alter table private.case_snapshots    enable row level security;
alter table private.moderation_actions enable row level security;
alter table private.audit_logs        enable row level security;
revoke all on private.moderation_cases, private.reports, private.case_snapshots,
  private.moderation_actions, private.audit_logs from anon, authenticated;

-- ------------------------------------------------------------
-- K. public: operational_messages (§5.6)
-- ------------------------------------------------------------
create table public.operational_messages (
  id         bigint generated always as identity primary key,
  member_id  uuid not null references private.members (id) on delete cascade,
  kind       text not null check (kind in
    ('verification_approved','verification_rejected','deletion_notice','warning',
     'sanction_notice','report_result','system')),
  title      text not null,
  body       text not null,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index operational_messages_member on public.operational_messages (member_id, created_at desc);
alter table public.operational_messages enable row level security;
revoke all on public.operational_messages from anon, authenticated;
grant select on public.operational_messages to authenticated;
create policy operational_messages_self on public.operational_messages
  for select to authenticated using (member_id = auth.uid());
-- 읽음 처리는 003의 mark_message_read RPC (직접 update 권한 없음)

-- ------------------------------------------------------------
-- K-2. private: policy_settings (GPT 2차 판정 Q2 — DB 소유 단일 정책 설정)
--      hold_retention_days가 null이면 hold가 필요한 탈퇴를 함수가 거부 (§12-3).
--      환경값을 클라이언트 인자로 받지 않기 위한 서버·DB 내부 설정.
-- ------------------------------------------------------------
create table private.policy_settings (
  key   text primary key,
  value text
);
insert into private.policy_settings (key, value) values ('hold_retention_days', null);
alter table private.policy_settings enable row level security;
revoke all on private.policy_settings from anon, authenticated;

-- 서버 작업 중복 실행 방지 lease (r4 — GPT 3차: Vercel Cron 중복 호출 대비)
create table private.maintenance_leases (
  job_name    text primary key,
  lease_token uuid,
  leased_until timestamptz,
  started_at  timestamptz
);
alter table private.maintenance_leases enable row level security;
revoke all on private.maintenance_leases from anon, authenticated;

-- 배치 실행 기록 (§9 — GPT 2차 §7: 기반 테이블이므로 002에 배치)
create table private.batch_runs (
  job_name        text primary key,
  last_success_at timestamptz,
  last_run_at     timestamptz,
  last_processed  int,
  fail_streak     int not null default 0,
  last_error      text
);
alter table private.batch_runs enable row level security;
revoke all on private.batch_runs from anon, authenticated;

-- ------------------------------------------------------------
-- L. private: guest_reads / guest_ip_daily (§8 — v1.3에서 ip_daily 정식 등재)
-- ------------------------------------------------------------
create table private.guest_reads (
  cookie_hmac text not null,
  post_id     bigint not null,        -- 의도적 FK 없음 (글 삭제와 무관하게 quota 기록 유지)
  read_date   date not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  primary key (cookie_hmac, post_id, read_date)
);
create index guest_reads_expires on private.guest_reads (expires_at);

create table private.guest_ip_daily (
  ip_hmac   text not null,
  read_date date not null,
  count     int not null default 0 check (count >= 0),
  primary key (ip_hmac, read_date)
);
create index guest_ip_daily_date on private.guest_ip_daily (read_date);

alter table private.guest_reads    enable row level security;
alter table private.guest_ip_daily enable row level security;
revoke all on private.guest_reads, private.guest_ip_daily from anon, authenticated;

commit;
