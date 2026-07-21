// ============================================================
// diag-auth-nulls.mjs — 내 수동 삽입 행이 GoTrue 스캔을 깨는지 확인
// ============================================================
// GoTrue 는 confirmation_token 같은 컬럼을 Go 의 non-nullable string 으로
// 읽는다. NULL 이면 "Database error querying schema" 로 죽는다.
// GoTrue 가 만든 기존 행은 '' 이고, 내가 SQL 로 넣은 행은 NULL 일 수 있다.
// 두 행을 나란히 비교해 원인이 내 행인지 운영 자체인지 가른다.
//
// READ-ONLY.
// ============================================================
import pg from "pg";
import { readProdEnv, assertProdUrl, scrub } from "./prod-url.mjs";

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();
  await c.query("begin read only");
  const q = async (s, p = []) => (await c.query(s, p)).rows;

  // text 계열 컬럼 중 NULL 인 것을 행별로 센다
  const cols = (await q(`select a.attname
      from pg_attribute a join pg_type t on t.oid = a.atttypid
     where a.attrelid='auth.users'::regclass and a.attnum>0 and not a.attisdropped
       and t.typname in ('text','varchar','bpchar')
     order by a.attnum`)).map((r) => r.attname);

  console.log("=== auth.users 의 text 계열 컬럼별 NULL 여부 ===");
  const sel = cols.map((n) => `(${JSON.stringify(n)} is null) as ${JSON.stringify("n_" + n)}`).join(", ");
  const rows = await q(`select email, ${sel} from auth.users order by created_at`);
  for (const r of rows) {
    const nulls = cols.filter((n) => r["n_" + n]);
    const kind = r.email.startsWith("zz-smoke-") ? "내가 만든 행" : "GoTrue 가 만든 행";
    console.log(`\n  [${kind}] ${r.email}`);
    console.log(`    NULL 컬럼 ${nulls.length}개: ${nulls.join(", ") || "없음"}`);
  }

  console.log("\n=== supabase_auth_admin 권한 (트리거 경로) ===");
  const p = (await q(`select
      has_schema_privilege('supabase_auth_admin','private','USAGE') sch,
      has_table_privilege('supabase_auth_admin','private.members','INSERT') ins,
      has_function_privilege('supabase_auth_admin',
        'private.handle_new_auth_user()'::regprocedure,'EXECUTE') exec`))[0];
  console.log(`  private USAGE=${p.sch}  members INSERT=${p.ins}  트리거함수 EXECUTE=${p.exec}`);
  console.log("  (트리거 함수는 SECURITY DEFINER 이고 EXECUTE 는 트리거 생성 시점에 검사된다)");

  await c.query("rollback");
}

try { await main(); }
catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
