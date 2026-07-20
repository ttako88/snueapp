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
  title       text not null check (btrim(title) <> '' and char_length(title) between 2 and 100),
  detail      text not null check (btrim(detail) <> '' and char_length(detail) between 5 and 2000
                and detail !~ E'[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'),

  -- 자동 수집 최소 항목 (개인 식별 불가)
  app_path    text check (app_path is null or app_path ~ '^/[A-Za-z0-9/_\-\[\]]{0,100}$'),
  app_version text check (app_version is null or char_length(app_version) <= 40),

  status      text not null default 'open' check (status in
                ('open','triaged','in_progress','resolved','wont_fix','duplicate')),
  duplicate_of bigint references private.bug_reports (id),
  operator_note text check (operator_note is null or char_length(operator_note) <= 1000),
  handled_by  uuid references private.members (id) on delete set null,
  handled_at  timestamptz,

  created_at  timestamptz not null default now(),

  -- duplicate 상태와 원본 지정이 어긋나지 않게
  check ((status = 'duplicate') = (duplicate_of is not null)),
  check (duplicate_of is null or duplicate_of <> id),
  -- 종결 상태면 처리 시각이 있어야 한다
  check (status not in ('resolved','wont_fix','duplicate') or handled_at is not null)
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
  if not exists (select 1 from private.members m
                  where m.id = auth.uid() and m.nickname is not null
                    and m.sanction <> 'banned') then
    raise exception 'not allowed';
  end if;

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
declare v_role text;
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

  update private.bug_reports b
     set status = p_status,
         operator_note = coalesce(nullif(btrim(coalesce(p_note,'')), ''), b.operator_note),
         duplicate_of = p_duplicate_of,
         handled_by = auth.uid(),
         handled_at = case when p_status in ('resolved','wont_fix','duplicate')
                           then clock_timestamp() else b.handled_at end
   where b.id = p_id;
  if not found then raise exception 'not found'; end if;

  insert into private.audit_logs (actor_id, action, target_type, target_id, reason)
  values (auth.uid(), 'bug_report:' || p_status, 'bug_report', p_id::text, p_note);
end $$;
revoke execute on function public.triage_bug_report(bigint, text, text, bigint)
  from public, anon, authenticated;
grant  execute on function public.triage_bug_report(bigint, text, text, bigint) to authenticated;

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
