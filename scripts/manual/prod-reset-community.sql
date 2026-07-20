-- ============================================================
-- prod-reset-community.sql  v2 (P0-5 — GPT 검수 A-1~A-7 반영)
-- ============================================================
-- 목적: Gate 4a 재기반 직전, 운영 DB의 "snueapp 커뮤니티 객체만" 정확한
--       allowlist로 제거한다. 광범위 drop(drop schema public cascade 등) 금지.
--
-- 실행 조건 (전부 충족 전 실행 금지):
--   1) 사용자 문구 "GO-RESET-PROD jclwkvxbvsegmbcnptpi" 수신 후에만
--   2) BACKUP-OK 선행 (pg_dump + Auth export + Storage 증거)
--   3) SQL Editor 접속 대상이 운영 ref인지 화면에서 재확인
--   4) dev clean replay에서 본 스크립트 선시험 완료
--
-- 보존: auth.* / storage.*(객체 포함) / extensions·realtime 등 관리 스키마 /
--       프로젝트 API 키·Auth 설정 / allowlist 밖 public 객체 / pg_cron 확장 /
--       public.rls_auto_enable(A-4: 001~009 산출물이 아님 — 절대 삭제 금지)
-- 삭제: snueapp cron job 4종(jobid로) → private/authz 스키마(의존성 사전검사 후)
--       → public 앱 테이블 13종 → public 앱 함수 46종(정확 시그니처)
-- Auth 사용자·Storage 파일은 이 SQL로 삭제하지 않는다 (런북 Phase 5에서 별도)
--
-- 순서 근거(A-1): 002에 private→public FK(anon_aliases.post_id→posts,
--   post_views.post_id→posts 등)가 있어 public 테이블을 먼저 지우면 실패한다.
--   private/authz를 (사전검사 후) 먼저 CASCADE 제거 → public 순서로 간다.
--
-- 실패 시 대응: 어떤 단계든 예외 → 전체 자동 롤백(단일 트랜잭션).
--   즉석 수정·추가 drop 금지. 로그 저장 후 중단, dev 재현 후 동일 스크립트 재시도.
-- dev 시험 시(A-7): count 대신 auth.users.id / storage.objects(bucket_id,name)
--   집합 캡처·대조 + 유지보수 모드에서 실행을 권장. 본 스크립트의 count 불변
--   검증은 운영 최소 안전선이다.
-- ============================================================

begin;

-- ── [0] 기준 상태 캡처 (auth·storage 불변 검증 + rls_auto_enable 보존 확인용) ──
create temporary table _reset_baseline on commit drop as
select
  (select count(*) from auth.users)      as auth_users,
  (select count(*) from storage.objects) as storage_objects,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable') as rls_auto_enable_cnt;

-- ── [1] snueapp cron job 제거 (A-5: cron 스키마가 아예 없으면 skip, jobid로 전부) ──
do $$
declare
  r record;
begin
  if to_regclass('cron.job') is null then
    raise notice 'cron.job 없음 — pg_cron 미설치 상태, cron 단계 skip';
    return;
  end if;
  for r in
    select jobid from cron.job
    where jobname in ('expire_sanctions','purge_soft_deleted_content',
                      'purge_expired_holds','purge_expired_guest_reads')
  loop
    perform cron.unschedule(r.jobid);
  end loop;
end $$;

