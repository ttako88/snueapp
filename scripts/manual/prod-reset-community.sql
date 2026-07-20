-- ============================================================
-- prod-reset-community.sql  v3 (P0-5 — GPT 재검수 A-R1~A-R4 반영)
-- ============================================================
-- 목적: Gate 4a 재기반 직전, 운영 DB의 "snueapp 커뮤니티 객체만" 정확한
--       allowlist로 제거한다. 광범위 drop(drop schema public cascade 등) 금지.
--
-- 실행 조건 (전부 충족 전 실행 금지):
--   1) 사용자 문구 "GO-RESET-PROD jclwkvxbvsegmbcnptpi" 수신 후에만
--   2) BACKUP-OK 선행 (pg_dump + Auth export + Storage 증거)
--      + Production 읽기전용 인벤토리에서 "테스트 테이블(_test_*) 0개" 확인 게이트(A-R4)
--   3) SQL Editor 접속 대상이 운영 ref인지 화면에서 재확인
--   4) dev clean replay에서 본 스크립트 선시험 완료
--      (dev 시험 시 A-7/B-F3: auth.users.id·storage.objects(bucket_id,name)
--       "식별자 집합" 사전·사후 대조를 실제 수행하고 결과를 ledger에 기록.
--       본 스크립트의 count 불변 검증은 운영 최소 안전선.)
--
-- 보존: auth.* / storage.*(객체 포함) / extensions·realtime 등 관리 스키마 /
--       프로젝트 API 키·Auth 설정 / allowlist 밖 public 객체 / pg_cron 확장 /
--       public.rls_auto_enable(A-4: 001~009 산출물이 아님 — 절대 삭제 금지)
-- 삭제: (모든 사전검사 통과 후에만) snueapp cron 4종 → private/authz 스키마
--       → public 앱 테이블 9종(신8+구1) → public 앱 함수 46종(정확 시그니처)
-- Auth 사용자·Storage 파일은 이 SQL로 삭제하지 않는다 (런북 Phase 5에서 별도)
--
-- v3 구조 (A-R2: "어떤 DROP보다 먼저 검사 전부"):
--   [0] 기준 캡처 → [1] 단일 근원 allowlist 임시테이블(A-R3)
--   → [2] 사전검사 전부(overload·내부 릴레이션/함수 시그니처·시퀀스 소유·
--          extension·pg_depend 전수 외부의존 분류(A-R1)) — 하나라도 실패 시 여기서 끝
--   → [3] cron → [4] 스키마 → [5] 테이블 → [6] 함수 → [7] 사후검증 → COMMIT
--
-- 실패 시 대응: 어떤 단계든 예외 → 전체 자동 롤백(단일 트랜잭션).
--   즉석 수정·추가 drop 금지. 로그 저장 후 중단, dev 재현 후 동일 스크립트 재시도.
-- ============================================================

begin;

-- ── [0] 기준 상태 캡처 ──
create temporary table _reset_baseline on commit drop as
select
  (select count(*) from auth.users)      as auth_users,
  (select count(*) from storage.objects) as storage_objects,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable') as rls_auto_enable_cnt;

-- ── [1] 단일 근원 allowlist (A-R3: 사전검사·삭제·사후검증이 전부 이 테이블만 사용) ──
create temporary table _reset_allowlist (
  kind       text not null,   -- public_table | public_function | private_table | test_table | app_function | cron_job
  name       text,            -- 테이블·cron·함수 이름 (함수는 시그니처에서 파생)
  signature  text,            -- 함수 전용: identity signature
  generation text,            -- legacy | new | scaffold
  drop_ord   int              -- public_table 삭제 순서(자식→부모)
) on commit drop;

