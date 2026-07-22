-- ============================================================
-- 029_analytics_volatility_fix.sql — 이용통계 대시보드 read-only 오류 수정
-- ============================================================
-- 증상: /admin/analytics 에서 "cannot execute INSERT in a read-only transaction".
--
-- 원인: analytics_overview()·analytics_daily() 가 STABLE 로 선언돼 있는데,
--   두 함수는 조회를 audit_analytics_view() 로 감사하며 private.audit_logs 에
--   INSERT 한다. PostgREST 는 STABLE/IMMUTABLE 함수를 **READ ONLY 트랜잭션**에서
--   실행하므로(HTTP 메서드와 무관한 안전장치), 그 안의 INSERT 가 거부된다.
--   analytics_event_segments 는 이미 VOLATILE 라 정상이었다(스냅샷 INSERT 있음).
--
-- 수정: 두 함수를 VOLATILE 로 바꿔 read-write 트랜잭션에서 돌게 한다.
--   본문·권한·반환은 그대로다. 함수 정의를 다시 만들지 않고 volatility 만 바꾼다.
-- ============================================================

begin;

alter function public.analytics_overview() volatile;
alter function public.analytics_daily(text, int) volatile;

commit;

-- 사후확인(수동):
--   select proname, provolatile from pg_proc
--    where proname in ('analytics_overview','analytics_daily'); -- provolatile='v'