-- ── [2] private/authz CASCADE 전 외부 의존성 fail-closed 사전검사 (A-6) ──
--   두 스키마 내부가 "승인된 앱 객체뿐"임을 증명 못 하면 예외 → 전체 롤백.
do $$
declare
  bad text;
  priv_tables text[] := array[
    'anon_aliases','audit_logs','batch_runs','blocks','case_snapshots',
    'enforcement_holds','guest_ip_daily','guest_reads','maintenance_leases',
    'members','member_status_history','moderation_actions','moderation_cases',
    'policy_settings','post_views','reports','school_identities','verification_requests'];
  priv_fns text[] := array[
    'account_deletion_converged','acquire_maintenance_lease','actor_role_check',
    'begin_verification_impl','claim_accounts_for_deletion','claim_expired_uploads',
    'claim_guest_read_impl','claim_verification_docs_to_purge','content_author',
    'detach_member_content','expire_sanctions','expire_unreviewed_submissions',
    'finalize_verification_impl','get_member_verification_paths','handle_new_auth_user',
    'mark_member_verification_doc_purged','mark_verification_doc_purged',
    'on_comment_after_insert','on_comment_insert','on_comment_update',
    'on_post_after_insert','on_post_insert','on_post_update','on_vote_change',
    'prepare_account_deletion','purge_expired_guest_reads','purge_expired_holds',
    'purge_soft_deleted_content','record_batch_run','record_verification_purge_failure',
    'release_maintenance_lease','run_stale_review_notifications','target_within_limit',
    'validate_nickname',
    -- dev 테스트 스캐폴딩 잔재 허용(운영엔 없어야 정상이지만 있어도 앱 소유)
    '_assert','_assert_raises','_assert_ok'];
  authz_fns text[] := array[
    'board_access_ok','is_active_member','is_blocked_author',
    'is_writable_member','post_visible_to_me'];
begin
  if not exists (select 1 from pg_namespace where nspname in ('private','authz')) then
    raise notice 'private/authz 없음 — 스키마 단계는 no-op 예정';
    return;
  end if;

  -- 2-1) 내부 릴레이션: 승인된 테이블(+부속 시퀀스·인덱스·TOAST)만. 뷰·외부테이블 금지
  select string_agg(n.nspname || '.' || c.relname || '(' || c.relkind || ')', ', ')
    into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('private','authz')
    and c.relkind not in ('S','i','t')             -- 시퀀스·인덱스·TOAST는 테이블 부속
    and not (n.nspname = 'private' and c.relkind = 'r' and c.relname = any(priv_tables))
    and not (n.nspname = 'private' and c.relkind = 'r' and c.relname like '\_test\_%' escape '\');
  if bad is not null then
    raise exception 'reset pre-check failed: 예상 밖 릴레이션 존재 — %', bad;
  end if;

  -- 2-2) 내부 함수: 승인 목록만
  select string_agg(n.nspname || '.' || p.proname, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where (n.nspname = 'private' and not (p.proname = any(priv_fns)))
     or (n.nspname = 'authz'   and not (p.proname = any(authz_fns)));
  if bad is not null then
    raise exception 'reset pre-check failed: 예상 밖 함수 존재 — %', bad;
  end if;

  -- 2-3) 확장(extension)이 두 스키마에 설치되어 있으면 중단
  select string_agg(e.extname, ', ') into bad
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  where n.nspname in ('private','authz');
  if bad is not null then
    raise exception 'reset pre-check failed: 스키마에 extension 설치됨 — %', bad;
  end if;

  -- 2-4) 외부 뷰가 두 스키마의 릴레이션을 참조하면 중단 (CASCADE 연쇄 삭제 방지)
  select string_agg(distinct dn.nspname || '.' || dc.relname, ', ') into bad
  from pg_depend d
  join pg_rewrite rw on rw.oid = d.objid and d.classid = 'pg_rewrite'::regclass
  join pg_class dc on dc.oid = rw.ev_class
  join pg_namespace dn on dn.oid = dc.relnamespace
  join pg_class rc on rc.oid = d.refobjid and d.refclassid = 'pg_class'::regclass
  join pg_namespace rn on rn.oid = rc.relnamespace
  where rn.nspname in ('private','authz')
    and dn.nspname not in ('private','authz');
  if bad is not null then
    raise exception 'reset pre-check failed: 외부 뷰가 앱 스키마 참조 — %', bad;
  end if;
end $$;

-- ── [3] 앱 전용 스키마 제거 (사전검사 통과 후에만 도달) ──
--   auth.users 위 on_auth_user_created 트리거는 private.handle_new_auth_user에
--   의존하므로 함께 제거된다(승인된 연쇄 — 003 재적용 시 재생성).
drop schema if exists private cascade;
drop schema if exists authz cascade;

-- ── [4] public 앱 테이블 allowlist 드롭 (자식→부모 순, CASCADE 없음 =
--        예상 밖 의존물이 남아 있으면 실패→전체 롤백되는 fail-closed) ──
do $$
declare
  t text;