insert into _reset_allowlist (kind, name, generation, drop_ord) values
  -- public 앱 테이블 9종 (신8 + legacy profiles 1) — 자식→부모 순
  ('public_table','bookmarks','new',1), ('public_table','post_votes','new',2),
  ('public_table','comment_owners','new',3), ('public_table','comments','new',4),
  ('public_table','post_owners','new',5), ('public_table','posts','new',6),
  ('public_table','operational_messages','new',7), ('public_table','boards','new',8),
  ('public_table','profiles','legacy',9),
  -- private 앱 테이블 18종
  ('private_table','anon_aliases','new',null), ('private_table','audit_logs','new',null),
  ('private_table','batch_runs','new',null), ('private_table','blocks','new',null),
  ('private_table','case_snapshots','new',null), ('private_table','enforcement_holds','new',null),
  ('private_table','guest_ip_daily','new',null), ('private_table','guest_reads','new',null),
  ('private_table','maintenance_leases','new',null), ('private_table','members','new',null),
  ('private_table','member_status_history','new',null), ('private_table','moderation_actions','new',null),
  ('private_table','moderation_cases','new',null), ('private_table','policy_settings','new',null),
  ('private_table','post_views','new',null), ('private_table','reports','new',null),
  ('private_table','school_identities','new',null), ('private_table','verification_requests','new',null),
  -- dev 테스트 테이블: 정확한 이름만 (A-R4 — wildcard 폐기. 운영에선 0개가 정상)
  ('test_table','_test_results','scaffold',null),
  -- snueapp cron job 4종
  ('cron_job','expire_sanctions','new',null), ('cron_job','purge_soft_deleted_content','new',null),
  ('cron_job','purge_expired_holds','new',null), ('cron_job','purge_expired_guest_reads','new',null);

