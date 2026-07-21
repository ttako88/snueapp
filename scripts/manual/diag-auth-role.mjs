// ============================================================
// diag-auth-role.mjs — GoTrue 로그인 실패 원인 진단 (ROLLBACK 종료)
// ============================================================
// password grant 가 "Database error querying schema" 로 500 을 냈다.
// GoTrue 는 supabase_auth_admin 역할로 접속하므로 그 역할을 흉내내
// 어느 조회·쓰기에서 막히는지 특정한다.
//
// 이게 내가 넣은 테스트 행 문제인지, 아니면 실제 로그인 자체가 깨진
// 것인지 구분해야 한다. 후자면 운영 차단 사유다.
//
// 전 구간 단일 트랜잭션이며 ROLLBACK 으로 끝난다.
// ============================================================
import pg from "pg";
import { readProdEnv, assertProdUrl, scrub } from "./prod-url.mjs";

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

let spn = 0;
async function step(label, sql) {
  const sp = `d${++spn}`;
  await c.query(`savepoint ${sp}`);
  try {
    const r = await c.query(sql);
    await c.query(`release savepoint ${sp}`);
    const first = r.rows?.[0] ? ` → ${JSON.stringify(r.rows[0]).slice(0, 90)}` : "";
    console.log(`  OK    ${label}${first}`);
    return true;
  } catch (e) {
    await c.query(`rollback to savepoint ${sp}`);
    await c.query(`release savepoint ${sp}`);
    console.log(`  FAIL  ${label}\n          ${e.code} ${(e.message || "").slice(0, 160)}`);
    return false;
  }
}

async function main() {
  await c.connect();
  await c.query("begin");
  try {
    console.log("=== supabase_auth_admin 역할로 GoTrue 동작 재현 ===");
    await c.query("set local role supabase_auth_admin");
    await step("auth.users 조회", "select count(*) from auth.users");
    await step("auth.identities 조회", "select count(*) from auth.identities");
    await step("auth.sessions 조회", "select count(*) from auth.sessions");
    await step("auth.refresh_tokens 조회", "select count(*) from auth.refresh_tokens");
    await step("auth.users UPDATE (트리거 발화)",
      "update auth.users set updated_at = now() where email like 'zz-smoke-%'");
    await step("auth.sessions INSERT",
      `insert into auth.sessions (id, user_id, created_at, updated_at)
         select gen_random_uuid(), id, now(), now() from auth.users where email like 'zz-smoke-%'`);
    await c.query("reset role");

    console.log("\n=== 트리거 함수 접근성 ===");
    await c.query("set local role supabase_auth_admin");
    await step("private 스키마 USAGE",
      "select has_schema_privilege('supabase_auth_admin','private','USAGE') u");
    await step("handle_new_auth_user EXECUTE",
      `select has_function_privilege('supabase_auth_admin',
         'private.handle_new_auth_user()'::regprocedure, 'EXECUTE') x`);
    await step("private.members INSERT 권한",
      "select has_table_privilege('supabase_auth_admin','private.members','INSERT') i");
    await c.query("reset role");
  } finally {
    await c.query("rollback");
    console.log("\n  종료: ROLLBACK — 영구 변경 0");
  }
}

try { await main(); }
catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