begin
  foreach t in array array[
    -- 신 스키마 (부분 적용 잔여 대비; comments/posts 등 구·신 동명 겸용)
    'bookmarks', 'post_votes', 'comment_owners', 'comments',
    'post_owners', 'posts', 'operational_messages', 'boards',
    -- 구 스키마 전용
    'profiles'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop table public.%I', t);
    end if;
  end loop;
end $$;

-- ── [5] public 앱 함수 46종 — 정확한 identity 시그니처로만 드롭 (A-2·A-3) ──
--   같은 이름의 "allowlist에 없는 overload"가 발견되면 실행 전에 예외.
--   rls_auto_enable은 목록에 없다(A-4 — 앱 산출물 아님, 보존).
do $$
declare
  sigs text[] := array[
    -- 구 스키마 트리거 함수 7종 (schema.sql)
    'public.enforce_snue_email()',
    'public.handle_new_post()',
    'public.record_post_owner()',
    'public.handle_post_update()',
    'public.handle_new_comment()',
    'public.record_comment_owner()',
    'public.handle_comment_update()',
    -- 신 스키마 public 함수 39종 (003·004·007·009 — 2026-07-20 추출·GPT 계수 일치)
    'public.account_deletion_converged(uuid)',
    'public.acquire_maintenance_lease(text, integer)',
    'public.admin_reveal_author(bigint, text, bigint, text)',
    'public.apply_sanction(bigint, text, text)',
    'public.begin_verification(uuid, text[], smallint[], smallint, text, text, text)',
    'public.block_author(text, bigint)',
    'public.change_nickname(text)',
    'public.claim_accounts_for_deletion(integer)',
    'public.claim_expired_uploads(integer)',
    'public.claim_guest_read(text, text, bigint, integer)',
    'public.claim_verification_docs_to_purge(integer)',
    'public.close_case(bigint, text, text)',
    'public.detach_member_content(uuid)',
    'public.expire_unreviewed_submissions(integer)',
    'public.finalize_verification(uuid, bigint)',
    'public.get_case(bigint)',
    'public.get_member_verification_paths(uuid)',
    'public.get_my_member()',
    'public.get_my_verification_requests()',
    'public.grant_role(uuid, text, text)',
    'public.list_my_blocks()',
    'public.list_verification_requests()',
    'public.mark_member_verification_doc_purged(bigint, uuid)',
    'public.mark_message_read(bigint)',
    'public.mark_verification_doc_purged(bigint)',
    'public.moderate_content(bigint, text, text)',
    'public.prepare_account_deletion(uuid)',
    'public.record_maintenance_run(text, boolean, integer, text)',
    'public.record_member_view(bigint)',
    'public.record_verification_purge_failure(bigint, text)',
    'public.release_maintenance_lease(text, uuid)',
    'public.review_verification(bigint, boolean, text)',
    'public.run_stale_review_notifications(integer)',
    'public.set_initial_nickname(text)',
    'public.soft_delete_comment(bigint)',
    'public.soft_delete_post(bigint)',
    'public.submit_report(text, bigint, text, text)',
    'public.unblock_author(uuid)',
    'public.withdraw_verification(bigint)'
  ];
  names text[];
  s text;
  fn regprocedure;
  bad text;
begin
  -- 이름 집합 도출 (overload 검사용)
  select array_agg(distinct (regexp_match(x, '^public\.([a-z_0-9]+)\('))[1])
    into names from unnest(sigs) x;

  -- 5-1) 먼저 overload 검사: allowlist 이름과 같은 이름인데 시그니처가 목록에 없는
  --      함수가 존재하면 아무것도 지우기 전에 예외 (fail-closed)
  select string_agg(p.oid::regprocedure::text, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = any(names)
    and not (p.oid::regprocedure::text = any(
      select to_regprocedure(y)::text from unnest(sigs) y where to_regprocedure(y) is not null));
  if bad is not null then
    raise exception 'reset pre-check failed: allowlist 밖 overload 존재 — %', bad;
  end if;

  -- 5-2) 정확 시그니처만 드롭 (없으면 skip)
  foreach s in array sigs loop
    fn := to_regprocedure(s);
    if fn is not null then
      execute format('drop function %s', fn);
    end if;
  end loop;
