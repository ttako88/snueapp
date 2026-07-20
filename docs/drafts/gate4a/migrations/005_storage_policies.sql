-- ============================================================
-- 005_storage_policies.sql  (신설 — GPT 3차 검수 확정: Storage 접근 경계 분리)
-- DRAFT — NOT EXECUTED — NOT APPROVED FOR DEV APPLY
-- 적용 순서: 001~004 → provision-storage(버킷 생성) → 005 (버킷 존재가 전제)
-- 원칙: 이 파일은 storage 객체를 SQL로 삽입·수정·삭제하지 않는다 — 정책만 관리 (§7)
-- ============================================================

begin;

-- 기본값 (GPT 3차 확정): anon/authenticated의 직접 list/read/upload/delete 정책을 열지 않는다.
--   업로드 = 서버가 service_role로 발급한 서버 지정 경로({uid}/{request_id}/{random})의
--   signed upload URL로만. 열람 = 심사 시 서버 발급 60초 signed URL로만. (§4.3)
--   → storage.objects에 대한 anon/authenticated 정책 0개가 기본값.
--   signed upload가 dev에서 정상 작동하는지 확인한 뒤, 필요한 최소 정책만 추가한다 (dev 확인 항목).

-- 기존 정책 정리: 이름이 명확히 snueapp 것으로 식별되는 정책만 대상 (포괄 삭제 금지 — r3)
do $$
declare r record;
begin
  for r in select policyname from pg_policies
           where schemaname = 'storage' and tablename = 'objects'
             and policyname like 'snueapp_%'
  loop
    execute format('drop policy %I on storage.objects', r.policyname);
  end loop;
end $$;

-- verification-docs 버킷: 정책 0개 = anon/authenticated 전면 거부가 그대로 유지된다.
-- (storage.objects는 Supabase가 RLS enable 상태로 관리 — 정책이 없으면 거부.
--  service_role은 RLS 우회로 서버 작업 수행. 이 상태가 §4.3·§7의 요구와 일치)

-- TODO(dev 확인): signed upload URL 방식이 정책 0개 상태에서 동작하는지 실측.
--   Supabase 문서상 createSignedUploadUrl은 service_role 발급 시 RLS와 무관하게 동작해야 하나,
--   dev에서 실패하면 "authenticated가 본인 {uid}/ prefix에만 insert" 최소 정책을 여기 추가:
--   -- create policy snueapp_verification_upload on storage.objects for insert to authenticated
--   --   with check (bucket_id = 'verification-docs'
--   --               and (storage.foldername(name))[1] = auth.uid()::text);

commit;
