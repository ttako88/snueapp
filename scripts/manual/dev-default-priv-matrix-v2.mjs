// ============================================================
// dev-default-priv-matrix-v2.mjs — DEFAULT_PRIVILEGE_APPLICATION_MATRIX (정정본)
// ============================================================
// GPT P-20260721-PASS_B_FORMAL_GAP_AND_TX_A_HOLD_01 §2 대응.
//   Q1_ANSWER = OPTION_A_CORRECTED / PER_CREATED_OBJECT_ACTUAL_APPLICABILITY
//   - 38(regclass subset) 이 아니라 실제 CREATED_OBJECT_MANIFEST 전체가 분모
//   - row 마다 default entry ↔ created object 쌍의 적용성과 근거를 기록
//   - attribution 은 증거 등급을 구분한다. profile 일치만으로
//     DEFAULT_APPLIED_VERIFIED 라고 단정하지 않는다.
//
// 증거 한계 명시:
//   CREATE 직후 ACL 스냅샷은 봉인해두지 않았다. pre-fence ACL 은
//   rollback artifact 를 롤백되는 트랜잭션에서 적용해 **재구성**한다.
//   재구성값은 RECONSTRUCTED_VIA_ROLLBACK_ARTIFACT 로 표기하며
//   직접 측정값으로 취급하지 않는다.
//
// READ-ONLY. 모든 쓰기는 단일 트랜잭션 안이고 반드시 ROLLBACK 으로 끝난다.
// ============================================================
import pg from "pg";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readDevEnv, assertDevUrl, scrub } from "./dev-url.mjs";

const RUN = join(homedir(), "prod-runs", "DEV_PASS_B");
const DERIV = join(homedir(), "prod-runs", "TXB_BODY_RC1");
const MIGR = ["001_schemas_roles", "002_foundation", "003_functions_triggers",
              "004_admin_batch_functions", "005_schedules"];
