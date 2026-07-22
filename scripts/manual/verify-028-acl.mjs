// ============================================================
// verify-028-acl.mjs — 028 적용 후 함수 EXECUTE 권한 기계적 측정 (ROLLBACK)
// ============================================================
// GPT R3A BLOCKER_1 증거용. 028 을 운영 스키마에 트랜잭션으로 적용하고
// has_function_privilege 로 각 함수의 anon/authenticated EXECUTE 를 측정한 뒤
// ROLLBACK 한다(영구 변경 0). ACL 문자열을 수동 파싱하지 않는다(규율).
//
// 기대:
//   private 헬퍼(actor_has_permission·require_permission·entitlement_effective)
//     → anon=F, authenticated=F  (PUBLIC EXECUTE 회수 확인)
//   svc_*(preview·reserve·consume·refund) → anon=F, authenticated=F, service_role=T
//   관리 RPC → anon=F, authenticated=T
//
// 실행: node scripts/manual/verify-028-acl.mjs
import pg from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readProdEnv, assertProdUrl } from "./prod-url.mjs";

const FILE = join(process.cwd(), "supabase/migrations/pending/028_feature_entitlements.sql");
const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");

function stripWrapper(sql) {
  let s = sql;
  const b = /^\s*begin\s*;/im.exec(s);
  if (b && s.slice(0, b.index).replace(/--[^\n]*|\s/g, "") === "")
    s = s.slice(0, b.index) + " ".repeat(b[0].length) + s.slice(b.index + b[0].length);
  const m = [...s.matchAll(/^\s*commit\s*;/gim)].pop();
  if (m) s = s.slice(0, m.index) + " ".repeat(m[0].length) + s.slice(m.index + m[0].length);
  return s;
}

// 함수 → 기대 EXECUTE (anon, authenticated, service_role)
const PRIVATE = [
  "private.actor_has_permission(uuid,text)",
  "private.require_permission(text)",
  "private.entitlement_effective(private.entitlement_grants)",
];
const SVC = [
  "public.svc_lesson_plan_access_preview(uuid)",
  "public.svc_reserve_lesson_plan_entitlement(uuid,text)",
  "public.svc_consume_entitlement(text)",
  "public.svc_refund_entitlement(text)",
];
const ADMIN = [
  "public.grant_entitlement(uuid,text,text,integer,timestamptz,text)",
  "public.revoke_entitlement(bigint,text)",
  "public.admin_list_members(text,text,text,timestamptz,uuid,integer)",
  "public.admin_member_detail(uuid)",
  "public.admin_list_entitlements(text)",
  "public.my_admin_permissions()",
];

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function priv(fn, role) {
  const { rows } = await c.query(
    "select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as ok", [role, fn]);
  return rows[0].ok;
}

let fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label.padEnd(64)} ${got} (기대 ${want})`);
};

try {
  await c.connect();
  await c.query("begin");
  await c.query(stripWrapper(readFileSync(FILE, "utf8")));

  console.log("\n=== private 헬퍼: anon/authenticated EXECUTE = false 여야 함 ===");
  for (const fn of PRIVATE) {
    check(`${fn} anon`, await priv(fn, "anon"), false);
    check(`${fn} authenticated`, await priv(fn, "authenticated"), false);
  }

  console.log("\n=== svc_*: anon/authenticated=false, service_role=true ===");
  for (const fn of SVC) {
    check(`${fn} anon`, await priv(fn, "anon"), false);
    check(`${fn} authenticated`, await priv(fn, "authenticated"), false);
    check(`${fn} service_role`, await priv(fn, "service_role"), true);
  }

  console.log("\n=== 관리 RPC: anon=false, authenticated=true ===");
  for (const fn of ADMIN) {
    check(`${fn} anon`, await priv(fn, "anon"), false);
    check(`${fn} authenticated`, await priv(fn, "authenticated"), true);
  }

  await c.query("rollback");
  console.log(`\n=== 판정 === (ROLLBACK — 운영 잔여물 0)`);
  console.log(fail === 0 ? "ACL_028=PASS" : `ACL_028=FAIL (${fail}건)`);
  process.exit(fail === 0 ? 0 : 1);
} catch (e) {
  try { await c.query("rollback"); } catch {}
  console.error("ERROR:", e.message);
  process.exit(2);
} finally {
  await c.end();
}
