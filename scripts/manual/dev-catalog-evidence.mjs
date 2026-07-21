// ============================================================
// dev-catalog-evidence.mjs — dev READ-ONLY 카탈로그 증거 수집
// ============================================================
// 권한 근거
//   GPT NEXT_RECOMMENDED_ACTION = DEV_READ_ONLY_CATALOG_EVIDENCE_COMPLETION
//   상호님 승인 = "dev 읽기전용 조회만" (RC 수정·rehearsal 실행은 승인 범위 밖)
//
// GPT 가 명시한 금지 사항 — 이 스크립트는 전부 지킨다
//   application RPC 실행 없음 / DDL 없음 / DML 없음 / fixture 생성 없음
//   reset 없음 / migration 실행 없음 / fence 실행 없음 / production 접근 없음
//
// 쓰기가 "없다"고 주장만 하지 않는다. `begin read only` 로 트랜잭션 자체를
// 읽기전용으로 만들어 DB 가 강제하게 한다. 쓰기를 시도하면 25006 으로 죽는다.
// 그 강제가 실제로 걸려 있는지도 증명한다(음성 테스트).
//
// 실행: node scripts/manual/dev-catalog-evidence.mjs
// ============================================================
import pg from "pg";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readDevEnv, assertDevUrl, DEV_REF, scrub } from "./dev-url.mjs";