insert into _reset_allowlist (kind, signature, name, generation) values
  -- 구 스키마 public 트리거 함수 7종
  ('public_function','public.enforce_snue_email()','enforce_snue_email','legacy'),
  ('public_function','public.handle_new_post()','handle_new_post','legacy'),
  ('public_function','public.record_post_owner()','record_post_owner','legacy'),
  ('public_function','public.handle_post_update()','handle_post_update','legacy'),
  ('public_function','public.handle_new_comment()','handle_new_comment','legacy'),
  ('public_function','public.record_comment_owner()','record_comment_owner','legacy'),
  ('public_function','public.handle_comment_update()','handle_comment_update','legacy'),
  -- 신 스키마 public 함수 39종 (003·004·007·009 추출 — GPT 계수 일치)
  ('public_function','public.account_deletion_converged(uuid)','account_deletion_converged','new'),
  ('public_function','public.acquire_maintenance_lease(text, integer)','acquire_maintenance_lease','new'),
  ('public_function','public.admin_reveal_author(bigint, text, bigint, text)','admin_reveal_author','new'),
  ('public_function','public.apply_sanction(bigint, text, text)','apply_sanction','new'),
  ('public_function','public.begin_verification(uuid, text[], smallint[], smallint, text, text, text)','begin_verification','new'),
  ('public_function','public.block_author(text, bigint)','block_author','new'),
  ('public_function','public.change_nickname(text)','change_nickname','new'),
  ('public_function','public.claim_accounts_for_deletion(integer)','claim_accounts_for_deletion','new'),
  ('public_function','public.claim_expired_uploads(integer)','claim_expired_uploads','new'),
  ('public_function','public.claim_guest_read(text, text, bigint, integer)','claim_guest_read','new'),
  ('public_function','public.claim_verification_docs_to_purge(integer)','claim_verification_docs_to_purge','new'),
  ('public_function','public.close_case(bigint, text, text)','close_case','new'),
  ('public_function','public.detach_member_content(uuid)','detach_member_content','new'),
  ('public_function','public.expire_unreviewed_submissions(integer)','expire_unreviewed_submissions','new'),
  ('public_function','public.finalize_verification(uuid, bigint)','finalize_verification','new'),
  ('public_function','public.get_case(bigint)','get_case','new'),
  ('public_function','public.get_member_verification_paths(uuid)','get_member_verification_paths','new'),
  ('public_function','public.get_my_member()','get_my_member','new'),
  ('public_function','public.get_my_verification_requests()','get_my_verification_requests','new'),
  ('public_function','public.grant_role(uuid, text, text)','grant_role','new'),
  ('public_function','public.list_my_blocks()','list_my_blocks','new'),
  ('public_function','public.list_verification_requests()','list_verification_requests','new'),
  ('public_function','public.mark_member_verification_doc_purged(bigint, uuid)','mark_member_verification_doc_purged','new'),
  ('public_function','public.mark_message_read(bigint)','mark_message_read','new'),
  ('public_function','public.mark_verification_doc_purged(bigint)','mark_verification_doc_purged','new'),
  ('public_function','public.moderate_content(bigint, text, text)','moderate_content','new'),
  ('public_function','public.prepare_account_deletion(uuid)','prepare_account_deletion','new'),
  ('public_function','public.record_maintenance_run(text, boolean, integer, text)','record_maintenance_run','new'),
  ('public_function','public.record_member_view(bigint)','record_member_view','new'),
  ('public_function','public.record_verification_purge_failure(bigint, text)','record_verification_purge_failure','new'),
  ('public_function','public.release_maintenance_lease(text, uuid)','release_maintenance_lease','new'),
  ('public_function','public.review_verification(bigint, boolean, text)','review_verification','new'),
  ('public_function','public.run_stale_review_notifications(integer)','run_stale_review_notifications','new'),
  ('public_function','public.set_initial_nickname(text)','set_initial_nickname','new'),
  ('public_function','public.soft_delete_comment(bigint)','soft_delete_comment','new'),
  ('public_function','public.soft_delete_post(bigint)','soft_delete_post','new'),
  ('public_function','public.submit_report(text, bigint, text, text)','submit_report','new'),
  ('public_function','public.unblock_author(uuid)','unblock_author','new'),
  ('public_function','public.withdraw_verification(bigint)','withdraw_verification','new'),
  -- private/authz 앱 함수 39종 — A-R4: 이름이 아니라 identity signature로 검사
  ('app_function','authz.board_access_ok(smallint)','board_access_ok','new'),
  ('app_function','authz.is_active_member()','is_active_member','new'),
  ('app_function','authz.is_blocked_author(text, bigint)','is_blocked_author','new'),
  ('app_function','authz.is_writable_member()','is_writable_member','new'),
  ('app_function','authz.post_visible_to_me(bigint)','post_visible_to_me','new'),
  ('app_function','private.account_deletion_converged(uuid)','account_deletion_converged','new'),
  ('app_function','private.acquire_maintenance_lease(text, integer)','acquire_maintenance_lease','new'),
  ('app_function','private.actor_role_check(text)','actor_role_check','new'),
  ('app_function','private.begin_verification_impl(uuid, text[], smallint[], smallint, text, text, text)','begin_verification_impl','new'),
  ('app_function','private.claim_accounts_for_deletion(integer)','claim_accounts_for_deletion','new'),
  ('app_function','private.claim_expired_uploads(integer)','claim_expired_uploads','new'),
  ('app_function','private.claim_guest_read_impl(text, text, bigint, integer)','claim_guest_read_impl','new'),
  ('app_function','private.claim_verification_docs_to_purge(integer)','claim_verification_docs_to_purge','new'),
  ('app_function','private.content_author(text, bigint)','content_author','new'),
  ('app_function','private.detach_member_content(uuid)','detach_member_content','new'),
  ('app_function','private.expire_sanctions(integer)','expire_sanctions','new'),
  ('app_function','private.expire_unreviewed_submissions(integer)','expire_unreviewed_submissions','new'),
  ('app_function','private.finalize_verification_impl(uuid, bigint)','finalize_verification_impl','new'),
  ('app_function','private.get_member_verification_paths(uuid)','get_member_verification_paths','new'),
  ('app_function','private.handle_new_auth_user()','handle_new_auth_user','new'),
  ('app_function','private.mark_member_verification_doc_purged(bigint, uuid)','mark_member_verification_doc_purged','new'),
  ('app_function','private.mark_verification_doc_purged(bigint)','mark_verification_doc_purged','new'),
  ('app_function','private.on_comment_after_insert()','on_comment_after_insert','new'),
  ('app_function','private.on_comment_insert()','on_comment_insert','new'),
  ('app_function','private.on_comment_update()','on_comment_update','new'),
  ('app_function','private.on_post_after_insert()','on_post_after_insert','new'),
  ('app_function','private.on_post_insert()','on_post_insert','new'),
  ('app_function','private.on_post_update()','on_post_update','new'),
  ('app_function','private.on_vote_change()','on_vote_change','new'),
  ('app_function','private.prepare_account_deletion(uuid)','prepare_account_deletion','new'),
  ('app_function','private.purge_expired_guest_reads()','purge_expired_guest_reads','new'),
  ('app_function','private.purge_expired_holds()','purge_expired_holds','new'),
  ('app_function','private.purge_soft_deleted_content(integer)','purge_soft_deleted_content','new'),
  ('app_function','private.record_batch_run(text, boolean, integer, text)','record_batch_run','new'),
  ('app_function','private.record_verification_purge_failure(bigint, text)','record_verification_purge_failure','new'),
  ('app_function','private.release_maintenance_lease(text, uuid)','release_maintenance_lease','new'),
  ('app_function','private.run_stale_review_notifications(integer)','run_stale_review_notifications','new'),
  ('app_function','private.target_within_limit(text, text)','target_within_limit','new'),
  ('app_function','private.validate_nickname(text)','validate_nickname','new'),
  -- dev 테스트 스캐폴딩 함수 3종 (정확 시그니처 — 운영에선 0개가 정상)
  ('app_function','private._assert(text, text, text, boolean, text)','_assert','scaffold'),
  ('app_function','private._assert_ok(text, text, text)','_assert_ok','scaffold'),
  ('app_function','private._assert_raises(text, text, text)','_assert_raises','scaffold');

