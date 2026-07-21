-- ============================================================
-- 013_bug_report.sql — 버그제보 칸
--
-- ⚠️ PENDING 초안. 운영·dev 미적용. 동결 RC(001~009) 무접촉.
--
-- 사용자 요청 "버그제보 칸". 커뮤니티 신고(private.reports)와는 **완전히 별개**다:
--   · 신고 = 다른 회원의 콘텐츠에 대한 모더레이션 사건
--   · 버그제보 = 앱 자체의 결함 보고. 대상이 사람이 아니라 제품이다.
--   섞으면 모더레이션 사건 통계가 오염되고, 버그 제보자가 "신고자"로 집계된다.
--
-- 개인정보 관점 (헌장 §2 최소수집):
--   자동 수집은 **앱 화면 경로와 앱 버전까지만**. User-Agent 원문·IP·기기지문은
--   저장하지 않는다. 재현에 필요한 서술은 이용자가 직접 쓴다.
-- ============================================================

begin;

create table if not exists private.bug_reports (
  id          bigserial primary key,

  -- 탈퇴해도 제보는 남긴다(제품 개선 기록). 연결만 끊는다.
  member_id   uuid references private.members (id) on delete set null,
  reporter_withdrawn_at timestamptz,

  category    text not null check (category in
                ('crash','wrong_data','ui_broken','login','performance','suggestion','other')),
  -- (013-R2) 제목은 한 줄이다 — 줄바꿈·제어문자 금지
  title       text not null check (btrim(title) <> '' and char_length(title) between 2 and 100
                and title !~ E'[\x01-\x1F\x7F]'),
  detail      text not null check (btrim(detail) <> '' and char_length(detail) between 5 and 2000
                and detail !~ E'[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'),

  -- 자동 수집 최소 항목 (개인 식별 불가)
  app_path    text check (app_path is null or app_path ~ '^/[A-Za-z0-9/_\-\[\]]{0,100}$'),
  app_version text check (app_version is null or app_version ~ '^[A-Za-z0-9._+-]{1,40}$'),

  -- expired_unattended는 "운영 판단"이 아니라 **방치**다. wont_fix로 뭉뚱그리면
  -- 검토해서 안 고치기로 한 것과 아무도 안 본 것이 구분되지 않는다. (013-R6)
  status      text not null default 'open' check (status in
                ('open','triaged','in_progress','resolved','wont_fix','duplicate','expired_unattended')),
  duplicate_of bigint references private.bug_reports (id),
  operator_note text check (operator_note is null or
                 (btrim(operator_note) <> '' and char_length(operator_note) <= 1000
                  and operator_note !~ E'[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]')),
  handled_by  uuid references private.members (id) on delete set null,
  handled_at  timestamptz,

  -- (013-R5) 철회 시 본문을 비식별화한다. 상태행만 남기고 내용은 지운다.
  withdrawn_at timestamptz,
  -- (013-R3/R5) 보존기한 — 종결·철회 시점을 기준으로 파기 배치가 사용
  purge_after timestamptz,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- duplicate 상태와 원본 지정이 어긋나지 않게
  check ((status = 'duplicate') = (duplicate_of is not null)),
  check (duplicate_of is null or duplicate_of <> id),
  -- (013-R4) 종결이면 처리시각 필수, **비종결이면 처리시각이 남아 있으면 안 된다**
  -- (종결에서 open으로 되돌릴 때 옛 handled_at이 남는 것을 막는다)
  check (
    (status in ('resolved','wont_fix','duplicate','expired_unattended') and handled_at is not null)
    or (status in ('open','triaged','in_progress') and handled_at is null)
  )
);

create index if not exists bug_reports_open on private.bug_reports (created_at desc) where status = 'open';
create index if not exists bug_reports_member on private.bug_reports (member_id);

-- 도배 방지: 한 회원이 10분에 3건까지
create index if not exists bug_reports_member_recent on private.bug_reports (member_id, created_at desc);

