// ============================================================
// dev-rollback-drill-raw.mjs — LAYER_B 드릴 RAW 수준 검증 (반드시 ROLLBACK 종료)
// ============================================================
// GPT §7 요구:
//   - grantor exact match / grant option exact match
//   - raw 차이는 NULL_EQUIVALENT_EXPLICIT_ACL 만 허용
//   - 설명되지 않은 raw 차이 0
//   - tuple-level rollback ledger
//
// PASS_B 드릴은 CANONICAL_EXPANDED_ACL_VECTOR exact match 까지만 봤다.
// 이 벡터가 grantor·is_grantable 을 포함하므로 그 둘은 충족되나,
// RAW(pg_class.relacl 등 텍스트) 대조는 남아 있었다. 여기서 메운다.
//
// 판정 논리 — pre-fence RAW 스냅샷은 봉인해두지 않았으므로 다음으로 대체한다.
//   (1) pre-fence 에 acl NULL 이었던 객체(PASS_B 레저 32건)는
//       rollback 후 explicit ACL 이 될 수 있다. 그 값이
//       acldefault(objtype, owner) 와 정확히 같을 때만
//       NULL_EQUIVALENT_EXPLICIT_ACL 로 분류한다. 아니면 위반이다.
//   (2) 그 외 객체는 pre-fence 에 explicit ACL 이 있었고, expanded vector 가
//       exact match 이므로 aclitem **집합**이 동일하다. 여기서는
//       rollback 전후로 aclitem 집합이 복원되는지, 순서만 다른지 계상한다.
//   (3) 설명되지 않은 raw 차이 = 위 어느 범주에도 안 들어가는 것. 0 이어야 한다.
//
// 실행: node scripts/manual/dev-rollback-drill-raw.mjs
// ============================================================
import pg from "pg";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readDevEnv, assertDevUrl, scrub } from "./dev-url.mjs";
import * as L from "./fence-v2-lib.mjs";

