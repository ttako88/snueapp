-- ============================================================
-- 005_schedules.sql
-- PROMOTED for dev rehearsal (P2 승인 2026-07-20) — 운영 적용은 dev 전 항목 통과+B-10 승인 후
-- 근거: GATE3_DESIGN.md v1.3 §9 — pg_cron은 DB 내부 작업만.
-- Storage/Auth API가 필요한 작업(인증원본 파기·계정 삭제·업로드 미완 정리·장기 미처리)은
-- 전부 서버 Cron (scripts/server-jobs/ 초안 참조) — 여기 없음.
-- ============================================================

begin;

create extension if not exists pg_cron;

-- 주: cron.schedule의 소유/실행 역할은 dev에서 실측 확인 (DRAFT_MANIFEST §2)
-- 각 배치 함수는 003b에서 정의 — idempotent·배치 상한·실패 로그 공통 규칙(§9)
-- r2 (GPT 2차 §7): 재적용 시 중복 job 방지 — 동일 이름 기존 job을 먼저 제거
do $$
declare r record;
begin
  for r in select jobid from cron.job
           where jobname in ('expire_sanctions','purge_soft_deleted_content',
                             'purge_expired_holds','purge_expired_guest_reads')
  loop
    perform cron.unschedule(r.jobid);   -- 존재하는 job만 — 부재 시 실패 없음 (r3)
  end loop;
end $$;
-- r2: 아래 시각은 "DB cron timezone=UTC" 가정의 KST 환산값 — dev에서 실제 timezone 확인 후 고정 (TODO)

-- 1. sanction 만료 (시간당) — sanction·until 재확인 → none 복귀 → history → 운영 메시지 (한 트랜잭션, 500행)
select cron.schedule('expire_sanctions', '5 * * * *',
  $$select private.expire_sanctions(500)$$);

-- 2. soft delete 30일 정리 (일 1회) — 열린 사건 대상 제외 (500행)
select cron.schedule('purge_soft_deleted_content', '10 18 * * *',   -- 03:10 KST
  $$select private.purge_soft_deleted_content(500)$$);

-- 3. hold 만료 = 식별값 파기 (일 1회) — retention_until 경과 행 hard delete (v1.3)
select cron.schedule('purge_expired_holds', '20 18 * * *',          -- 03:20 KST
  $$select private.purge_expired_holds()$$);

-- 4. guest_reads·guest_ip_daily TTL (일 1회)
select cron.schedule('purge_expired_guest_reads', '30 18 * * *',    -- 03:30 KST
  $$select private.purge_expired_guest_reads()$$);

-- 실행 기록: 각 함수가 마지막 성공 시각·처리 행수를 남긴다 (전용 테이블 batch_runs는
-- TODO: 003 후속분에서 private.batch_runs 정의 — 3연속 실패 시 owner 운영 메시지 규칙 포함)

commit;
