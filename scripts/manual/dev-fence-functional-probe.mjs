// ============================================================
// dev-fence-functional-probe.mjs — fence 후 실제 동작 확인 (ROLLBACK 종료)
// ============================================================
// FINAL_FENCE_V2 는 지금까지 "권한 개수"로만 검증됐다. 기능 동작은 한 번도
// 확인하지 않았다. 그런데 RLS 정책이 authz.* 헬퍼 함수를 호출하고, RLS
// 표현식은 조회하는 role 권한으로 실행된다. fence 가 그 EXECUTE 를
// 회수했다면 RLS 걸린 모든 쿼리가 permission denied 로 깨진다.
//
// 추론으로 끝내지 않고 실제로 role 을 바꿔 쿼리해 본다.
// 모든 작업은 단일 트랜잭션 안이고 반드시 ROLLBACK 으로 끝난다.
// ============================================================
import pg from "pg";
import { readDevEnv, assertDevUrl, scrub } from "./dev-url.mjs";

const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(46)} ${v}`);

const { DEV_DB_URL: url } = readDevEnv(["DEV_DB_URL"]);
assertDevUrl(url, "DEV_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();

  head("1. authz 헬퍼의 현재 EXECUTE 상태 (fence 적용된 dev)");
  const helpers = (await c.query(
    `select p.oid::regprocedure::text sig,
            has_function_privilege('anon', p.oid, 'EXECUTE') anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') auth,
            coalesce(p.proacl::text,'NULL') acl
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='authz' order by 1`)).rows;
  for (const h of helpers) line(h.sig, `anon=${h.anon} auth=${h.auth}`);

  head("2. RLS 정책이 authz 함수를 호출하는가");
  const pol = (await c.query(
    `select schemaname||'.'||tablename tbl, policyname,
            coalesce(qual,'')||' '||coalesce(with_check,'') expr
       from pg_policies where schemaname in ('public','private') order by 1,2`)).rows;
  const usingAuthz = pol.filter((p) => /authz\./i.test(p.expr));
  line("정책 총수", pol.length);
  line("authz.* 를 호출하는 정책", usingAuthz.length);
  for (const p of usingAuthz.slice(0, 8))
    line(`  ${p.tbl}`, `${p.policyname} → ${(p.expr.match(/authz\.[a-z_]+/gi) || []).join(", ")}`);

  head("3. 실제 role 로 쿼리 — fence 후 동작하는가 (ROLLBACK)");
  await c.query("begin");
  const results = [];
  try {
    for (const role of ["anon", "authenticated"]) {
      for (const tbl of ["public.posts", "public.comments", "public.boards"]) {
        await c.query("savepoint p");
        let outcome, detail = "";
        try {
          await c.query(`set local role ${role}`);
          await c.query(`select count(*) from ${tbl}`);
          outcome = "OK";
          await c.query("release savepoint p");
        } catch (e) {
          outcome = e.code === "42501" ? "PERMISSION_DENIED" : `ERROR(${e.code})`;
          detail = (e.message || "").slice(0, 110);
          await c.query("rollback to savepoint p");
          await c.query("release savepoint p");
        }
        await c.query("reset role");
        results.push({ role, target: tbl, outcome, detail });
        console.log(`  ${outcome === "OK" ? "OK  " : "FAIL"}  ${role} → select ${tbl}` +
          (detail ? `\n         ${detail}` : ""));
      }
    }
  } finally {
    await c.query("rollback");
    line("종료", "ROLLBACK — 영구 변경 0");
  }

  head("판정");
  const broken = results.filter((r) => r.outcome !== "OK");
  console.log(`\nFENCE_FUNCTIONAL_PROBE=${broken.length ? "BROKEN" : "OK"}`);
  console.log(`FAILED=${broken.length}/${results.length}`);
  if (broken.length) {
    console.log("\n권한 개수만으로 fence 를 판정하면 안 된다는 실증이다.");
    console.log("RLS 표현식은 조회 role 권한으로 실행되므로 authz 헬퍼의");
    console.log("EXECUTE 를 회수하면 RLS 걸린 쿼리가 전부 막힌다.");
  }
  return broken.length ? 3 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
process.exit(code);