const OUT = join(RUN, "DEFAULT_PRIVILEGE_APPLICATION_MATRIX_V2.json");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(48)} ${v}`);

// defaclobjtype → 우리 매니페스트의 kind
const OBJTYPE_KIND = { r: "relation", S: "sequence", f: "routine", T: "type", n: "schema" };
// aclitem 권한문자 → 이름
const PRIV = { a: "INSERT", r: "SELECT", w: "UPDATE", d: "DELETE", D: "TRUNCATE",
               x: "REFERENCES", t: "TRIGGER", m: "MAINTAIN", X: "EXECUTE",
               U: "USAGE", C: "CREATE", c: "CONNECT", T: "TEMPORARY" };

const { DEV_DB_URL: url } = readDevEnv(["DEV_DB_URL"]);
assertDevUrl(url, "DEV_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

// aclitem 배열 문자열을 파싱한다. grantee 가 비면 PUBLIC,
// 권한문자 뒤의 별표는 grant option 을 뜻한다.
function parseAcl(acl) {
  if (!acl || acl === "NULL") return null;
  return acl.replace(/^\{|\}$/g, "").split(",").map((s) => s.trim()).filter(Boolean).map((it) => {
    const eq = it.indexOf("=");
    const slash = it.lastIndexOf("/");
    const grantee = it.slice(0, eq) || "PUBLIC";
    const grantor = slash >= 0 ? it.slice(slash + 1) : "";
    const body = it.slice(eq + 1, slash >= 0 ? slash : undefined);
    const privs = [], grantable = [];
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === "*") continue;
      const name = PRIV[ch] ?? ch;
      privs.push(name);
      if (body[i + 1] === "*") grantable.push(name);
    }
    return { grantee, grantor, privs, grantable };
  });
}
const aclItems = (a) => !a || a === "NULL" ? []
  : a.replace(/^\{|\}$/g, "").split(",").map((s) => s.trim()).filter(Boolean).sort();

async function main() {
  await c.connect();
  const q = async (s, p = []) => (await c.query(s, p)).rows;
  const manifest = JSON.parse(readFileSync(join(RUN, "CREATED_OBJECT_MANIFEST.json"), "utf8"));
  const created = manifest.created_objects;
  const runnerRole = (await q(`select current_user u`))[0].u;

  head("0. 분모");
  const defaults = await q(`
    select pg_get_userbyid(defaclrole) role,
           (select nspname from pg_namespace where oid=defaclnamespace) nsp,
           defaclobjtype ot, defaclacl::text acl from pg_default_acl order by 1,2,3`);
  line("① pg_default_acl canonical entries", defaults.length);
  line("② created objects by kind", JSON.stringify(manifest.created_by_kind));
  line("   created objects 총계", created.length);

  head("1. 마이그레이션 본문의 명시적 GRANT 수집 (attribution 근거)");
  // 명시 GRANT 가 있으면 default 로 귀속시키면 안 된다.
  const explicitGrants = [];
  for (const m of MIGR) {
    const sql = readFileSync(join(DERIV, `${m}.body.sql`), "utf8");
    for (const mm of sql.matchAll(/\bgrant\s+([\s\S]{1,400}?)\bon\s+([\s\S]{1,200}?)\bto\s+([a-z_",\s]+?)\s*;/gi))
      explicitGrants.push({ file: m, priv: mm[1].replace(/\s+/g, " ").trim(),
                            target: mm[2].replace(/\s+/g, " ").trim(), grantee: mm[3].replace(/\s+/g, " ").trim() });
  }
  // REVOKE 도 수집한다. NULL 인 relacl/proacl 에 REVOKE 를 걸면 ACL 이
  // owner-only 로 **실체화**된다. 이 경로로 explicit 이 된 객체를
  // default 유래로 오귀속하면 안 된다. (GPT 분류 체계에 없는 유형이라
  // EXPLICIT_MIGRATION_REVOKE 를 확장 항목으로 신설한다.)
  const explicitRevokes = [];
  for (const m of MIGR) {
    const sql = readFileSync(join(DERIV, `${m}.body.sql`), "utf8");
    for (const mm of sql.matchAll(/^\s*revoke\s+([\s\S]{1,200}?)\bon\s+([\s\S]{1,200}?)\bfrom\s+([a-z_",\s]+?)\s*;/gim)) {
      const target = mm[2].replace(/\s+/g, " ").trim();
      if (/^default\s+privileges/i.test(target)) continue;
      explicitRevokes.push({ file: m, priv: mm[1].replace(/\s+/g, " ").trim(),
                             target, grantee: mm[3].replace(/\s+/g, " ").trim() });
    }
  }
  line("명시 GRANT 문", explicitGrants.length);
  line("명시 REVOKE 문 (ACL 실체화 경로)", explicitRevokes.length);
  // 부분문자열 매칭은 짧은 이름이 긴 이름에 먹혀 오탐을 낸다
  // (get_case 가 get_case_detail 에 매칭되는 식). 이름 경계를 강제한다.
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const findExplicitGrant = (ident, schema) => {
    const bare = ident.replace(/\(.*\)$/, "").toLowerCase();
    const short = bare.includes(".") ? bare.split(".").pop() : bare;
    const qualified = bare.includes(".") ? bare : `${schema}.${bare}`;
    const nameRe = new RegExp(`(^|[^a-z0-9_.])(${esc(qualified)}|${esc(schema)}\\.${esc(short)}|${esc(short)})([^a-z0-9_]|$)`, "i");
    const allRe = new RegExp(`all\\s+(tables|sequences|functions|routines)\\s+in\\s+schema\\s+${esc(schema)}([^a-z0-9_]|$)`, "i");
    return explicitGrants.find((g) => nameRe.test(g.target) || allRe.test(g.target)) ?? null;
  };
  const findExplicitRevoke = (ident, schema) => {
    const bare = ident.replace(/\(.*\)$/, "").toLowerCase();
    const short = bare.includes(".") ? bare.split(".").pop() : bare;
    const qualified = bare.includes(".") ? bare : `${schema}.${bare}`;
    const nameRe = new RegExp(`(^|[^a-z0-9_.])(${esc(qualified)}|${esc(schema)}\\.${esc(short)})([^a-z0-9_]|$)`, "i");
    const allRe = new RegExp(`all\\s+(tables|sequences|functions|routines)\\s+in\\s+schema\\s+${esc(schema)}([^a-z0-9_]|$)`, "i");
    return explicitRevokes.find((g) => nameRe.test(g.target) || allRe.test(g.target)) ?? null;
  };

  head("2. pre-fence ACL 재구성 (rollback artifact 적용 후 관측, ROLLBACK)");
  const rollbackSql = readFileSync(join(RUN, "fence-rollback.sql"), "utf8")
    .split("\n").map((s) => s.trim()).filter(Boolean);
  const preFence = new Map(), postFence = new Map();
  for (const o of created) postFence.set(o.ident, await readAcl(o));
  await c.query("begin");
  try {
    for (const s of rollbackSql) await c.query(s);
    for (const o of created) preFence.set(o.ident, await readAcl(o));
  } finally {
    await c.query("rollback");
    line("재구성 종료", "ROLLBACK — 영구 변경 0");
  }
  line("pre-fence ACL 재구성 대상", preFence.size);
  line("증거 등급", "RECONSTRUCTED_VIA_ROLLBACK_ARTIFACT (직접 측정 아님)");

  // 재구성으로는 pre-fence 의 **NULL 여부**를 알 수 없다. rollback GRANT 는
  // ACL 을 실체화하므로 NULL 이었던 객체도 explicit 으로 돌아온다
  // (LAYER_A/LAYER_B 구분의 근거 그 자체). NULL 여부는 PASS_B 실행 중
  // 실제로 측정된 ACL_MATERIALIZATION_LEDGER 에서 가져온다.
  const passB = JSON.parse(readFileSync(join(RUN, "PASS_B_RECEIPTS.json"), "utf8"));
  const preFenceNull = new Set(passB.ACL_MATERIALIZATION_LEDGER.map((r) => r.ident));
  line("pre-fence acl NULL (레저 실측)", preFenceNull.size);

  async function readAcl(o) {
    if (o.kind === "schema")
      return (await q(`select nspacl::text a from pg_namespace where nspname=$1`, [o.ident]))[0]?.a ?? null;
    if (o.kind === "routine")
      return (await q(`select proacl::text a from pg_proc where oid=$1::regprocedure`, [o.ident]))[0]?.a ?? null;
    return (await q(`select relacl::text a from pg_class where oid=$1::regclass`, [o.ident]))[0]?.a ?? null;
  }

  head("3. 매트릭스 — compatible pair 전개");
  const rows = [];
  let compatible = 0, applicable = 0, nonApplicable = 0;
  for (const d of defaults) {
    const kind = OBJTYPE_KIND[d.ot];
    const scope = d.nsp ? "PER_SCHEMA" : "GLOBAL";
    for (const o of created) {
      if (o.kind !== kind) continue;             // objtype 불일치 → candidate 아님
      compatible++;
      // namespace 는 매니페스트가 카탈로그에서 가져온 값을 쓴다.
      // ident 를 '.' 로 쪼개면 regprocedure 가 스키마를 생략한 public 함수에서 틀린다.
      const ns = o.namespace;
      const roleMatch = d.role === runnerRole;
      const nsMatch = !d.nsp || d.nsp === ns;
      const isApplicable = roleMatch && nsMatch;
      if (isApplicable) applicable++; else nonApplicable++;

      const pre = preFence.get(o.ident), post = postFence.get(o.ident);
      const expected = parseAcl(d.acl) ?? [];
      const preItems = aclItems(pre), defItems = aclItems(d.acl);
      const profileMatch = isApplicable && preItems.length > 0 &&
        defItems.every((x) => preItems.includes(x));

      // ── attribution: 증거 등급을 구분한다 ─────────────────
      // CREATE 직후 스냅샷이 없으므로 profile 일치만으로
      // DEFAULT_APPLIED_VERIFIED 라고 올리지 않는다.
      const eg = findExplicitGrant(o.ident, ns);
      let attribution;
      if (!isApplicable) attribution = "NOT_APPLICABLE";
      else if (eg) attribution = "EXPLICIT_MIGRATION_GRANT";
      else if (preFenceNull.has(o.ident)) attribution = "BUILTIN_ACLDEFAULT";
      else if (profileMatch) attribution = "DEFAULT_PROFILE_MATCH_ONLY";
      else attribution = "UNRESOLVED";

      rows.push({
        default_entry_id: `${d.role}|${d.nsp ?? "*GLOBAL*"}|${d.ot}`,
        defaclrole: d.role, defaclnamespace: d.nsp ?? null, defaclobjtype: d.ot,
        defaclacl_raw: d.acl, scope,
        object_ident: o.ident, object_kind: o.kind, object_namespace: ns,
        final_owner: o.owner,
        creator_role_at_create: runnerRole,
        creator_evidence: "RUNNER_ROLE_NOT_PER_OBJECT_RECORDED",
        applicable: isApplicable,
        non_applicable_reason: isApplicable ? null
          : !roleMatch ? `defaclrole(${d.role}) ≠ creator(${runnerRole})`
          : `defaclnamespace(${d.nsp}) ≠ object namespace(${ns})`,
        expected_grants: expected.map((e) => ({ grantee: e.grantee, privileges: e.privs,
                                                is_grantable: e.grantable })),
        observed_pre_fence_acl: pre ?? "NULL",
        observed_pre_fence_evidence: "RECONSTRUCTED_VIA_ROLLBACK_ARTIFACT",
        observed_post_fence_acl: post ?? "NULL",
        fence_removed_something: aclItems(pre).join() !== aclItems(post).join(),
        rollback_restored: aclItems(pre).length > 0 || pre === null,
        attribution_classification: attribution,
        attribution_evidence: eg
          ? `${eg.file}: GRANT ${eg.priv} ON ${eg.target} TO ${eg.grantee}`
          : preFenceNull.has(o.ident) ? "pre-fence ACL 이 NULL(레저 실측) — 내장 기본 ACL 유래"
          : profileMatch ? "pre-fence ACL 이 default profile 을 포함(출처 증거 아님)"
          : null,
      });
    }
  }
  line("③ compatible entry-object pairs", compatible);
  line("④ applicable pairs", applicable);
  line("⑤ non-applicable pairs (사유 기재됨)", nonApplicable);

  head("4. attribution 분포");
  const tally = {};
  for (const r of rows) tally[r.attribution_classification] = (tally[r.attribution_classification] || 0) + 1;
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) line(k, v);
  const unresolved = tally.UNRESOLVED ?? 0;
  line("⑥ attribution unresolved count", unresolved);

  head("4b. 객체 단위 attribution (95개 전수)");
  // BUILTIN_ACLDEFAULT 는 pair 속성이 아니라 객체 속성이다.
  // 적용 가능한 default entry 가 하나도 없는 객체(private·authz)는
  // pair 축에서는 NOT_APPLICABLE 로만 나타나므로 여기서 별도로 분류한다.
  const perObject = created.map((o) => {
    const pre = preFence.get(o.ident);
    const eg = findExplicitGrant(o.ident, o.namespace);
    const pairs = rows.filter((r) => r.object_ident === o.ident && r.applicable);
    let cls;
    if (preFenceNull.has(o.ident)) cls = "BUILTIN_ACLDEFAULT";
    else if (eg) cls = "EXPLICIT_MIGRATION_GRANT";
    else if (findExplicitRevoke(o.ident, o.namespace)) cls = "EXPLICIT_MIGRATION_REVOKE";
    else if (pairs.length) cls = "DEFAULT_PROFILE_MATCH_ONLY";
    else cls = "UNRESOLVED";
    return {
      ident: o.ident, kind: o.kind, namespace: o.namespace, owner: o.owner,
      pre_fence_acl_is_null: preFenceNull.has(o.ident),
      applicable_default_entries: pairs.map((p) => p.default_entry_id),
      attribution_classification: cls,
      evidence: eg ? `${eg.file}: GRANT ${eg.priv} ON ${eg.target} TO ${eg.grantee}`
        : preFenceNull.has(o.ident) ? "pre-fence proacl/relacl NULL(레저 실측) → 내장 acldefault (pg_default_acl 27건과 별개)"
        : (() => { const rv = findExplicitRevoke(o.ident, o.namespace);
            return rv ? `${rv.file}: REVOKE ${rv.priv} ON ${rv.target} FROM ${rv.grantee} — NULL ACL 을 owner-only 로 실체화`
              : pairs.length ? "적용 가능한 default entry 존재하나 CREATE 시점 증거 없음" : null; })(),
    };
  });
  const objTally = {};
  for (const p of perObject) objTally[p.attribution_classification] = (objTally[p.attribution_classification] || 0) + 1;
  for (const [k, v] of Object.entries(objTally).sort((a, b) => b[1] - a[1])) line(k, v);
  const objUnresolved = objTally.UNRESOLVED ?? 0;
  line("객체 단위 unresolved", objUnresolved);

  head("5. BUILTIN_ACLDEFAULT 분리 확인");
  // proacl NULL 에서 전개된 PUBLIC EXECUTE 는 pg_default_acl 27건과 구별한다.
  const builtinObjs = new Set(perObject
    .filter((x) => x.attribution_classification === "BUILTIN_ACLDEFAULT").map((x) => x.ident));
  line("BUILTIN_ACLDEFAULT 로 분류된 객체", builtinObjs.size);
  line("  (pg_default_acl 귀속이 아님)", "PUBLIC EXECUTE 는 내장 기본 ACL 유래");

  const out = {
    document: "DEFAULT_PRIVILEGE_APPLICATION_MATRIX",
    revision: "V2_CORRECTED",
    responds_to: "P-20260721-PASS_B_FORMAL_GAP_AND_TX_A_HOLD_01 §2",
    matrix_denominators: {
      canonical_default_acl_entries: defaults.length,
      created_objects_by_kind: manifest.created_by_kind,
      created_objects_total: created.length,
      compatible_pairs: compatible,
      applicable_pairs: applicable,
      non_applicable_pairs: nonApplicable,
      attribution_unresolved_count: unresolved,
    },
    creator_role: runnerRole,
    creator_evidence_limitation:
      "CREATE 시점 role 은 객체별로 기록되지 않았다. 러너 연결 role 을 기재하며 per-object 증거가 아니다.",
    pre_fence_acl_evidence:
      "CREATE 직후 스냅샷 미봉인. rollback artifact 를 롤백 트랜잭션에서 적용해 재구성한 값이다.",
    attribution_tally_pairs: tally,
    attribution_tally_objects: objTally,
    object_attribution_unresolved_count: objUnresolved,
    per_object_attribution: perObject,
    explicit_migration_grants: explicitGrants,
    explicit_migration_revokes: explicitRevokes,
    taxonomy_extension: {
      added: "EXPLICIT_MIGRATION_REVOKE",
      reason: "NULL 인 relacl/proacl 에 REVOKE 를 걸면 ACL 이 owner-only 로 실체화된다. GPT 분류 6종에 이 경로가 없어 신설했고, 임의로 다른 항목에 뭉개지 않았다.",
    },
    rows,
  };
  const buf = Buffer.from(JSON.stringify(out, null, 2));
  writeFileSync(OUT, buf);

  head("판정");
  console.log(`\nDEFAULT_PRIVILEGE_APPLICATION_MATRIX=V2_COMPLETE`);
  console.log(`COMPATIBLE_PAIRS=${compatible} APPLICABLE=${applicable} NON_APPLICABLE=${nonApplicable}`);
  console.log(`ATTRIBUTION_UNRESOLVED_PAIRS=${unresolved}`);
  console.log(`ATTRIBUTION_UNRESOLVED_OBJECTS=${objUnresolved}`);
  console.log(`OBJECT_ATTRIBUTION=${JSON.stringify(objTally)}`);
  console.log(`SHA256=${createHash("sha256").update(buf).digest("hex")}`);
  console.log(`OUT=${OUT}`);
  return 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
process.exit(code);
