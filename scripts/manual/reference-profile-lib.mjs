// ============================================================
// reference-profile-lib.mjs — 배포 후 상태 프로파일 산출/대조
// ============================================================
// 운영 사후검증(10~12단계)의 기준을 어디서 가져올 것인가의 문제.
// 상수를 손으로 적으면 틀리고, 운영 자기 자신을 기준으로 삼으면 검증이 아니다.
// dev 는 동일한 001~005 파생물 + 동일한 FINAL_FENCE_V2 를 실제로 적용해
// COMMIT 까지 마친 참조 구현이므로, dev 의 fence 후 상태를 프로파일로 뽑아
// 운영과 대조한다.
//
// 주의 — 무엇을 비교하고 무엇을 비교하지 않는가
//   비교한다: 위상(개수), role 별 권한 분포, 물질화 대상 수, default privilege,
//             객체 identity 집합
//   비교하지 않는다: 데이터 행수, 시퀀스 값, auth.users 수 — 환경마다 다르다.
//   OID·xid 도 당연히 비교하지 않는다.
// ============================================================
import { createHash } from "node:crypto";
import * as L from "./fence-v2-lib.mjs";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const ROLES = ["anon", "authenticated", "service_role"];

/** 한 환경의 배포 후 상태를 환경 독립적인 프로파일로 산출한다 (READ-ONLY) */
export async function buildProfile(client, label) {
  const q = async (s, p = []) => (await client.query(s, p)).rows;
  const schemas = (await L.projectSchemas(client)).map((s) => s.schema);
  const inv = await L.inventory(client, schemas);
  L.resetProbeStats();
  const eff = await L.effectiveVector(client, inv);
  const probe = { ...L.probeStats };

  // role × privilege 분포. 개수만이 아니라 어떤 객체인지도 해시로 묶는다.
  const grants = {};
  for (const [k, v] of Object.entries(eff)) {
    if (v !== true) continue;
    const [kind, role, ident, priv] = k.split("|");
    const key = `${role}|${kind}|${priv}`;
    (grants[key] ??= []).push(ident);
  }
  const privilegeMatrix = {};
  for (const [key, idents] of Object.entries(grants))
    privilegeMatrix[key] = { count: idents.length, idents_sha256: sha256(idents.sort().join("\n")) };

  const defaultAcl = await q(`
    select pg_get_userbyid(defaclrole) r,
           coalesce((select nspname from pg_namespace where oid=defaclnamespace),'*GLOBAL*') n,
           defaclobjtype t, defaclacl::text a from pg_default_acl order by 1,2,3,4`);

  const objectIdents = {
    schema: inv.schemas.map((o) => o.ident).sort(),
    relation: inv.relations.map((o) => o.ident).sort(),
    sequence: inv.sequences.map((o) => o.ident).sort(),
    // routine ident 는 regprocedure 라 search_path 에 따라 스키마가 생략된다.
    // 환경 간 비교에는 스키마를 명시적으로 붙여 정규화한다.
    routine: inv.routines.map((o) =>
      o.ident.includes(".") ? o.ident : `${o.sch}.${o.ident}`).sort(),
  };

  return {
    label,
    generated_at_utc: new Date().toISOString(),
    project_schemas: schemas.sort(),
    topology: {
      relation: inv.relations.length, sequence: inv.sequences.length,
      routine: inv.routines.length, schema: inv.schemas.length,
      explicit_column_acl: inv.columns.length,
    },
    acl_is_null_count: [...inv.relations, ...inv.sequences, ...inv.routines, ...inv.schemas]
      .filter((o) => o.acl_is_null).length,
    object_idents: objectIdents,
    object_idents_sha256: sha256(JSON.stringify(objectIdents)),
    privilege_matrix: privilegeMatrix,
    mutation_privilege_count: Object.entries(eff).filter(([k, v]) => {
      if (v !== true) return false;
      const [kind, role, , priv] = k.split("|");
      if (!["anon", "authenticated"].includes(role)) return false;
      return !(priv === "SELECT" || (kind === "sch" && priv === "USAGE"));
    }).length,
    default_privileges: {
      count: defaultAcl.length,
      canonical_sha256: sha256(defaultAcl.map((r) => `${r.r}|${r.n}|${r.t}|${r.a}`).join("\n")),
      entries: defaultAcl.map((r) => ({ role: r.r, schema: r.n, objtype: r.t, acl: r.a })),
    },
    database_privileges: Object.fromEntries(await Promise.resolve((async () => {
      const out = [];
      for (const role of ROLES) {
        const r = (await q(`select has_database_privilege($1, current_database(), 'CREATE') c,
                                   has_database_privilege($1, current_database(), 'CONNECT') n`, [role]))[0];
        out.push([role, `CREATE=${r.c},CONNECT=${r.n}`]);
      }
      return out;
    })())),
    probe_telemetry: {
      attempted: probe.attempted, completed: probe.completed,
      skipped: probe.skipped, errors: probe.errors, unclassified: probe.unclassified,
      by_kind: probe.byKind,
    },
  };
}

/**
 * 두 프로파일을 대조한다. 차이는 전부 나열한다 — 요약만 주면
 * "대체로 같다"는 인상만 남고 무엇이 다른지 알 수 없다.
 */
export function compareProfiles(reference, target) {
  const diffs = [];
  const cmp = (path, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      diffs.push({ path, reference: a, target: b });
  };

  cmp("project_schemas", reference.project_schemas, target.project_schemas);
  for (const k of Object.keys(reference.topology))
    cmp(`topology.${k}`, reference.topology[k], target.topology[k]);
  cmp("acl_is_null_count", reference.acl_is_null_count, target.acl_is_null_count);
  cmp("mutation_privilege_count", reference.mutation_privilege_count, target.mutation_privilege_count);
  cmp("default_privileges.count", reference.default_privileges.count, target.default_privileges.count);
  cmp("default_privileges.canonical_sha256",
    reference.default_privileges.canonical_sha256, target.default_privileges.canonical_sha256);
  cmp("database_privileges", reference.database_privileges, target.database_privileges);

  // 객체 identity 는 집합 차이를 구체적으로 보여준다
  for (const kind of Object.keys(reference.object_idents)) {
    const a = new Set(reference.object_idents[kind]), b = new Set(target.object_idents[kind] ?? []);
    const missing = [...a].filter((x) => !b.has(x));
    const extra = [...b].filter((x) => !a.has(x));
    if (missing.length || extra.length)
      diffs.push({ path: `object_idents.${kind}`, missing, extra });
  }

  // privilege matrix 는 키 합집합으로 돈다. 한쪽에만 있는 키가 진짜 문제다.
  const keys = new Set([...Object.keys(reference.privilege_matrix), ...Object.keys(target.privilege_matrix)]);
  for (const key of keys) {
    const a = reference.privilege_matrix[key], b = target.privilege_matrix[key];
    if (!a) { diffs.push({ path: `privilege_matrix.${key}`, type: "ONLY_IN_TARGET", target: b }); continue; }
    if (!b) { diffs.push({ path: `privilege_matrix.${key}`, type: "ONLY_IN_REFERENCE", reference: a }); continue; }
    if (a.count !== b.count || a.idents_sha256 !== b.idents_sha256)
      diffs.push({ path: `privilege_matrix.${key}`, reference: a, target: b });
  }

  return {
    identical: diffs.length === 0,
    difference_count: diffs.length,
    diffs,
  };
}
