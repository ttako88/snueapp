// ============================================================
// dev-baseline-seal.mjs — PRE_TX_BASELINE_RECEIPT 봉인 (dev, 읽기 전용)
// ============================================================
// GPT 지정 봉인 항목:
//   schema·relation·column·sequence·routine identity 와 relkind/prokind
//   object definition hash 와 owner / raw ACL NULL 여부
//   CANONICAL_EXPANDED_ACL_VECTOR / EFFECTIVE_PRIVILEGE_VECTOR
//   schema ACL 과 database CREATE / default privileges / role membership
//   managed schema ACL fingerprint / reset 대상 table row-count·sequence state
//   001~009 object absence manifest / active writer·prepared tx·blocking lock 0
//
// PASS_A 종료 후 이 봉인본과 raw fingerprint 가 **정확히** 일치해야 한다(LAYER_A).
//
// 실행: node scripts/manual/dev-baseline-seal.mjs
// ============================================================
import pg from "pg";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readDevEnv, assertDevUrl, DEV_REF, refOf, scrub } from "./dev-url.mjs";
import * as L from "./fence-v2-lib.mjs";

const OUT = join(homedir(), "prod-runs", "DEV_PRE_TX_BASELINE");
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const line = (k, v) => console.log(`  ${String(k).padEnd(44)} ${v}`);
const head = (t) => console.log(`\n=== ${t} ===`);

