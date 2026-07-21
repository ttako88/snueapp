// RPC 실행 권한을 ACL 파싱이 아니라 has_function_privilege 로 직접 묻는다.
// ACL 을 손으로 해석하다 이 프로젝트에서 이미 두 번 틀렸다 —
// NULL ACL(=기본, PUBLIC EXECUTE)과 명시 REVOKE 를 뒤섞었고,
// 여러 함수에 걸친 GRANT 를 정규식으로 세다 놓쳤다. DB 에 묻는 게 정확하다.
import pg from "pg";
import { readProdEnv, assertProdUrl, scrub } from "./prod-url.mjs";

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

const ROLES = ["anon", "authenticated", "service_role"];

try {
  await c.connect();
  await c.query("begin read only");

  const fns = (await c.query(`
    select p.oid::regprocedure::text sig, p.proname
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
     order by p.proname`)).rows;

  console.log(`public 함수 ${fns.length}개 · 역할별 EXECUTE\n`);
  console.log(`  ${"함수".padEnd(46)} anon  auth  svc`);
  console.log("  " + "-".repeat(66));

  const noCaller = [];
  for (const f of fns) {
    const marks = [];
    for (const role of ROLES) {
      const { rows } = await c.query(
        `select has_function_privilege($1::text, $2::text, 'EXECUTE') v`, [role, f.sig]);
      marks.push(rows[0].v);
    }
    // anon·authenticated 어느 쪽도 못 부르면 화면에서 쓸 수 없는 함수다.
    if (!marks[0] && !marks[1]) noCaller.push(f.proname);
    console.log(`  ${f.proname.slice(0, 45).padEnd(46)} ` +
      marks.map((m) => (m ? " ✔  " : " ·  ")).join(" "));
  }

  console.log(`\n브라우저에서 호출 불가(anon·authenticated 모두 ✗): ${noCaller.length}개`);
  for (const n of noCaller) console.log(`  · ${n}`);
  console.log("\n※ service_role 전용은 정상이다 — 서버 라우트·배치가 부른다.");

  await c.query("rollback");
} catch (e) {
  console.error("[fail] " + scrub(e.message || String(e), url));
} finally {
  try { await c.end(); } catch {}
}