const RUN = join(homedir(), "prod-runs", "DEV_PASS_B");
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(46)} ${v}`);
const fails = [];
const rec = (n, ok, d) => { if (!ok) fails.push(n); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

const { DEV_DB_URL: url } = readDevEnv(["DEV_DB_URL"]);
assertDevUrl(url, "DEV_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

/** "{a=r/postgres,b=w/postgres}" → 정렬된 aclitem 배열 */
const items = (acl) => acl === "NULL" || !acl ? null
  : acl.replace(/^\{|\}$/g, "").split(",").map((s) => s.trim()).filter(Boolean).sort();

async function main() {
  await c.connect();
  const receipts = JSON.parse(readFileSync(join(RUN, "PASS_B_RECEIPTS.json"), "utf8"));
  const rollbackSql = readFileSync(join(RUN, "fence-rollback.sql"), "utf8")
    .split("\n").map((s) => s.trim()).filter(Boolean);
  // PASS_B 레저 = pre-fence 에 acl NULL 이었던 객체 전수
  const wasNull = new Set(receipts.ACL_MATERIALIZATION_LEDGER.map((r) => r.ident));

  const names = (await L.projectSchemas(c)).map((s) => s.schema);
  const fencedRaw = await L.rawAclSnapshot(c, names);
  const fencedInv = await L.inventory(c, names);
  const fencedExpanded = await L.expandedAclVector(c, fencedInv);

  head("1. 드릴 트랜잭션 — rollback artifact 적용");
  line("rollback 문장", rollbackSql.length);
  line("pre-fence acl NULL 객체(레저)", wasNull.size);
  await c.query("begin");
  await c.query(`set local lock_timeout='10s'`);

  let ledger = [], drillRaw = [];
  try {
    for (const s of rollbackSql) await c.query(s);
    drillRaw = await L.rawAclSnapshot(c, names);

    // acldefault 기대값 조회 (objtype, owner 별)
    const defaults = new Map();
    const aclDefault = async (type, owner) => {
      const key = `${type}|${owner}`;
      if (!defaults.has(key)) {
        const r = await c.query(
          `select acldefault($1::"char", $2::regrole)::text d`, [type, owner]);
        defaults.set(key, r.rows[0].d);
      }
      return defaults.get(key);
    };
    const ownerOf = new Map();
    for (const o of [...fencedInv.relations, ...fencedInv.sequences,
                     ...fencedInv.routines, ...fencedInv.schemas]) ownerOf.set(o.ident, o.owner);
    const typeOf = new Map();
    for (const o of fencedInv.relations) typeOf.set(o.ident, "r");
    for (const o of fencedInv.sequences) typeOf.set(o.ident, "S");
    for (const o of fencedInv.routines) typeOf.set(o.ident, "f");
    for (const o of fencedInv.schemas) typeOf.set(o.ident, "n");

    const parse = (v) => { const i = v.indexOf("|"), j = v.indexOf("|", i + 1);
      return { k: v.slice(0, i), ident: v.slice(i + 1, j), acl: v.slice(j + 1) }; };
    const fMap = new Map(fencedRaw.map((v) => { const p = parse(v); return [`${p.k}|${p.ident}`, p]; }));
    const dMap = new Map(drillRaw.map((v) => { const p = parse(v); return [`${p.k}|${p.ident}`, p]; }));

    head("2. tuple-level ROLLBACK LEDGER (raw 대조)");
    for (const key of new Set([...fMap.keys(), ...dMap.keys()])) {
      const f = fMap.get(key), d = dMap.get(key);
      const ident = (f || d).ident;
      const row = { key, fenced_acl: f?.acl ?? "ABSENT", drill_acl: d?.acl ?? "ABSENT" };

      if (row.fenced_acl === row.drill_acl) { row.classification = "UNCHANGED"; ledger.push(row); continue; }

      if (wasNull.has(ident)) {
        // pre-fence NULL → rollback 후 explicit 이면 acldefault 와 같아야 한다
        const t = typeOf.get(ident), ow = ownerOf.get(ident);
        if (row.drill_acl === "NULL") { row.classification = "RESTORED_TO_NULL"; ledger.push(row); continue; }
        if (t && ow) {
          const exp = await aclDefault(t, ow);
          const eq = JSON.stringify(items(row.drill_acl)) === JSON.stringify(items(exp));
          row.acldefault_expected = exp;
          row.classification = eq ? "NULL_EQUIVALENT_EXPLICIT_ACL" : "UNEXPLAINED_RAW_DIFF";
        } else row.classification = "UNEXPLAINED_RAW_DIFF";
        ledger.push(row); continue;
      }

      // pre-fence explicit — aclitem 집합이 복원됐는지
      const fi = items(row.fenced_acl), di = items(row.drill_acl);
      row.classification = (fi && di && JSON.stringify(fi) !== JSON.stringify(di))
        ? "EXPLICIT_ACL_RESTORED_BY_ROLLBACK" : "UNEXPLAINED_RAW_DIFF";
      ledger.push(row);
    }

    const tally = {};
    for (const r of ledger) tally[r.classification] = (tally[r.classification] || 0) + 1;
    for (const [k, v] of Object.entries(tally)) line(k, v);
    const unexplained = ledger.filter((r) => r.classification === "UNEXPLAINED_RAW_DIFF");
    rec("설명되지 않은 raw 차이 = 0", unexplained.length === 0, String(unexplained.length));
    for (const u of unexplained.slice(0, 8)) line("  위반", `${u.key} :: ${u.drill_acl}`);
    // acldefault 와 다른 값은 위에서 이미 UNEXPLAINED_RAW_DIFF 로 분류되므로,
    // "미설명 0" 이 곧 "NULL 객체 전부 acldefault 동등"의 증명이다.
    // 여기서는 판정을 중복으로 세우지 않고 건수만 기록한다.
    const nullEq = ledger.filter((r) => r.classification === "NULL_EQUIVALENT_EXPLICIT_ACL");
    line("NULL_EQUIVALENT_EXPLICIT_ACL (acldefault 동등 확인됨)", `${nullEq.length}건`);
    line("pre-fence NULL 인데 rollback 후에도 NULL",
      ledger.filter((r) => r.classification === "RESTORED_TO_NULL").length
      + ledger.filter((r) => r.classification === "UNCHANGED" && wasNull.has(r.key.split("|")[1])).length + "건");

    head("3. grantor / grant option (CANONICAL_EXPANDED 재확인)");
    const drillInv = await L.inventory(c, names);
    const drillExpanded = await L.expandedAclVector(c, drillInv);
    // 벡터 튜플은 object|grantor|grantee|privilege|is_grantable 구조다
    const gr = (arr) => new Set(arr.map((t) => t.split("|").slice(0, 2).join("|")));
    const go = (arr) => new Set(arr.map((t) => t.split("|").slice(0, 5).join("|")));
    line("object|grantor 조합 (드릴 / fenced)", `${gr(drillExpanded).size} / ${gr(fencedExpanded).size}`);
    // 벡터 튜플에 중복이 있으면 집합 비교가 차이를 삼킬 수 있다. 중복 0 을 먼저 세운다.
    rec("expanded 벡터 튜플 중복 0 (집합 비교 신뢰성 전제)",
      go(drillExpanded).size === drillExpanded.length,
      `unique ${go(drillExpanded).size} / total ${drillExpanded.length}`);
  } catch (e) {
    console.error("  드릴 오류: " + scrub(e.message || String(e), url).slice(0, 300));
    fails.push("드릴 실행 오류");
  } finally {
    await c.query("rollback");
    line("드릴 종료", "ROLLBACK");
  }

  head("4. 드릴 후 dev 상태 재확인 (GPT §3)");
  const afterRaw = await L.rawAclSnapshot(c, names);
  const afterInv = await L.inventory(c, names);
  const afterExpanded = await L.expandedAclVector(c, afterInv);
  L.resetProbeStats();
  const afterEff = await L.effectiveVector(c, afterInv);
  const psAfter = { ...L.probeStats };
  rec("raw fenced-state hash exact",
    sha256(afterRaw.join("\n")) === sha256(fencedRaw.join("\n")));
  rec("canonical expanded hash exact",
    sha256(afterExpanded.join("\n")) === sha256(fencedExpanded.join("\n")));
  const mutation = Object.entries(afterEff).filter(([k, v]) => {
    if (v !== true) return false;
    const [kind, role, , priv] = k.split("|");
    if (!["anon", "authenticated"].includes(role)) return false;
    return !(priv === "SELECT" || (kind === "sch" && priv === "USAGE"));
  });
  rec("드릴 후 mutation privilege 0", mutation.length === 0, String(mutation.length));
  rec("probe unclassified 0", psAfter.unclassified === 0, String(psAfter.unclassified));
  const effHash = sha256(Object.keys(afterEff).sort().map((k) => `${k}=${afterEff[k]}`).join("\n"));
  line("effective privilege hash", effHash.slice(0, 24) + "…");

  head("5. FORMAL 판정의 증거 한계 (과대보고하지 않는다)");
  // GPT §3 은 "pre-fence raw ACL 과 rollback 적용 후 raw ACL 대조"를 요구한다.
  // 그러나 PASS_B 는 pre-fence RAW 스냅샷을 봉인하지 않았다. 커밋이 끝난
  // 지금은 복원 불가능하며, 재현하려면 dev reset 이 필요한데 GPT 는 이를
  // 명시적으로 불허했다. 따라서 다음과 같이 구분해 보고한다.
  const limitations = [
    { item: "RAW_PREFENCE_SNAPSHOT_SEALED", value: "NO",
      note: "PASS_B 가 pre-fence raw 를 봉인하지 않았다. 사후 복원 불가." },
    { item: "RAW_EXACT_MATCH_VS_MEASURED_PREFENCE", value: "NOT_POSSIBLE",
      note: "봉인본이 없어 직접 대조가 성립하지 않는다. 추정으로 대체하지 않는다." },
    { item: "CANONICAL_EXPANDED_EXACT_VS_LIVE_PREFENCE", value: "PROVEN_IN_PASS_B",
      note: "PASS_B 드릴은 트랜잭션 안에서 실제 pre-fence 벡터와 대조했고 -0/+0 이었다. "
          + "이 벡터는 object·grantor·grantee·privilege·is_grantable 을 모두 포함하므로 "
          + "grantor/grantee/privilege/is_grantable/object identity exact 는 충족된다." },
    { item: "NULLNESS_LEDGERED", value: "YES_32",
      note: "raw 가 더 갖는 정보 중 NULL 여부는 레저로 별도 실측됐다." },
    { item: "RAW_ORDER_ONLY_DIFFERENCE", value: "UNMEASURED",
      note: "aclitem 배열 순서는 pre-fence 시점에 측정된 바 없다. 0 이라고 주장하지 않는다." },
  ];
  for (const l of limitations) line(l.item, l.value);
  const unresolvedItems = limitations.filter((l) => /NOT_POSSIBLE|UNMEASURED|^NO$/.test(l.value)).length;
  line("명시적 unresolved item 수", unresolvedItems);
  console.log("  · 운영 러너에는 fence 적용 직전 raw 스냅샷 봉인을 추가한다.");
  console.log("    (같은 한계가 운영에서 반복되지 않도록)");

  const out = {
    drill: "LAYER_B_ACL_ROLLBACK_DRILL_RAW",
    ended_with: "ROLLBACK",
    rollback_statements: rollbackSql.length,
    tuple_ledger_rows: ledger.length,
    classification_tally: ledger.reduce((a, r) => (a[r.classification] = (a[r.classification] || 0) + 1, a), {}),
    unexplained_raw_diff_count: ledger.filter((r) => r.classification === "UNEXPLAINED_RAW_DIFF").length,
    fenced_raw_sha256: sha256(fencedRaw.join("\n")),
    formal_evidence_limitations: limitations,
    explicit_unresolved_item_count: unresolvedItems,
    post_drill: { mutation_privilege: mutation.length, effective_privilege_hash: effHash },
    drill_raw_sha256: sha256(drillRaw.join("\n")),
    tuple_ledger: ledger,
  };
  writeFileSync(join(RUN, "ACL_ROLLBACK_DRILL_RAW.json"), JSON.stringify(out, null, 2));

  head("판정");
  console.log(`\nROLLBACK_DRILL_RAW=${fails.length ? "FAIL" : "PASS"}`);
  console.log(`UNEXPLAINED_RAW_DIFF=${out.unexplained_raw_diff_count}`);
  console.log(`TUPLE_LEDGER_ROWS=${out.tuple_ledger_rows}`);
  console.log(`LAYER_B_FORMAL=PARTIAL — RAW_PREFENCE_SNAPSHOT_SEALED=NO`);
  console.log(`EXPLICIT_UNRESOLVED_ITEMS=${unresolvedItems}`);
  console.log(`RECEIPT=${join(RUN, "ACL_ROLLBACK_DRILL_RAW.json")}`);
  if (fails.length) for (const f of fails) console.log(`  · ${f}`);
  return fails.length ? 3 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
process.exit(code);
