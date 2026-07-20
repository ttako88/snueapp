-- dev 테스트 집계 검증 (--print-rows로 실행). 합성 결과만 — 비민감.
select count(*) as total_all,
       count(*) filter (where pass) as pass_all,
       count(*) filter (where not pass) as fail_all,
       coalesce(string_agg(name,', ') filter (where not pass),'none') as failed
from private._test_results;
