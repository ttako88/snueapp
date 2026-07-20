-- ============================================================
-- 001_schemas_roles.sql
-- DRAFT — NOT EXECUTED — NOT APPROVED FOR DEV APPLY
-- 근거: GATE3_DESIGN.md v1.3 §1(스키마 분리·스키마 권한), §2 공통(default privileges)
-- ============================================================

begin;

-- 1. private 스키마 생성 (PostgREST 미노출 — Supabase 대시보드의
--    "Exposed schemas"에 private를 추가하지 않는 것이 전제. 노출 목록은
--    dev 리허설 단계에서 실측 확인 항목)
create schema if not exists private;

-- 2. 스키마 자체 권한 차단 (§1 v1.3)
--    테이블 권한 이전에 스키마 USAGE부터 차단한다.
revoke usage, create on schema private from public;
revoke usage, create on schema private from anon;
revoke usage, create on schema private from authenticated;

-- service_role은 definer 함수 경유가 원칙이나, 서버 배치·Admin 작업의
-- 함수 실행을 위해 USAGE만 부여 (CREATE는 미부여)
grant usage on schema private to service_role;

-- 2-1. public 스키마도 CREATE 차단 (GPT 검수 반영 — 공격자의 public 객체 생성 구조적 제거)
--      anon·authenticated에는 API 사용에 필요한 USAGE만 유지
revoke create on schema public from public;
revoke create on schema public from anon;
revoke create on schema public from authenticated;
grant usage on schema public to anon, authenticated;

-- TODO(Gate 4a dev 확인): 스케줄 작업을 실제 실행하는 스케줄러 소유 역할명 확인 후
--   grant usage on schema private to <스케줄러_역할>;
-- (Supabase pg_cron 잡은 보통 postgres 소유로 실행되므로 추가 grant가 불필요할 수 있음 — dev에서 실측)

-- 3. default privileges 제한 (§2 공통)
--    이후 생성되는 객체에 PUBLIC/anon/authenticated 자동 권한이 생기지 않게 한다.
alter default privileges in schema public  revoke execute on functions from public;
alter default privileges in schema private revoke execute on functions from public;
alter default privileges in schema public  revoke all on tables from anon, authenticated;
alter default privileges in schema private revoke all on tables from anon, authenticated;
alter default privileges in schema private revoke all on sequences from anon, authenticated;
alter default privileges in schema public  revoke all on sequences from anon, authenticated;

-- 주의: alter default privileges는 "실행한 역할이 소유자로 만드는 객체"에만 적용된다.
-- 마이그레이션 실행 역할(postgres)과 객체 소유 역할이 동일한지 dev에서 확인 (검사 쿼리는 tests에 포함)

commit;
