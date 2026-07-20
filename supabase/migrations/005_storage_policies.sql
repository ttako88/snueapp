-- ============================================================
-- 005_storage_policies.sql  (신설 — GPT 3차 검수 확정: Storage 접근 경계 분리)
-- PROMOTED for dev rehearsal (P2 승인 2026-07-20) — 운영 적용은 dev 전 항목 통과+B-10 승인 후
-- 적용 순서: 001~004 → provision-storage(버킷 생성) → 005 (버킷 존재가 전제)
-- 원칙: 이 파일은 storage 객체를 SQL로 삽입·수정·삭제하지 않는다 — 정책만 관리 (§7)
-- ============================================================

begin;

-- 기본값 (GPT 3차 확정): anon/authenticated의 직접 list/read/upload/delete 정책을 열지 않는다.
--   업로드 = 서버가 service_role로 발급한 서버 지정 경로({uid}/{request_id}/{random})의
--   signed upload URL로만. 열람 = 심사 시 서버 발급 60초 signed URL로만. (§4.3)
--   → storage.objects에 대한 anon/authenticated 정책 0개가 기본값.
--   signed upload가 dev에서 정상 작동하는지 확인한 뒤, 필요한 최소 정책만 추가한다 (dev 확인 항목).

-- r4 (GPT 3차 확정): "정책 0개"가 확정 기본안 — uploadToSignedUrl은 objects RLS 권한 불요.
--   dev에서 signed upload가 실패해도 authenticated INSERT 정책을 자동 대안으로 추가하지 않는다.
--   실패 시 SDK 사용법·signed token·경로·버킷 설정을 먼저 조사하고,
--   직접 업로드 정책 추가는 별도 설계 변경(재검수 대상)으로 취급.

-- 1) storage.objects RLS 활성 상태 확인 — 비활성이면 임의 변경하지 말고 실패 (r4)
do $$
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'storage' and c.relname = 'objects' and c.relrowsecurity) then
    raise exception 'storage.objects RLS disabled — do not modify, investigate first';
  end if;
end $$;

-- 2) 기존 정책 정리: 명시적 allowlist에 적힌 이름만 (LIKE 패턴 포괄 삭제 금지 — r4)
do $$
declare r record;
begin
  for r in select policyname from pg_policies
           where schemaname = 'storage' and tablename = 'objects'
             and policyname in (
               -- 과거 snueapp 정책명을 여기 명시적으로 나열 (dev 조사 후 확정. 현재 알려진 것 없음)
               'snueapp_legacy_placeholder_do_not_match'
             )
  loop
    execute format('drop policy %I on storage.objects', r.policyname);
  end loop;
end $$;

-- 3) anon/authenticated용 신규 정책은 생성하지 않는다 (정책 0개 유지 = 전면 거부.
--    service_role은 RLS 우회로 서버 작업 수행 — §4.3·§7 요구와 일치)

commit;