const { DEV_DB_URL: url } = readDevEnv(["DEV_DB_URL"]);
assertDevUrl(url, "DEV_DB_URL");
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  await client.connect();
  await client.query("begin transaction isolation level repeatable read read only");
  await client.query("set local statement_timeout = '120s'");

  const g = async (q, p = []) => (await client.query(q, p)).rows[0];
  const rows = async (q, p = []) => (await client.query(q, p)).rows;

  head("1. 접속·버전");
  const ver = await L.assertVersion(client, "17.6");
  line("PostgreSQL", `${ver.actual} ${ver.ok ? "✅" : "⛔"}`);
  line("target ref", refOf(url) === DEV_REF ? `${DEV_REF} ✅` : "⛔");
  const snap = await g(`select pg_current_snapshot()::text s, now() at time zone 'utc' t`);
  line("snapshot", snap.s);

  head("2. 프로젝트 스키마·분모");
  const schs = await L.projectSchemas(client);
  const names = schs.map((s) => s.schema);
  line("project schemas", schs.map((s) => `${s.schema}(${s.owner})`).join(", "));
  const inv = await L.inventory(client, names);
  line("relation / sequence / routine", `${inv.relations.length} / ${inv.sequences.length} / ${inv.routines.length}`);
  line("schema / column(explicit ACL)", `${inv.schemas.length} / ${inv.columns.length}`);

  head("3. 객체 정의 해시·owner·ACL NULL 여부");
  const objects = [];
  for (const r of [...inv.relations, ...inv.sequences]) {
    const cols = await rows(
      `select a.attname, format_type(a.atttypid,a.atttypmod) t, a.attnotnull nn
         from pg_attribute a where a.attrelid=$1 and a.attnum>0 and not a.attisdropped order by a.attnum`, [r.oid]);
    objects.push({ kind: r.relkind === "S" ? "sequence" : "relation", ident: r.ident, relkind: r.relkind ?? "S",
      owner: r.owner, acl_is_null: r.acl_is_null,
      def_sha256: sha256(cols.map((c) => `${c.attname}:${c.t}:${c.nn}`).join("\n")) });
  }
  for (const f of inv.routines) {
    const d = await g(`select pg_get_functiondef($1) d`, [f.oid]).catch(() => ({ d: "" }));
    objects.push({ kind: "routine", ident: f.ident, prokind: f.prokind, owner: f.owner,
      acl_is_null: f.acl_is_null, def_sha256: sha256(d.d || "") });
  }
  for (const s of inv.schemas) objects.push({ kind: "schema", ident: s.ident, owner: s.owner, acl_is_null: s.acl_is_null });
  line("객체 총계", objects.length);
  line("acl_is_null 객체", objects.filter((o) => o.acl_is_null).length);

  head("4. ACL 벡터");
  const expanded = await L.expandedAclVector(client, inv);
  const effective = await L.effectiveVector(client, inv);
  const rawAcl = await L.rawAclSnapshot(client, names);
  line("CANONICAL_EXPANDED_ACL_VECTOR", `${expanded.length} 튜플 / sha256 ${sha256(expanded.join("\n")).slice(0, 16)}…`);
  line("EFFECTIVE_PRIVILEGE_VECTOR", `${Object.keys(effective).length} 항목 / sha256 ${sha256(JSON.stringify(effective)).slice(0, 16)}…`);
  line("RAW_ACL_SNAPSHOT (NULL 포함)", `${rawAcl.length} 행 / sha256 ${sha256(rawAcl.join("\n")).slice(0, 16)}…`);

  head("5. default privileges · role membership · database CREATE");
  const defacl = await rows(
    `select pg_get_userbyid(d.defaclrole) role, coalesce(n.nspname,'-') sch, d.defaclobjtype typ, d.defaclacl::text acl
       from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace order by 1,2,3`);
  line("default privileges", defacl.length ? `${defacl.length}건` : "0건");
  const membership = await rows(
    `select pg_get_userbyid(m.roleid) grp, pg_get_userbyid(m.member) mem, m.admin_option
       from pg_auth_members m
      where pg_get_userbyid(m.member) in ('anon','authenticated','service_role','authenticator')
      order by 1,2`);
  line("role membership (앱 역할)", membership.map((m) => `${m.mem}→${m.grp}`).join(", ") || "없음");
  const dbcreate = {};
  for (const r of ["anon", "authenticated", "service_role"]) {
    dbcreate[r] = (await g(`select has_database_privilege($1, current_database(), 'CREATE') x`, [r])).x;
  }
  line("database CREATE", Object.entries(dbcreate).map(([k, v]) => `${k}=${v}`).join(" "));

  head("6. managed schema ACL 지문");
  const managed = await rows(
    `select n.nspname, coalesce(n.nspacl::text,'NULL') acl
       from pg_namespace n where n.nspname in ('auth','storage','extensions','graphql','realtime','vault','cron')
      order by 1`);
  const managedSha = sha256(managed.map((m) => `${m.nspname}|${m.acl}`).join("\n"));
  line("managed schema ACL sha256", managedSha.slice(0, 24) + "…");

  head("7. reset 대상 row-count · sequence state");
  const counts = {};
  for (const r of inv.relations) {
    counts[r.ident] = Number((await g(`select count(*) v from ${r.ident}`)).v);
  }
  const seqState = {};
  for (const s of inv.sequences) {
    const st = await g(`select last_value, is_called from ${s.ident}`).catch(() => null);
    seqState[s.ident] = st ? `${st.last_value}/${st.is_called}` : "n/a";
  }
  line("relation row counts", Object.keys(counts).length ? JSON.stringify(counts) : "{}");
  line("sequence state", Object.keys(seqState).length ? JSON.stringify(seqState) : "{}");

  head("8. 001~009 객체 부재 manifest");
  const absent = {
    private_schema: !(await g(`select to_regnamespace('private') is not null v`)).v,
    authz_schema: !(await g(`select to_regnamespace('authz') is not null v`)).v,
  };
  for (const t of ["boards", "posts", "comments", "profiles", "post_owners", "comment_owners", "bookmarks", "post_votes", "operational_messages"]) {
    absent[`public.${t}`] = !(await g(`select to_regclass($1) is not null v`, [`public.${t}`])).v;
  }
  const allAbsent = Object.values(absent).every(Boolean);
  line("001~009 객체 전부 부재", allAbsent ? "✅" : `⛔ ${Object.entries(absent).filter(([, v]) => !v).map(([k]) => k).join(", ")}`);
  line("public.rls_auto_enable 보존", (await g(`select count(*) v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='rls_auto_enable'`)).v);

  head("9. 활성 상태");
  const writers = Number((await g(`select count(*) v from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and state='active' and query ~* '^\\s*(insert|update|delete|truncate|alter|drop|create|grant|revoke)'`)).v);
  const prepared = Number((await g(`select count(*) v from pg_prepared_xacts`)).v);
  const locks = Number((await g(`select count(*) v from pg_locks l join pg_class c on c.oid=l.relation join pg_namespace n on n.oid=c.relnamespace where n.nspname=any($1::text[]) and l.pid<>pg_backend_pid() and l.mode in ('ExclusiveLock','AccessExclusiveLock','ShareRowExclusiveLock')`, [names])).v);
  line("writer / prepared / blocking lock", `${writers} / ${prepared} / ${locks}`);

  await client.query("rollback");

  // ── 봉인 ──
  const receipt = {
    receipt: "PRE_TX_BASELINE_RECEIPT",
    target_ref: DEV_REF,
    sealed_at_utc: new Date().toISOString(),
    postgres_version: ver.actual,
    snapshot: snap.s,
    project_schemas: schs,
    denominator: { relations: inv.relations.length, sequences: inv.sequences.length,
                   routines: inv.routines.length, schemas: inv.schemas.length, columns_with_acl: inv.columns.length },
    objects,
    vectors: {
      canonical_expanded_acl_sha256: sha256(expanded.join("\n")),
      canonical_expanded_acl_count: expanded.length,
      effective_privilege_sha256: sha256(JSON.stringify(effective)),
      effective_privilege_count: Object.keys(effective).length,
      raw_acl_snapshot_sha256: sha256(rawAcl.join("\n")),
      raw_acl_rows: rawAcl.length,
    },
    default_privileges: defacl,
    role_membership: membership,
    database_create: dbcreate,
    managed_schema_acl_sha256: managedSha,
    row_counts: counts,
    sequence_state: seqState,
    absence_manifest: absent,
    all_001_009_absent: allAbsent,
    activity: { writers, prepared, blocking_locks: locks },
  };
  mkdirSync(OUT, { recursive: true });
  const rj = JSON.stringify(receipt, null, 2);
  writeFileSync(join(OUT, "PRE_TX_BASELINE_RECEIPT.json"), rj);
  writeFileSync(join(OUT, "canonical_expanded_acl.txt"), expanded.join("\n") + "\n");
  writeFileSync(join(OUT, "effective_privilege.json"), JSON.stringify(effective, null, 2));
  writeFileSync(join(OUT, "raw_acl_snapshot.txt"), rawAcl.join("\n") + "\n");
  const files = ["PRE_TX_BASELINE_RECEIPT.json", "canonical_expanded_acl.txt", "effective_privilege.json", "raw_acl_snapshot.txt"];
  writeFileSync(join(OUT, "SHA256SUMS.txt"),
    files.map((f) => `${sha256(readFileSync(join(OUT, f)))}  ${f}`).join("\n") + "\n");

  head("봉인 완료");
  line("위치", OUT);
  line("RECEIPT_SHA256", sha256(rj));
  console.log("");
  console.log(`PRE_TX_BASELINE=${allAbsent && writers === 0 && prepared === 0 && locks === 0 ? "SEALED" : "SEALED_WITH_WARNINGS"}`);
  console.log(`BASELINE_PUBLIC_RELATIONS=${inv.relations.length}`);
  console.log(`BASELINE_PUBLIC_ROUTINES=${inv.routines.length}`);
  console.log(`CANONICAL_EXPANDED_ACL_SHA256=${sha256(expanded.join("\n"))}`);
  console.log(`EFFECTIVE_PRIVILEGE_SHA256=${sha256(JSON.stringify(effective))}`);
  console.log(`RAW_ACL_SNAPSHOT_SHA256=${sha256(rawAcl.join("\n"))}`);
  console.log(`RECEIPT_SHA256=${sha256(rj)}`);
}

main().then(() => client.end()).catch(async (e) => {
  console.error("[fail] " + scrub(e.message || String(e), url));
  try { await client.end(); } catch {} process.exit(1);
});
