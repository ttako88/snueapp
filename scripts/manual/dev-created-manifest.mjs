// ============================================================
// dev-created-manifest.mjs — CREATED_OBJECT_MANIFEST + observer 커버리지 정정
// ============================================================
// GPT P-20260721-PASS_B_FORMAL_GAP_AND_TX_A_HOLD_01 §4 대응.
//
// 08 보고서의 "생성 객체 매니페스트 38개 전수"는 과대표현이었다.
// to_regclass 는 relation·sequence 만 해석한다. routine·schema 는
// 검사되지 않았다. 여기서 다음을 한다.
//   1. 실제 CREATED_OBJECT_MANIFEST 를 kind 별로 확정 (현재 − 봉인 baseline)
//   2. kind 별 정확한 observer lookup 을 정의하고 dev 에서 read-only 로
//      문법·identity 해석을 검증한다 (가시성 판정이 아니라 lookup 이
//      실제로 그 객체를 집어내는지의 검증)
//   3. 38 이 전체가 아니라 regclass subset 임을 수치로 못박는다
//
// 38 을 routine·schema 실측으로 소급 포장하지 않는다.
// 이 스크립트는 READ-ONLY 다. dev reset·PASS_B 재실행 없음.
// ============================================================
import pg from "pg";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readDevEnv, assertDevUrl, scrub } from "./dev-url.mjs";
import * as L from "./fence-v2-lib.mjs";

