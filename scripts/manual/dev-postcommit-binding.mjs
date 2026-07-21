// ============================================================
// dev-postcommit-binding.mjs — POST_COMMIT_COMPLETENESS_BINDING (READ-ONLY)
// ============================================================
// GPT P-20260721-PASS_B_FORMAL_GAP_AND_TX_A_HOLD_01 §5 대응.
// 08 요약에 개별 표기가 생략된 항목을 fresh read-only 측정으로 결속한다.
// 미측정된 과거 상태를 현재 상태로 소급 추정하지 않는다 —
// 과거값이 필요한 항목은 봉인 receipt 의 필드/해시를 인용한다.
// ============================================================
import pg from "pg";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readDevEnv, assertDevUrl, scrub } from "./dev-url.mjs";
import * as L from "./fence-v2-lib.mjs";

const RUN = join(homedir(), "prod-runs", "DEV_PASS_B");
const BASE = join(homedir(), "prod-runs", "DEV_PRE_TX_BASELINE", "PRE_TX_BASELINE_RECEIPT.json");
const OUT = join(RUN, "POST_COMMIT_COMPLETENESS_BINDING.json");
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(46)} ${v}`);
const bind = [];
const B = (item, value, source) => { bind.push({ item, value: String(value), source }); line(item, `${value}   [${source}]`); };

const { DEV_DB_URL: url } = readDevEnv(["DEV_DB_URL"]);
assertDevUrl(url, "DEV_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();
  const q = async (s, p = []) => (await c.query(s, p)).rows;
  const g = async (s, p = []) => (await q(s, p))[0];
  const baseline = JSON.parse(readFileSync(BASE, "utf8"));
  const passB = JSON.parse(readFileSync(join(RUN, "PASS_B_RECEIPTS.json"), "utf8"));
  const names = (await L.projectSchemas(c)).map((s) => s.schema);
  const inv = await L.inventory(c, names);
  L.resetProbeStats();
  const eff = await L.effectiveVector(c, inv);
  const expanded = await L.expandedAclVector(c, inv);
  const raw = await L.rawAclSnapshot(c, names);
  const ps = { ...L.probeStats };

  head("1. topology / definition / owner");
  const defs = [];
  for (const r of [...inv.relations, ...inv.sequences]) {
    const cols = await q(`select a.attname, format_type(a.atttypid,a.atttypmod) t, a.attnotnull nn
       from pg_attribute a where a.attrelid=$1 and a.attnum>0 and not a.attisdropped order by a.attnum`, [r.oid]);
    defs.push(`${r.ident}|${r.owner}|${sha256(cols.map((x) => `${x.attname}:${x.t}:${x.nn}`).join("\n"))}`);
  }
  for (const f of inv.routines) {
    const d = await g(`select pg_get_functiondef($1) d`, [f.oid]).catch(() => ({ d: "" }));
    defs.push(`${f.ident}|${f.owner}|${sha256(d.d || "")}`);
  }
  B("committed topology (rel/seq/fn/sch/col)",
    `${inv.relations.length}/${inv.sequences.length}/${inv.routines.length}/${inv.schemas.length}/${inv.columns.length}`, "FRESH");
  B("definition+owner hash", sha256(defs.sort().join("\n")).slice(0, 32) + "…", "FRESH");
  const owners = new Set([...inv.relations, ...inv.sequences, ...inv.routines, ...inv.schemas].map((o) => o.owner));
  B("owner 집합", [...owners].join(","), "FRESH");

  head("2. role / database");
  B("role membership hash",
    sha256((await q(`select pg_get_userbyid(roleid) g, pg_get_userbyid(member) m, admin_option
       from pg_auth_members order by 1,2`)).map((r) => `${r.m}->${r.g}|${r.admin_option}`).join("\n")).slice(0, 32) + "…", "FRESH");
  for (const role of ["anon", "authenticated", "service_role"]) {
    const r = await g(`select has_database_privilege($1, current_database(), 'CREATE') cr,
                              has_database_privilege($1, current_database(), 'CONNECT') cn`, [role]);
    B(`database ${role} CREATE/CONNECT`, `${r.cr}/${r.cn}`, "FRESH");
  }

  head("3. privilege fence 실측");
  const T = (pred) => Object.entries(eff).filter(([k, v]) => v === true && pred(k.split("|"), k));
  // 08 보고서의 "보존 SELECT 21" 은 전 role 합계였다. 혼동을 막기 위해
  // 전 role 합계와 anon+authenticated 만의 수치를 둘 다 명시한다.
  B("preserved SELECT (전 role)", T((_, k) => k.endsWith("|SELECT")).length, "FRESH");
  B("preserved SELECT (anon+authenticated)",
    T(([, r, , p]) => p === "SELECT" && ["anon", "authenticated"].includes(r)).length, "FRESH");
  B("service_role preserved privilege", T(([, r]) => r === "service_role").length, "FRESH");
  for (const p of ["REFERENCES", "TRIGGER", "MAINTAIN", "INSERT", "UPDATE", "DELETE", "TRUNCATE"])
    B(`anon+authenticated ${p}`, T(([, r, , pr]) => pr === p && ["anon", "authenticated"].includes(r)).length, "FRESH");
  B("sequence mutation privilege (anon+auth)",
    T(([k, r, , p]) => k === "seq" && ["anon", "authenticated"].includes(r) && p !== "SELECT").length, "FRESH");
  B("routine EXECUTE (anon+auth)",
    T(([k, r]) => k === "fn" && ["anon", "authenticated"].includes(r)).length, "FRESH");
  B("project schema CREATE (anon+auth)",
    T(([k, r, , p]) => k === "sch" && p === "CREATE" && ["anon", "authenticated"].includes(r)).length, "FRESH");
  B("project schema USAGE (anon+auth)",
    T(([k, r, , p]) => k === "sch" && p === "USAGE" && ["anon", "authenticated"].includes(r)).length, "FRESH");

  head("4. 불변 항목");
  const managed = sha256((await q(`select nspname, coalesce(nspacl::text,'NULL') a from pg_namespace
     where nspname in ('auth','storage','extensions','graphql','realtime','vault','cron') order by 1`))
    .map((r) => `${r.nspname}|${r.a}`).join("\n"));
  B("managed schema ACL fingerprint",
    `${managed === baseline.managed_schema_acl_sha256 ? "EXACT_MATCH_BASELINE" : "DRIFT"}`, "FRESH vs SEALED");
  const dp = await q(`select pg_get_userbyid(defaclrole) r, coalesce((select nspname from pg_namespace where oid=defaclnamespace),'-') n,
     defaclobjtype t, defaclacl::text a from pg_default_acl order by 1,2,3,4`);
  B("default privileges 건수", dp.length, "FRESH");
  B("default privileges canonical hash",
    sha256(dp.map((r) => `${r.r}|${r.n}|${r.t}|${r.a}`).join("\n")).slice(0, 32) + "…", "FRESH");
  B("auth.users", (await g(`select count(*) v from auth.users`)).v, "FRESH");
  B("storage.objects", (await g(`select count(*) v from storage.objects`)).v, "FRESH");

  head("5. materialization ledger 대조");
  const ledger = passB.ACL_MATERIALIZATION_LEDGER;
  const required = ledger.filter((r) => r.classification === "MATERIALIZED_REQUIRED").map((r) => r.ident);
  const nowNonNull = new Set([...inv.relations, ...inv.sequences, ...inv.routines, ...inv.schemas]
    .filter((o) => !o.acl_is_null).map((o) => o.ident));
  const stillMaterialized = required.filter((i) => nowNonNull.has(i)).length;
  B("MATERIALIZED_REQUIRED (레저)", required.length, "SEALED_RECEIPT");
  B("그중 현재도 explicit ACL", stillMaterialized, "FRESH");
  B("MATERIALIZED_UNEXPECTED", ledger.filter((r) => r.classification === "MATERIALIZED_UNEXPECTED").length, "SEALED_RECEIPT");

  head("6. 활동성 / 무결성");
  B("active writer", (await g(`select count(*) v from pg_stat_activity where datname=current_database()
     and pid<>pg_backend_pid() and state='active'
     and query ~* '^\\s*(insert|update|delete|truncate|alter|drop|create|grant|revoke)'`)).v, "FRESH");
  B("prepared transaction", (await g(`select count(*) v from pg_prepared_xacts`)).v, "FRESH");
  B("probe unclassified error", ps.unclassified, "FRESH");
  B("probe attempted/completed", `${ps.attempted}/${ps.completed}`, "FRESH");
  B("raw ACL snapshot hash", sha256(raw.join("\n")).slice(0, 32) + "…", "FRESH");
  B("canonical expanded hash", sha256(expanded.join("\n")).slice(0, 32) + "…", "FRESH");

  head("7. 미해결 ACL 차이");
  const drill = JSON.parse(readFileSync(join(RUN, "ACL_ROLLBACK_DRILL_RAW.json"), "utf8"));
  B("unexplained ACL difference", drill.unexplained_raw_diff_count, "DRILL_RECEIPT");
  B("explicit unresolved item (증거 한계)", drill.explicit_unresolved_item_count ?? "n/a", "DRILL_RECEIPT");

  const out = {
    document: "POST_COMMIT_COMPLETENESS_BINDING",
    responds_to: "P-20260721-PASS_B_FORMAL_GAP_AND_TX_A_HOLD_01 §5",
    method: "fresh read-only 측정 + 봉인 receipt 인용. 과거 상태를 현재로 소급 추정하지 않음.",
    bindings: bind,
  };
  const buf = Buffer.from(JSON.stringify(out, null, 2));
  writeFileSync(OUT, buf);
  head("판정");
  console.log(`\nPOST_COMMIT_COMPLETENESS_BINDING=COMPLETE (${bind.length}항목)`);
  console.log(`SHA256=${sha256(buf)}`);
  console.log(`OUT=${OUT}`);
  return 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
process.exit(code);
