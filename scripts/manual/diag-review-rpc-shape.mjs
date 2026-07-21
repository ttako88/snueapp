// 강의평가 RPC 표면 실측 (READ-ONLY) — 클라이언트를 붙이기 전에 계약을 확인한다.
import pg from "pg";
import { readProdEnv, assertProdUrl, scrub } from "./prod-url.mjs";
const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect(); await c.query("begin read only");
const rows = (await c.query(`
  select p.proname, pg_get_function_arguments(p.oid) args,
         pg_get_function_result(p.oid) ret,
         -- ⚠ proacl 이 NULL 이면 "아무도 못 부름" 이 아니라 **기본 ACL**,
         --   즉 함수는 PUBLIC EXECUTE 다. 이 구분을 빼먹으면 활짝 열린 함수를
         --   잠겨 있다고 보고하게 된다. 이 프로젝트에서 이미 한 번 낸 오류다.
         (p.proacl is null) acl_default,
         -- aclexplode 는 집합 반환 함수라 JOIN 조건에 못 쓴다(0A000). 스칼라
         -- 서브쿼리 안에서 먼저 펼친 뒤 조인한다.
         coalesce((select array_agg(distinct r.rolname)
                     from aclexplode(p.proacl) x
                     join pg_roles r on r.oid = x.grantee
                    where x.privilege_type = 'EXECUTE'), '{}') grantees
    from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='public'
     and (p.proname like '%review%' or p.proname like '%subject%'
          or p.proname like '%tip%' or p.proname like '%ticket%' or p.proname like '%unlock%')
   order by p.proname`)).rows;
for (const r of rows) {
  console.log(`\n${r.proname}(${r.args})`);
  console.log(`  → ${r.ret}`);
  // node-pg 가 빈 배열을 문자열 '{}' 로 줄 때가 있다 — 배열이라 가정하지 않는다.
  // 권한은 여기서 판정하지 않는다. ACL 을 손으로 읽다 이 프로젝트에서 세 번
  // 틀렸다 — 마지막은 node-pg 가 text[] 를 문자열로 준 걸 빈 배열로 처리해
  // "아무도 못 부름" 이라고 잘못 보고했다(실제로는 authenticated 가능).
  // 권한은 diag-rpc-privilege.mjs 가 has_function_privilege 로 직접 묻는다.
  console.log(`  권한: → diag-rpc-privilege.mjs 참조${
    r.acl_default ? "  ⚠ proacl NULL = 기본 ACL(PUBLIC EXECUTE)" : ""}`);
}
console.log(`\n총 ${rows.length}개`);
await c.query("rollback"); await c.end();