-- ── [2] 사전검사 전부 — 어떤 DROP보다 먼저 (A-R2). 하나라도 실패 = 전체 롤백 ──
do $$
declare
  bad text;
begin
  -- 2-1) public overload: allowlist 이름과 같은 이름인데 시그니처가 목록에 없으면 중단
  select string_agg(p.oid::regprocedure::text, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (select name from _reset_allowlist where kind = 'public_function')
    and p.oid::regprocedure::text not in (
      select to_regprocedure(signature)::text from _reset_allowlist
      where kind = 'public_function' and to_regprocedure(signature) is not null);
  if bad is not null then
    raise exception 'pre-check failed: public allowlist 밖 overload — %', bad;
  end if;

  if exists (select 1 from pg_namespace where nspname in ('private','authz')) then
    -- 2-2) 앱 스키마 내부 릴레이션: 테이블은 allowlist 정확명만, 뷰·매뷰·외부테이블 금지
    select string_agg(n.nspname || '.' || c.relname || '(' || c.relkind || ')', ', ') into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('private','authz')
      and c.relkind not in ('S','i','t')
      and not (n.nspname = 'private' and c.relkind = 'r' and c.relname in
               (select name from _reset_allowlist where kind in ('private_table','test_table')));
    if bad is not null then
      raise exception 'pre-check failed: 예상 밖 릴레이션 — %', bad;
    end if;

    -- 2-2b) 시퀀스: 승인 테이블(identity 컬럼)에 소유된 것만 허용 — 독립 시퀀스 금지 (A-R4)
    select string_agg(n.nspname || '.' || s.relname, ', ') into bad
    from pg_class s join pg_namespace n on n.oid = s.relnamespace
    where n.nspname in ('private','authz') and s.relkind = 'S'
      and not exists (
        select 1 from pg_depend d
        join pg_class t on t.oid = d.refobjid and d.refclassid = 'pg_class'::regclass
        where d.objid = s.oid and d.classid = 'pg_class'::regclass
          and d.deptype in ('i','a')
          and t.relname in (select name from _reset_allowlist where kind in ('private_table','test_table')));
    if bad is not null then
      raise exception 'pre-check failed: 독립(비소유) 시퀀스 — %', bad;
    end if;

    -- 2-3) 앱 스키마 내부 함수: identity signature 정확 일치만 (A-R4)
    select string_agg(p.oid::regprocedure::text, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('private','authz')
      and p.oid::regprocedure::text not in (
        select to_regprocedure(signature)::text from _reset_allowlist
        where kind = 'app_function' and to_regprocedure(signature) is not null);
    if bad is not null then
      raise exception 'pre-check failed: 앱 스키마에 allowlist 밖 함수/overload — %', bad;
    end if;

    -- 2-4) extension이 앱 스키마에 설치되어 있으면 중단
    select string_agg(e.extname, ', ') into bad
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
    where n.nspname in ('private','authz');
    if bad is not null then
      raise exception 'pre-check failed: 앱 스키마에 extension — %', bad;
    end if;

    -- 2-5) pg_depend 전수: 앱 스키마 객체(클래스·함수·타입)에 의존하는 "외부" 객체를
    --      전부 열거하고, 정확한 예외 allowlist 외에는 전건 RAISE (A-R1)
    --      허용: ①앱 스키마 내부 객체 상호 의존 ②승인 public 앱 테이블의 제약·정책·트리거·기본값
    --            ③auth.users 위 on_auth_user_created 트리거(정확명) ④allowlist public 함수
    with app_ns as (
      select oid from pg_namespace where nspname in ('private','authz')
    ), app_objs as (
      select 'pg_class'::regclass as clsid, c.oid as objid from pg_class c where c.relnamespace in (select oid from app_ns)
      union all
      select 'pg_proc'::regclass, p.oid from pg_proc p where p.pronamespace in (select oid from app_ns)
      union all
      select 'pg_type'::regclass, t.oid from pg_type t where t.typnamespace in (select oid from app_ns)
    ), deps as (
      select distinct d.classid, d.objid
      from pg_depend d
      join app_objs a on a.clsid = d.refclassid and a.objid = d.refobjid
      where d.deptype in ('n','a')
    ), classified as (
      select d.classid, d.objid,
        case
          -- ① 의존 주체가 앱 스키마 내부면 허용
          when d.classid = 'pg_class'::regclass and exists (
            select 1 from pg_class c where c.oid = d.objid and c.relnamespace in (select oid from app_ns)) then null
          when d.classid = 'pg_proc'::regclass and exists (
            select 1 from pg_proc p where p.oid = d.objid and p.pronamespace in (select oid from app_ns)) then null
          when d.classid = 'pg_type'::regclass and exists (
            select 1 from pg_type t where t.oid = d.objid and t.typnamespace in (select oid from app_ns)) then null
          when d.classid = 'pg_attrdef'::regclass and exists (
            select 1 from pg_attrdef ad join pg_class c on c.oid = ad.adrelid
            where ad.oid = d.objid and (c.relnamespace in (select oid from app_ns)
              or (c.relnamespace = 'public'::regnamespace and c.relname in
                  (select name from _reset_allowlist where kind = 'public_table')))) then null
          -- ② 승인 public 앱 테이블의 제약·정책·트리거
          when d.classid = 'pg_constraint'::regclass and exists (
            select 1 from pg_constraint k left join pg_class c on c.oid = k.conrelid
            where k.oid = d.objid and (c.relnamespace in (select oid from app_ns)
              or (c.relnamespace = 'public'::regnamespace and c.relname in
                  (select name from _reset_allowlist where kind = 'public_table')))) then null
          when d.classid = 'pg_policy'::regclass and exists (
            select 1 from pg_policy pol join pg_class c on c.oid = pol.polrelid
            where pol.oid = d.objid and (c.relnamespace in (select oid from app_ns)
              or (c.relnamespace = 'public'::regnamespace and c.relname in
                  (select name from _reset_allowlist where kind = 'public_table')))) then null
          -- ③ auth.users 위 정확명 트리거 + 앱/승인 테이블 위 트리거
          when d.classid = 'pg_trigger'::regclass and exists (
            select 1 from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
            where tg.oid = d.objid and (
              (c.oid = 'auth.users'::regclass and tg.tgname = 'on_auth_user_created')
              or c.relnamespace in (select oid from app_ns)
              or (c.relnamespace = 'public'::regnamespace and c.relname in
                  (select name from _reset_allowlist where kind = 'public_table')))) then null
          -- ④ 내부 rewrite(앱 스키마 뷰는 2-2에서 이미 차단되므로 사실상 없음)
          when d.classid = 'pg_rewrite'::regclass and exists (
            select 1 from pg_rewrite rw join pg_class c on c.oid = rw.ev_class
            where rw.oid = d.objid and c.relnamespace in (select oid from app_ns)) then null
          else d.classid::regclass::text || ':' || d.objid::text
        end as violation
      from deps d
    )
    select string_agg(violation, ', ') into bad from classified where violation is not null;
    if bad is not null then
      raise exception 'pre-check failed: 앱 스키마에 대한 예상 밖 외부 의존 — %', bad;
    end if;
  end if;