const BASE = join(homedir(), "prod-runs", "DEV_PRE_TX_BASELINE", "PRE_TX_BASELINE_RECEIPT.json");
const OUT = join(homedir(), "prod-runs", "DEV_PASS_B", "CREATED_OBJECT_MANIFEST.json");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(46)} ${v}`);
const fails = [];
const rec = (n, ok, d) => { if (!ok) fails.push(n); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

// kind → observer 가 COMMIT 전 가시성을 검사할 때 써야 하는 정확한 lookup
const OBSERVER_LOOKUP = {
  relation: { fn: "to_regclass", sql: "select to_regclass($1) is not null v" },
  sequence: { fn: "to_regclass", sql: "select to_regclass($1) is not null v" },
  routine:  { fn: "to_regprocedure", sql: "select to_regprocedure($1) is not null v" },
  schema:   { fn: "to_regnamespace", sql: "select to_regnamespace($1) is not null v" },
  type:     { fn: "to_regtype", sql: "select to_regtype($1) is not null v" },
};

const { DEV_DB_URL: url } = readDevEnv(["DEV_DB_URL"]);
assertDevUrl(url, "DEV_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();
  const q = async (s, p = []) => (await c.query(s, p)).rows;
  const baseline = JSON.parse(readFileSync(BASE, "utf8"));
  const baseIdents = new Set(baseline.objects.map((o) => `${o.kind}|${o.ident}`));

  head("0. 봉인 baseline (생성 판정의 기준선)");
  line("baseline 객체", baseline.objects.length);
  for (const o of baseline.objects) line(`  ${o.kind}`, o.ident);

  const names = (await L.projectSchemas(c)).map((s) => s.schema);
  const inv = await L.inventory(c, names);

  head("1. 현재 상태 (PASS_B COMMIT 후)");
  const current = [];
  for (const o of inv.schemas)   current.push({ kind: "schema", ident: o.ident, owner: o.owner });
  for (const o of inv.relations) current.push({ kind: "relation", ident: o.ident, owner: o.owner });
  for (const o of inv.sequences) current.push({ kind: "sequence", ident: o.ident, owner: o.owner });
  for (const o of inv.routines)  current.push({ kind: "routine", ident: o.ident, owner: o.owner });
  // default privilege 는 type 에도 적용될 수 있다 — 분모에 넣기 위해 조회한다
  for (const t of await q(
    `select n.nspname||'.'||t.typname ident, pg_get_userbyid(t.typowner) owner
       from pg_type t join pg_namespace n on n.oid=t.typnamespace
      where n.nspname = any($1::text[])
        and t.typtype in ('e','d','r','c')
        and not exists (select 1 from pg_class c2 where c2.oid=t.typrelid and c2.relkind<>'c')
      order by 1`, [names])) current.push({ kind: "type", ident: t.ident, owner: t.owner });

  const byKind = {};
  for (const o of current) byKind[o.kind] = (byKind[o.kind] || 0) + 1;
  line("현재 객체 kind별", JSON.stringify(byKind));

  head("2. CREATED_OBJECT_MANIFEST = 현재 − baseline");
  const created = current.filter((o) => !baseIdents.has(`${o.kind}|${o.ident}`));
  const createdByKind = {};
  for (const o of created) createdByKind[o.kind] = (createdByKind[o.kind] || 0) + 1;
  for (const [k, v] of Object.entries(createdByKind).sort()) line(`생성 ${k}`, v);
  line("생성 객체 총계", created.length);

  const regclassSubset = created.filter((o) => o.kind === "relation" || o.kind === "sequence");
  head("3. OBSERVER COVERAGE 정정");
  line("08 보고서가 실측한 범위", `to_regclass = relation+sequence = ${regclassSubset.length}건`);
  line("실제 생성 객체 총계", created.length);
  line("08 이 검사하지 못한 객체", created.length - regclassSubset.length);
  console.log("  · 08 의 \"38개 전수\"는 regclass subset 이었다. routine·schema·type 은");
  console.log("    to_regclass 로 해석되지 않으므로 가시성 검사에 포함되지 않았다.");
  console.log("  · 이 사실을 소급 포장하지 않고 그대로 기록한다.");
  rec("38 = regclass subset 임이 수치로 확인됨", regclassSubset.length === 38,
    `${regclassSubset.length}`);

  head("4. 보완 observer lookup — dev read-only 문법·identity 검증");
  // 이미 COMMIT 됐으므로 전부 보여야 정상이다. 여기서 검증하는 것은
  // "가시성 0" 이 아니라 "각 lookup 이 해당 객체를 실제로 집어내는가" 다.
  const lookupCheck = [];
  let resolved = 0, unresolved = 0;
  for (const o of created) {
    const lk = OBSERVER_LOOKUP[o.kind];
    if (!lk) { unresolved++; lookupCheck.push({ ...o, lookup: "NONE", resolves: false }); continue; }
    let v = false, err = null;
    try { v = (await q(lk.sql, [o.ident]))[0].v; } catch (e) { err = e.message.slice(0, 120); }
    if (v) resolved++; else unresolved++;
    lookupCheck.push({ ...o, lookup: lk.fn, resolves: !!v, error: err });
  }
  for (const [k, lk] of Object.entries(OBSERVER_LOOKUP)) {
    const n = created.filter((o) => o.kind === k).length;
    if (n) line(`${k} → ${lk.fn}()`, `${n}건`);
  }
  rec("모든 생성 객체가 kind별 lookup 으로 해석됨", unresolved === 0,
    `resolved ${resolved} / unresolved ${unresolved}`);
  for (const u of lookupCheck.filter((x) => !x.resolves).slice(0, 8))
    line("  해석 실패", `${u.kind} ${u.ident} (${u.lookup}) ${u.error ?? ""}`);

  head("5. 운영 러너에 요구되는 COMMIT 전 observer 검사 규격");
  const spec = Object.entries(OBSERVER_LOOKUP).map(([k, v]) => `${k} → ${v.fn}()`);
  for (const s of spec) console.log("  · " + s);
  console.log("  · 위 매니페스트 전체의 observer 가시성이 0 이 아니면 COMMIT 금지.");
  console.log("  · 분모는 추정하지 말고 매 실행마다 실제 매니페스트에서 산출한다.");

  const out = {
    document: "CREATED_OBJECT_MANIFEST",
    responds_to: "P-20260721-PASS_B_FORMAL_GAP_AND_TX_A_HOLD_01 §4",
    baseline_objects: baseline.objects.length,
    current_by_kind: byKind,
    created_by_kind: createdByKind,
    created_total: created.length,
    observer_correction: {
      previously_reported: "생성 객체 매니페스트 38개 전수",
      actual_direct_coverage: "REGCLASS_OBJECTS_ONLY / RELATION+SEQUENCE",
      regclass_subset_count: regclassSubset.length,
      objects_not_covered_by_08: created.length - regclassSubset.length,
      retroactive_repackaging: "NOT_PERFORMED",
    },
    observer_lookup_spec: Object.fromEntries(
      Object.entries(OBSERVER_LOOKUP).map(([k, v]) => [k, v.fn])),
    lookup_verification: { resolved, unresolved },
    created_objects: created,
    lookup_detail: lookupCheck,
  };
  const buf = Buffer.from(JSON.stringify(out, null, 2));
  writeFileSync(OUT, buf);

  head("판정");
  console.log(`\nCREATED_OBJECT_MANIFEST=${fails.length ? "REVIEW" : "PASS"}`);
  console.log(`CREATED_TOTAL=${created.length}`);
  console.log(`CREATED_BY_KIND=${JSON.stringify(createdByKind)}`);
  console.log(`OBSERVER_08_COVERAGE=${regclassSubset.length}/${created.length}`);
  console.log(`LOOKUP_UNRESOLVED=${unresolved}`);
  console.log(`SHA256=${createHash("sha256").update(buf).digest("hex")}`);
  console.log(`OUT=${OUT}`);
  if (fails.length) for (const f of fails) console.log(`  · ${f}`);
  return fails.length ? 3 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
process.exit(code);