const OUT = join(homedir(), "prod-runs", "DEV_CATALOG_EVIDENCE");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(44)} ${v}`);
const fails = [];
const rec = (n, ok, d) => { if (!ok) fails.push(n); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

// GPT 가 요구한 exact query text. 결과와 함께 그대로 회신한다.
const QUERIES = {
  policies: `select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
  from pg_policies
 where schemaname = any($1::text[])
 order by schemaname, tablename, policyname`,

  admin_rpc_universe: `select n.nspname, p.oid::regprocedure::text signature, p.prosecdef,
       (select count(*) from regexp_matches(p.prosrc, 'actor_role_check', 'g')) role_check_hits,
       substring(p.prosrc from 'actor_role_check\\s*\\(\\s*''([a-z]+)''') min_role,
       p.provolatile, pg_get_userbyid(p.proowner) owner
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = any($1::text[])
   and p.prosrc like '%actor_role_check%'
 order by 1, 2`,

  schema_acl: `select nspname, coalesce(nspacl::text, 'NULL') nspacl,
       has_schema_privilege('anon', nspname, 'USAGE') anon_usage,
       has_schema_privilege('authenticated', nspname, 'USAGE') auth_usage
  from pg_namespace where nspname = any($1::text[]) order by 1`,

  rls_status: `select n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = any($1::text[]) and c.relkind in ('r','p')
 order by 1, 2`,
};

const { DEV_DB_URL: url } = readDevEnv(["DEV_DB_URL"]);
assertDevUrl(url, "DEV_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();
  mkdirSync(OUT, { recursive: true });

  head("0. 대상 확인");
  const who = (await c.query(
    `select current_database() db, current_user usr, version() ver`)).rows[0];
  line("database / user", `${who.db} / ${who.usr}`);
  line("target ref (assertDevUrl 통과)", DEV_REF);
  line("postgres", who.ver.split(" ").slice(0, 2).join(" "));

  head("1. READ ONLY 트랜잭션 개시 + 강제 확인");
  await c.query("begin read only");
  const ro = (await c.query(`show transaction_read_only`)).rows[0].transaction_read_only;
  rec("transaction_read_only = on", ro === "on", ro);

  // 주장하지 말고 증명한다 — 쓰기를 시도해 DB 가 막는지 본다.
  await c.query("savepoint probe_write");
  let blocked = false, code = null;
  try {
    await c.query(`create temp table zero_write_probe(x int)`);
  } catch (e) { blocked = true; code = e.code; }
  await c.query("rollback to savepoint probe_write");
  await c.query("release savepoint probe_write");
  rec("쓰기 시도가 DB 수준에서 차단됨", blocked && code === "25006",
    blocked ? `SQLSTATE ${code}` : "차단되지 않음 — 중대");
  if (!blocked) { await c.query("rollback"); console.error("⛔ read-only 강제 실패. 중단."); return 3; }

  const schemas = ["public", "private", "authz"];
  const results = {};

  head("2. pg_policies 전수 (GPT 요구 8개 열)");
  const pol = (await c.query(QUERIES.policies, [schemas])).rows;
  results.policies = pol;
  line("행 수", pol.length);
  rec("정책 17행", pol.length === 17, String(pol.length));
  for (const p of pol) {
    const helpers = [...new Set([...(p.qual || "").matchAll(/authz\.[a-z_]+/gi),
                                 ...(p.with_check || "").matchAll(/authz\.[a-z_]+/gi)].map((m) => m[0]))];
    console.log(`  ${p.tablename}.${p.policyname}`);
    console.log(`      cmd=${p.cmd}  permissive=${p.permissive}  roles=${JSON.stringify(p.roles)}`);
    console.log(`      helpers=${helpers.length ? helpers.join(", ") : "(없음)"}  ` +
      `qual=${p.qual ? "O" : "-"} with_check=${p.with_check ? "O" : "-"}`);
  }

  head("3. 관리 RPC universe (actor_role_check 호출 함수)");
  const adm = (await c.query(QUERIES.admin_rpc_universe, [schemas])).rows;
  results.admin_rpc_universe = adm;
  line("actor_role_check 를 부르는 함수", adm.length);
  for (const a of adm)
    console.log(`  ${a.signature}\n      min_role=${a.min_role ?? "?"}  secdef=${a.prosecdef}  hits=${a.role_check_hits}  owner=${a.owner}`);

  head("4. 스키마 ACL / USAGE");
  const sacl = (await c.query(QUERIES.schema_acl, [schemas])).rows;
  results.schema_acl = sacl;
  for (const s of sacl)
    line(s.nspname, `anon USAGE=${s.anon_usage}  authenticated USAGE=${s.auth_usage}`);

  head("5. RLS 활성 상태");
  const rls = (await c.query(QUERIES.rls_status, [schemas])).rows;
  results.rls_status = rls;
  const off = rls.filter((r) => !r.relrowsecurity);
  line("테이블 수 / RLS 비활성", `${rls.length} / ${off.length}`);
  for (const r of off) line("  RLS 꺼짐", `${r.nspname}.${r.relname}`);

  head("6. 트랜잭션 종료 + zero-write 증거");
  const xidBefore = (await c.query(`select pg_current_xact_id_if_assigned()::text x`)).rows[0].x;
  line("할당된 transaction id", xidBefore ?? "없음(쓰기 0의 직접 증거)");
  rec("쓰기 xid 미할당", xidBefore === null,
    xidBefore === null ? "read-only 이므로 xid 자체가 없다" : `xid ${xidBefore}`);
  await c.query("rollback");
  line("종료", "ROLLBACK");

  const out = {
    document: "DEV_READ_ONLY_CATALOG_EVIDENCE",
    authority: "GPT NEXT_RECOMMENDED_ACTION + 상호님 승인(읽기전용 조회만)",
    target: { database: who.db, user: who.usr, ref: DEV_REF, version: who.ver },
    method: "단일 세션 / begin read only / 쓰기 차단 음성테스트 / xid 미할당 확인 / rollback 종료",
    prohibited_actions_performed: {
      application_rpc_execution: false, ddl: false, dml: false,
      fixture_creation: false, reset: false, migration: false,
      fence: false, repo_change: false, production_access: false,
    },
    exact_query_text: QUERIES,
    row_counts: {
      policies: pol.length, admin_rpc_universe: adm.length,
      schema_acl: sacl.length, rls_status: rls.length,
    },
    raw_results: results,
  };
  const buf = Buffer.from(JSON.stringify(out, null, 2));
  writeFileSync(join(OUT, "DEV_CATALOG_EVIDENCE.json"), buf);

  head("판정");
  console.log(`\nDEV_CATALOG_EVIDENCE=${fails.length ? "FAIL" : "PASS"}`);
  console.log(`POLICIES=${pol.length} ADMIN_RPC=${adm.length} RLS_TABLES=${rls.length}`);
  console.log(`ZERO_WRITE_PROVEN=${xidBefore === null ? "YES" : "NO"}`);
  console.log(`SHA256=${createHash("sha256").update(buf).digest("hex")}`);
  console.log(`OUT=${join(OUT, "DEV_CATALOG_EVIDENCE.json")}`);
  if (fails.length) for (const f of fails) console.log(`  · ${f}`);
  return fails.length ? 3 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
process.exit(code);