end $$;

-- ── [3] snueapp cron job 제거 (cron 스키마 없으면 skip, jobid로 전건) ──
do $$
declare r record;
begin
  if to_regclass('cron.job') is null then
    raise notice 'cron.job 없음 — skip';
    return;
  end if;
  for r in select jobid from cron.job
           where jobname in (select name from _reset_allowlist where kind = 'cron_job')
  loop
    perform cron.unschedule(r.jobid);
  end loop;
end $$;

-- ── [4] 앱 전용 스키마 제거 (사전검사 [2] 전부 통과한 뒤에만 도달) ──
drop schema if exists private cascade;
drop schema if exists authz cascade;

-- ── [5] public 앱 테이블 (자식→부모 drop_ord 순, CASCADE 없음 = fail-closed) ──
do $$
declare r record;
begin
  for r in select name from _reset_allowlist where kind = 'public_table' order by drop_ord
  loop
    if to_regclass('public.' || r.name) is not null then
      execute format('drop table public.%I', r.name);
    end if;
  end loop;
end $$;

-- ── [6] public 앱 함수 — allowlist 시그니처만 (overload는 [2-1]에서 이미 증명됨) ──
do $$
declare r record; fn regprocedure;
begin
  for r in select signature from _reset_allowlist where kind = 'public_function'
  loop
    fn := to_regprocedure(r.signature);
    if fn is not null then
      execute format('drop function %s', fn);
    end if;
  end loop;
end $$;

-- ── [7] 사후검증 (같은 allowlist 테이블 기준 — A-R3) ──
do $$
declare
  leftover int; base record; now_auth bigint; now_storage bigint; now_rls int;
begin
  select count(*) into leftover
  from pg_tables
  where schemaname = 'public'
    and tablename in (select name from _reset_allowlist where kind = 'public_table');
  if leftover <> 0 then raise exception 'reset failed: % allowlist tables remain', leftover; end if;

  select count(*) into leftover
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (select name from _reset_allowlist where kind = 'public_function');
  if leftover <> 0 then raise exception 'reset failed: % app functions remain', leftover; end if;

  select count(*) into leftover from pg_namespace where nspname in ('private','authz');
  if leftover <> 0 then raise exception 'reset failed: app schemas remain'; end if;

  if to_regclass('cron.job') is not null then
    select count(*) into leftover from cron.job
    where jobname in (select name from _reset_allowlist where kind = 'cron_job');
    if leftover <> 0 then raise exception 'reset failed: cron jobs remain'; end if;
  end if;

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