alter table private.bug_reports enable row level security;
revoke all on private.bug_reports from anon, authenticated;

-- ------------------------------------------------------------
-- 제보 (일반 회원)
--   is_writable_member가 아니라 "로그인 + 닉네임 있음"까지만 요구한다.
--   글쓰기 제한 중이어도 버그는 제보할 수 있어야 한다 — 오히려 제재 관련
--   버그를 겪는 사람이 제보해야 할 이유가 크다. (신고를 write_restricted에도
--   허용하는 기존 정책과 같은 결)
-- ------------------------------------------------------------
create or replace function public.submit_bug_report(
  p_category text, p_title text, p_detail text,
  p_app_path text default null, p_app_version text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_recent int;
begin
  -- 커뮤니티 작성 권한은 요구하지 않는다. 제재 관련 버그를 겪는 사람이 제보해야 하므로
  -- write_restricted·community_suspended도 허용하고, banned와 삭제 진행 중만 막는다.
  -- ★ (013-R1) 회원 행을 잠근 뒤 세야 한다. 잠그지 않으면 동시 4건이 모두
  --    "최근 2건"만 보고 상한을 함께 통과한다.
  perform 1 from private.members m
   where m.id = auth.uid() and m.nickname is not null
     and m.sanction <> 'banned' and m.verification_status <> 'deleting'
   for update;
  if not found then raise exception 'not allowed'; end if;

  select count(*) into v_recent from private.bug_reports b
   where b.member_id = auth.uid() and b.created_at > now() - interval '10 minutes';
  if v_recent >= 3 then
    return jsonb_build_object('status','rate_limited');
  end if;

  insert into private.bug_reports (member_id, category, title, detail, app_path, app_version)
  values (auth.uid(), p_category, btrim(p_title), btrim(p_detail),
          nullif(btrim(coalesce(p_app_path,'')), ''), nullif(btrim(coalesce(p_app_version,'')), ''));

  return jsonb_build_object('status','received');
end $$;
revoke execute on function public.submit_bug_report(text, text, text, text, text)
  from public, anon, authenticated;
grant  execute on function public.submit_bug_report(text, text, text, text, text) to authenticated;

-- 내가 낸 제보 보기 (처리 상태 확인 — 제보하고 끝이면 다시 안 쓴다)
create or replace function public.list_my_bug_reports()
returns table (id bigint, category text, title text, status text, created_at timestamptz, handled_at timestamptz)
language sql security definer set search_path='' stable as $$
  select b.id, b.category, b.title, b.status, b.created_at, b.handled_at
    from private.bug_reports b
   where b.member_id = auth.uid()
   order by b.created_at desc
   limit 50;
$$;
revoke execute on function public.list_my_bug_reports() from public, anon, authenticated;
grant  execute on function public.list_my_bug_reports() to authenticated;

-- ------------------------------------------------------------
-- 운영자 처리
-- ------------------------------------------------------------
create or replace function public.triage_bug_report(
  p_id bigint, p_status text, p_note text default null, p_duplicate_of bigint default null)
returns void language plpgsql security definer set search_path='' as $$
declare v_role text; v_cur private.bug_reports%rowtype; v_dup private.bug_reports%rowtype;
        v_terminal boolean;
begin
  select m.role into v_role from private.members m
   where m.id = auth.uid() and m.verification_status = 'verified' and m.sanction = 'none';
  if v_role is null or v_role not in ('operator','owner') then raise exception 'not allowed'; end if;
  if p_status not in ('open','triaged','in_progress','resolved','wont_fix','duplicate') then
    raise exception 'invalid status';
  end if;
  if (p_status = 'duplicate') <> (p_duplicate_of is not null) then
    raise exception 'duplicate status requires duplicate_of (and vice versa)';
  end if;

  -- (013-R4) 운영자 간 "마지막 쓰기 승리"를 막기 위해 대상 행을 잠근다.
  -- 두 행을 잡을 때는 **id 오름차순**으로 — A→B와 B→A를 동시에 처리할 때
  -- 불필요한 교착을 줄인다(FOLLOW-UP).
  if p_duplicate_of is not null and p_duplicate_of < p_id then
    perform 1 from private.bug_reports b where b.id = p_duplicate_of for update;
  end if;
  select * into v_cur from private.bug_reports b where b.id = p_id for update;
  if v_cur.id is null then raise exception 'not found'; end if;
  if v_cur.withdrawn_at is not null then raise exception 'report was withdrawn'; end if;

  v_terminal := p_status in ('resolved','wont_fix','duplicate');
  -- 종결 결정에는 사유가 필요하다
  if v_terminal and coalesce(btrim(p_note), '') = '' then
    raise exception 'reason required to close a report';
  end if;

  -- (013-R3) duplicate 순환·연쇄 차단
  if p_duplicate_of is not null then
    if p_duplicate_of = p_id then raise exception 'cannot mark as duplicate of itself'; end if;
    select * into v_dup from private.bug_reports b where b.id = p_duplicate_of for update;
    if v_dup.id is null then raise exception 'duplicate target not found'; end if;
    -- 대상이 이미 duplicate면 사슬이 생긴다 → canonical 원본을 지정하게 한다
    if v_dup.status = 'duplicate' then
      raise exception 'duplicate target is itself a duplicate — point to the canonical report';
    end if;
    -- 대상이 이 제보를 원본으로 가리키고 있으면 순환
    if v_dup.duplicate_of = p_id then raise exception 'circular duplicate reference'; end if;
    -- 이 제보를 원본으로 삼는 다른 제보가 있으면 사슬이 된다
    if exists (select 1 from private.bug_reports b where b.duplicate_of = p_id) then
      raise exception 'this report is a canonical original for others';
    end if;
  end if;

  update private.bug_reports b
     set status = p_status,
         operator_note = coalesce(nullif(btrim(coalesce(p_note,'')), ''), b.operator_note),
         duplicate_of = p_duplicate_of,
         handled_by = case when v_terminal then auth.uid() else null end,
         -- 비종결로 되돌리면 처리시각도 함께 지운다 (CHECK와 정합)
         handled_at = case when v_terminal then clock_timestamp() else null end,
         purge_after = case when v_terminal then clock_timestamp() + interval '12 months' else null end,
         updated_at = clock_timestamp()
   where b.id = p_id;

  insert into private.audit_logs (actor_id, action, target_type, target_id, reason)
  values (auth.uid(), 'bug_report:' || p_status, 'bug_report', p_id::text, p_note);
end $$;
revoke execute on function public.triage_bug_report(bigint, text, text, bigint)
  from public, anon, authenticated;
grant  execute on function public.triage_bug_report(bigint, text, text, bigint) to authenticated;

-- ------------------------------------------------------------
-- (013-R5) 본인 철회 — 제재 상태와 무관하게 가능
--   탈퇴로 member_id만 비우면 제목·상세 속 개인정보가 계속 남는다.
--   철회하면 내용을 즉시 비식별화하고 상태행만 남긴 뒤 30일 후 파기한다.
-- ------------------------------------------------------------
create or replace function public.withdraw_bug_report(p_id bigint)
returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'not allowed'; end if;
  update private.bug_reports b
     set withdrawn_at = clock_timestamp(),
         title  = '(철회된 제보)',
         detail = '(철회로 삭제됨)',
         app_path = null,
         app_version = null,
         operator_note = null,
         purge_after = clock_timestamp() + interval '30 days',
         updated_at = clock_timestamp()
   where b.id = p_id and b.member_id = auth.uid() and b.withdrawn_at is null;
  -- 없거나 타인 것이면 no-op (존재 정보 비노출)
end $$;
revoke execute on function public.withdraw_bug_report(bigint) from public, anon, authenticated;
grant  execute on function public.withdraw_bug_report(bigint) to authenticated;

-- ------------------------------------------------------------
-- (013-R6) 방치된 제보 자동 종료
--   open/triaged/in_progress가 영구히 남으면 개인정보가 무기한 존속한다.
--   24개월 미처리면 expired_unattended로 닫고 12개월 뒤 파기 예약.
--   ※ wont_fix로 닫지 않는다 — "검토해서 안 고치기로 함"과 "아무도 안 봄"은 다르다.
-- ------------------------------------------------------------
create or replace function public.job_expire_unattended_bug_reports()
returns integer language plpgsql security definer set search_path='' as $$
declare v_n integer;
begin
  update private.bug_reports b
     set status = 'expired_unattended',
         handled_at = clock_timestamp(),
         purge_after = clock_timestamp() + interval '12 months',
         updated_at = clock_timestamp()
   where b.status in ('open','triaged','in_progress')
     and b.updated_at < now() - interval '24 months';
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke execute on function public.job_expire_unattended_bug_reports() from public, anon, authenticated;
grant  execute on function public.job_expire_unattended_bug_reports() to service_role;

-- ------------------------------------------------------------
-- (013-R7) 보존기한 지난 제보 파기 — duplicate 계열 순서 주의
--   canonical이 먼저 지워지면 이를 참조하는 duplicate 행의 FK 때문에 배치가 실패한다.
--   ON DELETE CASCADE는 쓰지 않는다 — 아직 기한이 남은 제보까지 지워버린다.
--   → ①자식 duplicate 먼저 ②그 계열이 전부 만료된 canonical만 나중에.
-- ------------------------------------------------------------
create or replace function public.job_purge_bug_reports(p_limit int default 500)
returns integer language plpgsql security definer set search_path='' as $$
declare v_child int; v_parent int;
begin
  -- ① 자식(duplicate) 먼저
  delete from private.bug_reports b
   where b.id in (
     select b2.id from private.bug_reports b2
      where b2.purge_after is not null and b2.purge_after <= now()
        and b2.duplicate_of is not null
      limit greatest(p_limit, 1));
  get diagnostics v_child = row_count;

  -- ② canonical은 자신을 참조하는 제보가 하나도 안 남았을 때만
  delete from private.bug_reports b
   where b.id in (
     select b2.id from private.bug_reports b2
      where b2.purge_after is not null and b2.purge_after <= now()
        and b2.duplicate_of is null
        and not exists (select 1 from private.bug_reports c where c.duplicate_of = b2.id)
      limit greatest(p_limit, 1));
  get diagnostics v_parent = row_count;

  return v_child + v_parent;
end $$;
revoke execute on function public.job_purge_bug_reports(int) from public, anon, authenticated;
grant  execute on function public.job_purge_bug_reports(int) to service_role;

-- 탈퇴 시 제보는 남기고 연결만 끊는다 (010과 같은 원칙)
create or replace function private.mark_bug_reporter_withdrawn()
returns trigger language plpgsql set search_path='' as $$
begin
  if old.member_id is not null and new.member_id is null and new.reporter_withdrawn_at is null then
    new.reporter_withdrawn_at := clock_timestamp();
  end if;
  return new;
end $$;
revoke execute on function private.mark_bug_reporter_withdrawn() from public, anon, authenticated;

drop trigger if exists bug_reports_mark_withdrawn on private.bug_reports;
create trigger bug_reports_mark_withdrawn
  before update on private.bug_reports
  for each row execute function private.mark_bug_reporter_withdrawn();

commit;

-- ============================================================
-- 다음 배치
--  · 화면: 설정 탭의 "버그 신고" 진입 + 내 제보 목록
--  · 운영자 콘솔의 제보함 (Gate 6 모더레이션 콘솔과 함께)
--  · 스크린샷 첨부는 **넣지 않는다** — 화면 캡처에 타인 글·개인정보가 섞여 들어오는
--    경로가 되므로, 필요해지면 별도 게이트에서 보존기한·검토절차와 함께 설계한다.
-- ============================================================