end $$;

-- ── [6] 사후검증: 하나라도 실패하면 예외 → 전체 롤백 ──
do $$
declare
  leftover int;
  base record;
  now_auth bigint;
  now_storage bigint;
  now_rls int;
begin
  -- 6-1) allowlist 테이블 잔존 0
  select count(*) into leftover
  from pg_tables
  where schemaname = 'public'
    and tablename in ('bookmarks','post_votes','comment_owners','comments',
                      'post_owners','posts','operational_messages','boards','profiles');
  if leftover <> 0 then
    raise exception 'reset failed: % allowlist tables remain', leftover;
  end if;

  -- 6-2) 앱 함수 잔존 0 (이름 기준 전수 — 드롭과 같은 근원 목록)
  select count(*) into leftover
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('enforce_snue_email','handle_new_post','record_post_owner',
      'handle_post_update','handle_new_comment','record_comment_owner','handle_comment_update',
      'account_deletion_converged','acquire_maintenance_lease','admin_reveal_author',
      'apply_sanction','begin_verification','block_author','change_nickname',
      'claim_accounts_for_deletion','claim_expired_uploads','claim_guest_read',
      'claim_verification_docs_to_purge','close_case','detach_member_content',
      'expire_unreviewed_submissions','finalize_verification','get_case',
      'get_member_verification_paths','get_my_member','get_my_verification_requests',
      'grant_role','list_my_blocks','list_verification_requests',
      'mark_member_verification_doc_purged','mark_message_read','mark_verification_doc_purged',
      'moderate_content','prepare_account_deletion','record_maintenance_run',
      'record_member_view','record_verification_purge_failure','release_maintenance_lease',
      'review_verification','run_stale_review_notifications','set_initial_nickname',
      'soft_delete_comment','soft_delete_post','submit_report','unblock_author',
      'withdraw_verification');
  if leftover <> 0 then
    raise exception 'reset failed: % app functions remain', leftover;
  end if;

  -- 6-3) private·authz 스키마 잔존 0
  select count(*) into leftover from pg_namespace where nspname in ('private','authz');
  if leftover <> 0 then
    raise exception 'reset failed: app schemas remain';
  end if;

  -- 6-4) snueapp cron job 잔존 0 (cron 스키마가 있을 때만 — A-5)
  if to_regclass('cron.job') is not null then
    select count(*) into leftover
    from cron.job
    where jobname in ('expire_sanctions','purge_soft_deleted_content',
                      'purge_expired_holds','purge_expired_guest_reads');
    if leftover <> 0 then
      raise exception 'reset failed: cron jobs remain';
    end if;
  end if;

  -- 6-5) auth.users / storage.objects / rls_auto_enable 불변 (사전 캡처와 정확 일치)
  select * into base from _reset_baseline;
  select count(*) into now_auth from auth.users;
  select count(*) into now_storage from storage.objects;
  select count(*) into now_rls
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'rls_auto_enable';
  if now_auth <> base.auth_users then
    raise exception 'reset failed: auth.users count changed (% -> %)', base.auth_users, now_auth;
  end if;
  if now_storage <> base.storage_objects then
    raise exception 'reset failed: storage.objects count changed (% -> %)', base.storage_objects, now_storage;
  end if;
  if now_rls <> base.rls_auto_enable_cnt then
    raise exception 'reset failed: rls_auto_enable 보존 실패 (% -> %) — A-4 위반', base.rls_auto_enable_cnt, now_rls;
  end if;
end $$;

commit;

-- COMMIT 후 별도 확인(성공 배너를 믿지 말 것):
--   select table_schema, table_name from information_schema.tables
--    where table_schema in ('public','private','authz') order by 1,2;
--   select jobname from cron.job order by 1;                    -- cron 있으면
--   select count(*) from auth.users;          -- reset 전과 동일해야 함
--   select count(*) from storage.objects;     -- reset 전과 동일해야 함
