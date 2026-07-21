// ============================================================
// dev-default-priv-matrix.mjs — DEFAULT_PRIVILEGE_APPLICATION_MATRIX
// ============================================================
// GPT Q1 을 (a)안(= 27건 각각이 실제로 어떤 객체에 적용되는지의 교차표)으로
// 이해하고 만든다. 정적 매핑만으로는 "적용될 것이다"라는 추정에 그치므로,
// 롤백되는 트랜잭션 안에서 실제로 임시 객체를 만들어 **생성 직후 ACL 을 관측**해
// 어떤 default 가 실제로 발화하는지 경험적으로 증명한다.
//
// 쓰기처럼 보이지만 전 구간이 단일 트랜잭션이고 반드시 ROLLBACK 으로 끝난다.
// 영구 변경 0.
//
// 실행: node scripts/manual/dev-default-priv-matrix.mjs
// ============================================================
import pg from "pg";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readDevEnv, assertDevUrl, scrub } from "./dev-url.mjs";
import * as L from "./fence-v2-lib.mjs";

const OUT = join(homedir(), "prod-runs", "DEV_PASS_B", "DEFAULT_PRIVILEGE_APPLICATION_MATRIX.json");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(44)} ${v}`);
const OBJTYPE = { r: "relation(table/view)", S: "sequence", f: "routine", T: "type", n: "schema" };

const { DEV_DB_URL: url } = readDevEnv(["DEV_DB_URL"]);
assertDevUrl(url, "DEV_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();
  const q = async (s, p = []) => (await c.query(s, p)).rows;
  const projSchemas = (await L.projectSchemas(c)).map((s) => s.schema);
  const creator = (await q(`select current_user u`))[0].u;

  head("0. 전제");
  line("project schemas", projSchemas.join(", "));
  line("마이그레이션 실행 role (creator)", creator);

  const defaults = await q(`
    select pg_get_userbyid(defaclrole) role,
           coalesce((select nspname from pg_namespace where oid=defaclnamespace),'*ANY*') nsp,
           defaclobjtype ot, defaclacl::text acl
      from pg_default_acl order by 1,2,3`);

  head("1. 정적 적용성 매핑 (27건 × project schema)");
  // default ACL 은 (생성 role = defaclrole) AND (객체 스키마 = defaclnamespace) 일 때 발화한다.
  const matrix = defaults.map((d) => {
    const roleMatch = d.role === creator;
    const schemaMatch = d.nsp === "*ANY*" || projSchemas.includes(d.nsp);
    return {
      default_id: `${d.role}|${d.nsp}|${d.ot}`,
      role: d.role, schema: d.nsp, objtype: d.ot, objtype_label: OBJTYPE[d.ot] ?? d.ot,
      acl: d.acl,
      applies_to_this_deployment: roleMatch && schemaMatch,
      reason: !roleMatch ? `creator(${creator}) ≠ defaclrole(${d.role}) → 발화 안 함`
            : !schemaMatch ? `대상 스키마(${d.nsp})가 project schema 아님 → 발화 안 함`
            : `creator·schema 모두 일치 → 발화`,
      grants_to_anon: /(^|,)anon=/.test(d.acl),
      grants_to_authenticated: /(^|,)authenticated=/.test(d.acl),
    };
  });
  const applying = matrix.filter((m) => m.applies_to_this_deployment);
  line("전체 default 항목", matrix.length);
  line("이번 배포에 실제 발화하는 항목", applying.length);
  for (const m of applying) line(`  발화: ${m.default_id}`, m.acl);
  // project schema 중 default 가 하나도 없는 곳
  const covered = new Set(applying.map((m) => m.schema));
  const uncovered = projSchemas.filter((s) => !covered.has(s));
  line("default 항목이 없는 project schema", uncovered.length ? uncovered.join(", ") : "없음");

  head("2. 경험적 증명 — 임시 객체 생성 후 ACL 관측 (ROLLBACK)");
  const probes = [];
  await c.query("begin");
  await c.query(`set local lock_timeout='10s'`);
  try {
    for (const s of projSchemas) {
      const t = `dpm_probe_t`, sq = `dpm_probe_s`, fn = `dpm_probe_f`;
      await c.query(`create table ${s}.${t}(id int)`);
      await c.query(`create sequence ${s}.${sq}`);
      await c.query(`create function ${s}.${fn}() returns int language sql as 'select 1'`);
      const r = (await q(
        `select (select relacl::text from pg_class where oid=($1||'.'||$2)::regclass) tacl,
                (select relacl::text from pg_class where oid=($1||'.'||$3)::regclass) sacl,
                (select proacl::text from pg_proc  where oid=($1||'.'||$4||'()')::regprocedure) facl`,
        [s, t, sq, fn]))[0];
      for (const [ot, acl] of [["r", r.tacl], ["S", r.sacl], ["f", r.facl]]) {
        probes.push({
          schema: s, objtype: ot, objtype_label: OBJTYPE[ot],
          observed_acl_at_creation: acl ?? "NULL",
          acl_is_null: acl === null,
          anon_granted: acl ? /(^|,|\{)anon=/.test(acl) : "IMPLICIT_DEFAULT",
          authenticated_granted: acl ? /(^|,|\{)authenticated=/.test(acl) : "IMPLICIT_DEFAULT",
        });
      }
      line(`${s} 프로브`, `table=${r.tacl ?? "NULL"} / seq=${r.sacl ?? "NULL"} / func=${r.facl ?? "NULL"}`);
    }
  } finally {
    await c.query("rollback");
    line("프로브 종료", "ROLLBACK — 임시 객체 영구 생성 0");
  }

  head("3. 정적 매핑 ↔ 경험적 관측 교차검증");
  // 두 층으로 본다.
  //  (1) 형태: default 가 있으면 explicit, 없으면 NULL 이어야 한다.
  //  (2) 내용: 관측된 aclitem 집합이 pg_default_acl 에 저장된 값과 같은가.
  //      다르면 저장값만 읽고 posture 를 단언할 수 없다는 뜻이므로 반드시 드러낸다.
  const aclItems = (a) => !a || a === "NULL" ? []
    : a.replace(/^\{|\}$/g, "").split(",").map((s) => s.trim()).filter(Boolean).sort();
  let mismatch = 0, contentDelta = 0;
  for (const p of probes) {
    const expected = applying.find((m) => m.schema === p.schema && m.objtype === p.objtype);
    const ok = expected ? !p.acl_is_null : p.acl_is_null;
    if (!ok) mismatch++;
    p.static_prediction = expected ? "EXPLICIT_ACL_FROM_DEFAULT" : "NULL_ACL_IMPLICIT_DEFAULT";
    p.agrees_with_static_shape = ok;
    if (!ok) line(`  형태 불일치 ${p.schema}/${p.objtype}`, `예측 ${p.static_prediction} vs acl_is_null=${p.acl_is_null}`);

    if (expected) {
      const stored = aclItems(expected.acl), obs = aclItems(p.observed_acl_at_creation);
      const extra = obs.filter((x) => !stored.includes(x));
      const missing = stored.filter((x) => !obs.includes(x));
      p.stored_default_acl = expected.acl;
      p.items_only_in_observed = extra;
      p.items_only_in_stored_default = missing;
      // grantee 가 빈 문자열인 aclitem(`=X/owner`)은 PUBLIC 부여를 뜻한다
      p.public_granted_at_creation = obs.some((x) => /^=/.test(x));
      if (extra.length || missing.length) {
        contentDelta++;
        line(`  내용 차이 ${p.schema}/${p.objtype}`,
          `관측에만 [${extra.join(" ")}] / 저장값에만 [${missing.join(" ")}]`);
      }
    }
  }
  line("형태 불일치", mismatch);
  line("저장 default 와 관측 ACL 의 내용 차이", contentDelta);
  const publicGrant = probes.filter((p) => p.public_granted_at_creation);
  line("생성 시 PUBLIC 이 부여된 객체 유형", publicGrant.length
    ? publicGrant.map((p) => `${p.schema}/${p.objtype}`).join(", ") : "없음");

  head("4. 운영 배포 함의");
  const publicFn = applying.find((m) => m.schema === "public" && m.objtype === "f");
  const impl = [];
  if (publicFn && (publicFn.grants_to_anon || publicFn.grants_to_authenticated)) {
    impl.push(
      "public 스키마에 생성되는 **모든 함수**는 default privilege 로 " +
      "anon·authenticated 에게 EXECUTE 가 자동 부여된다. 즉 운영 reset 후 " +
      "001~009 를 적용하면 public 함수들은 다시 anon·authenticated EXECUTE 를 " +
      "가진 상태로 만들어진다. 4단계에서 운영에 건 ACL fence 는 시점 스냅샷 " +
      "REVOKE 이므로 그 이후 생성되는 객체에는 소급되지 않는다.");
    impl.push(
      "따라서 운영 최종 상태의 함수 실행 권한 posture 는 fence 가 아니라 " +
      "pg_default_acl 과 마이그레이션 본문이 결정한다. 사후검증에서 " +
      "'anon 은 EXECUTE 가 없다'를 무조건 단언하면 안 된다.");
  }
  if (publicGrant.length) {
    impl.push(
      "pg_default_acl 에 저장된 값에는 PUBLIC 항목이 없는데, 실제 생성 직후 ACL 에는 " +
      `PUBLIC 부여(grantee 가 빈 aclitem)가 관측됐다: ${publicGrant.map((p) => `${p.schema}/${p.objtype}`).join(", ")}. ` +
      "즉 pg_default_acl 만 읽어서 '누가 권한을 갖는지'를 단언하면 PUBLIC 을 놓친다. " +
      "권한 판정은 반드시 생성 후 실제 ACL 또는 has_*_privilege 실측으로 해야 한다.");
  }
  if (uncovered.length) {
    impl.push(
      `${uncovered.join("·")} 스키마에는 default privilege 항목이 없어 객체가 ` +
      "acl NULL 로 생성된다. NULL 은 권한 없음이 아니라 **암묵적 기본 ACL**이며, " +
      "함수의 경우 PUBLIC EXECUTE 를 뜻한다. 회수하려면 ACL 실체화가 필요하다 " +
      "(이번 물질화 24건의 근거).");
  }
  for (const s of impl) console.log("  · " + s.replace(/\n/g, "\n    "));

  const out = {
    document: "DEFAULT_PRIVILEGE_APPLICATION_MATRIX",
    interpretation: "Q1_(a) — 27건 각각의 실제 적용 대상 교차표",
    creator_role: creator, project_schemas: projSchemas,
    default_acl_total: matrix.length,
    applying_count: applying.length,
    schemas_without_default_acl: uncovered,
    static_matrix: matrix,
    empirical_probes: probes,
    static_vs_empirical_shape_mismatch: mismatch,
    stored_default_vs_observed_content_delta: contentDelta,
    public_granted_at_creation: publicGrant.map((p) => `${p.schema}/${p.objtype}`),
    production_implications: impl,
    probe_method: "단일 트랜잭션 내 임시 객체 생성 후 ACL 관측, 반드시 ROLLBACK. 영구 변경 0.",
  };
  const buf = Buffer.from(JSON.stringify(out, null, 2));
  writeFileSync(OUT, buf);

  head("판정");
  console.log(`\nDEFAULT_PRIVILEGE_APPLICATION_MATRIX=${mismatch === 0 ? "PASS" : "REVIEW"}`);
  console.log(`APPLYING=${applying.length}/${matrix.length}`);
  console.log(`SHAPE_MISMATCH=${mismatch}`);
  console.log(`STORED_DEFAULT_VS_OBSERVED_CONTENT_DELTA=${contentDelta}`);
  console.log(`PUBLIC_GRANTED_AT_CREATION=${publicGrant.length ? publicGrant.map((p) => `${p.schema}/${p.objtype}`).join(",") : "none"}`);
  console.log(`SHA256=${createHash("sha256").update(buf).digest("hex")}`);
  console.log(`OUT=${OUT}`);
  return mismatch === 0 ? 0 : 3;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
process.exit(code);
