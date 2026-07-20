-- ============================================================
-- prod-reset-community.sql  (P0-5 — GPT 런북 Phase 3 전용, 일회성)
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
-- 보존 (이 스크립트는 절대 접촉하지 않음):
--   auth.* / storage.*(객체 포함) / extensions·realtime 등 Supabase 관리 스키마
--   프로젝트 API 키·Auth 설정 / allowlist 밖 public 객체 / pg_cron 확장 자체
-- 삭제 (정확한 이름 일치만):
--   구 스키마(profiles·posts 등 5테이블 + 트리거·정책·인덱스는 테이블과 함께)
--   신 스키마 잔여물(부분 적용 실패 후 재실행 대비: 8테이블·함수 allowlist)
--   public 앱 함수 allowlist / private·authz 스키마 / snueapp cron job 4종
--   ※ Auth 사용자·Storage 파일은 이 SQL로 삭제하지 않는다 (런북 Phase 5에서 별도)
--
-- 실패 시 대응: 어떤 단계든 예외 발생 → 전체 자동 롤백(단일 트랜잭션).
--   즉석 수정·추가 drop 금지. 로그 저장 후 중단, dev 재현 후 동일 스크립트 재시도.
-- 검증: 말미 사후검증 DO 블록이 잔존 0·auth/storage 불변까지 확인 후 COMMIT 도달.
-- ============================================================

begin;

-- ── [0] 사전 캡처: auth·storage 불변 검증용 기준값 (본 트랜잭션 내 비교) ──
create temporary table _reset_baseline on commit drop as
select
  (select count(*) from auth.users)      as auth_users,
  (select count(*) from storage.objects) as storage_objects;

-- ── [1] snueapp cron job 정확명 4종만 unschedule (있을 때만) ──
do $$
declare
  j text;
begin
  foreach j in array array[
    'expire_sanctions',
    'purge_soft_deleted_content',
    'purge_expired_holds',
    'purge_expired_guest_reads'
  ] loop
    if exists (select 1 from cron.job where jobname = j) then
      perform cron.unschedule(j);
    end if;
  end loop;
end $$;

-- ── [2] public 앱 테이블 allowlist 드롭 (자식→부모 순, CASCADE 없음 = 예상 밖
--        의존물이 있으면 실패→전체 롤백되는 fail-closed) ──
--    트리거·정책·인덱스·시퀀스는 테이블과 함께 제거된다.
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

-- ── [3] public 앱 함수 allowlist 드롭 (이름 정확 일치, 시그니처는 카탈로그에서) ──
--    테이블 드롭 후에 실행 (트리거→함수 의존 해소 순서).
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(array[
        -- 구 스키마 함수 7종
        'enforce_snue_email', 'handle_comment_update', 'handle_new_comment',
        'handle_new_post', 'handle_post_update', 'record_comment_owner',
        'record_post_owner',
        -- 신 스키마 public 함수 (003·004·007·009) + rls_auto_enable
        'account_deletion_converged', 'acquire_maintenance_lease', 'apply_sanction',
        'block_author', 'change_nickname', 'claim_accounts_for_deletion',
        'claim_expired_uploads', 'claim_verification_docs_to_purge', 'close_case',
        'detach_member_content', 'expire_unreviewed_submissions', 'finalize_verification',
        'get_case', 'get_member_verification_paths', 'get_my_member',
        'get_my_verification_requests', 'grant_role', 'list_my_blocks',
        'list_verification_requests', 'mark_member_verification_doc_purged',
        'mark_message_read', 'mark_verification_doc_purged', 'moderate_content',
        'prepare_account_deletion', 'record_member_view',
        'record_verification_purge_failure', 'release_maintenance_lease',
        'review_verification', 'run_stale_review_notifications', 'set_initial_nickname',
        'soft_delete_comment', 'soft_delete_post', 'unblock_author',
        'withdraw_verification', 'rls_auto_enable'
      ])
  loop
    execute format('drop function %s', r.sig);
  end loop;
end $$;

-- ── [4] 앱 전용 스키마 드롭 (부분 적용 잔여 대비 — 운영 최초 실행 시엔 없음) ──
drop schema if exists private cascade;
drop schema if exists authz cascade;

-- ── [5] 사후검증: 하나라도 실패하면 예외 → 전체 롤백 ──
do $$
declare
  leftover int;
  base record;
  now_auth bigint;
  now_storage bigint;
begin
  -- 5-1) allowlist 테이블 잔존 0
  select count(*) into leftover
  from pg_tables
  where schemaname = 'public'
    and tablename in ('bookmarks','post_votes','comment_owners','comments',
                      'post_owners','posts','operational_messages','boards','profiles');
  if leftover <> 0 then
    raise exception 'reset failed: % allowlist tables remain', leftover;
  end if;

  -- 5-2) allowlist 함수 잔존 0
  select count(*) into leftover
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('enforce_snue_email','handle_comment_update','handle_new_comment',
                      'handle_new_post','handle_post_update','record_comment_owner',
                      'record_post_owner','get_my_member','grant_role','moderate_content',
                      'acquire_maintenance_lease','rls_auto_enable');
  if leftover <> 0 then
    raise exception 'reset failed: % allowlist functions remain', leftover;
  end if;

  -- 5-3) private·authz 스키마 잔존 0
  select count(*) into leftover
  from pg_namespace where nspname in ('private','authz');
  if leftover <> 0 then
    raise exception 'reset failed: app schemas remain';
  end if;

  -- 5-4) snueapp cron job 잔존 0
  select count(*) into leftover
  from cron.job
  where jobname in ('expire_sanctions','purge_soft_deleted_content',
                    'purge_expired_holds','purge_expired_guest_reads');
  if leftover <> 0 then
    raise exception 'reset failed: cron jobs remain';
  end if;

  -- 5-5) auth.users / storage.objects 불변 (사전 캡처와 정확 일치)
  select * into base from _reset_baseline;
  select count(*) into now_auth from auth.users;
  select count(*) into now_storage from storage.objects;
  if now_auth <> base.auth_users then
    raise exception 'reset failed: auth.users count changed (% -> %)', base.auth_users, now_auth;
  end if;
  if now_storage <> base.storage_objects then
    raise exception 'reset failed: storage.objects count changed (% -> %)', base.storage_objects, now_storage;
  end if;
end $$;

commit;

-- COMMIT 후 별도 확인(성공 배너를 믿지 말 것):
--   select table_schema, table_name from information_schema.tables
--    where table_schema in ('public','private','authz') order by 1,2;
--   select jobname from cron.job order by 1;
--   select count(*) from auth.users;          -- reset 전과 동일해야 함
--   select count(*) from storage.objects;     -- reset 전과 동일해야 함
