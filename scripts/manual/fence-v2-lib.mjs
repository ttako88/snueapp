// ============================================================
// fence-v2-lib.mjs — FINAL_FENCE_V2 공용 라이브러리
// ============================================================
// GPT 판정 P-20260721-NULL_ACL_RESTORE_DISPOSITION_01 의 보완 7건 + 물질화 최소화 구현.
//
// 이 모듈은 **SQL 을 실행하지 않는다.** 조회와 계산만 한다.
// 실행은 호출부(dev replay / prod runner)가 트랜잭션 안에서 담당한다.
//
// 핵심 설계
//   · CANONICAL_EXPANDED_ACL_VECTOR — NULL ACL 을 acldefault 로 전개한 정규 튜플
//   · EFFECTIVE_PRIVILEGE_VECTOR    — has_*_privilege 기반 실효 권한
//   · MATERIALIZATION_MINIMIZATION  — expanded inventory 에 실제로 존재하는
//                                     (object, grantee, privilege) 에만 REVOKE 발행
//
// 두 벡터를 모두 쓰는 이유: effective 만 보면 grantor·grant option 차이를 놓친다.
// raw ACL 문자열만 보면 NULL→명시배열 물질화 때문에 영구히 불일치한다(복원 불가, 실측 확인).
// ============================================================

// PostgreSQL acldefault() 의 객체 유형 코드
export const ACL_TYPE = { relation: "r", sequence: "s", function: "f", schema: "n" };

// 관리형 스키마 — 프로젝트 소유가 아니므로 분모에서 제외한다
export const MANAGED_SCHEMAS = [
  "pg_catalog", "pg_toast", "information_schema",
  "auth", "storage", "extensions", "graphql", "graphql_public",
  "realtime", "vault", "pgbouncer", "cron", "supabase_migrations",
  "supabase_functions", "net", "pgsodium", "pgsodium_masks",
];

// 회수 대상 권한 (DEFECT_2 판정 반영 — REFERENCES·TRIGGER·MAINTAIN 포함)
export const REVOKE_REL_PRIVS = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"];
export const REVOKE_COL_PRIVS = ["INSERT", "UPDATE", "REFERENCES"];
export const REVOKE_SEQ_PRIVS = ["USAGE", "UPDATE"];
export const TARGET_ROLES = ["anon", "authenticated"];   // PUBLIC 은 grantee oid 0 으로 별도 처리
export const PRESERVE_ROLES = ["service_role"];          // 불변 검증 대상

const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

// ── 보완 7: PG 버전 게이트 ────────────────────────────────────
export async function assertVersion(client, expectMajorMinor = "17.6") {
  const { rows } = await client.query(`select current_setting('server_version') v`);
  const v = rows[0].v;
  const ok = v.startsWith(expectMajorMinor);
  return { ok, actual: v, expected: expectMajorMinor };
}

// ── 보완 2: 프로젝트 소유 스키마 동적 분모 ────────────────────
export async function projectSchemas(client) {
  const { rows } = await client.query(
    `select n.nspname, pg_get_userbyid(n.nspowner) owner
       from pg_namespace n
      where n.nspname <> all($1::text[])
        and n.nspname not like 'pg\\_%'
      order by 1`, [MANAGED_SCHEMAS]);
  return rows.map((r) => ({ schema: r.nspname, owner: r.owner }));
}

// ── 분모 수집 ────────────────────────────────────────────────
/**
 * 대상 객체 전수.
 * relation 은 relkind ∈ r,p,v,m,f (모든 view 포함 — GPT 지시)
 * routine 은 prokind ∈ f,p,a,w, identity 는 oid::regprocedure (overload-safe, 보완 4)
 */
export async function inventory(client, schemas) {
  const inv = { relations: [], sequences: [], routines: [], schemas: [], columns: [] };

  // acl_is_null 을 반드시 함께 뽑는다.
  // 이 값이 없으면 "이번 REVOKE 로 NULL→명시배열이 되는 객체"(필요 물질화)를
  // 식별할 수 없어 materialization receipt 가 비어버린다.
  inv.relations = (await client.query(
    `select c.oid::int oid, n.nspname sch, c.relname, c.relkind,
            pg_get_userbyid(c.relowner) owner, (c.relacl is null) acl_is_null,
            (n.nspname||'.'||quote_ident(c.relname)) ident
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1::text[]) and c.relkind in ('r','p','v','m','f')
      order by 2,3`, [schemas])).rows;

  inv.sequences = (await client.query(
    `select c.oid::int oid, n.nspname sch, c.relname,
            pg_get_userbyid(c.relowner) owner, (c.relacl is null) acl_is_null,
            (n.nspname||'.'||quote_ident(c.relname)) ident
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1::text[]) and c.relkind = 'S'
      order by 2,3`, [schemas])).rows;

  inv.routines = (await client.query(
    `select p.oid::int oid, n.nspname sch, p.proname, p.prokind,
            pg_get_userbyid(p.proowner) owner, (p.proacl is null) acl_is_null,
            p.oid::regprocedure::text ident
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = any($1::text[]) and p.prokind in ('f','p','a','w')
      order by 2,7`, [schemas])).rows;

  inv.schemas = (await client.query(
    `select n.oid::int oid, n.nspname sch, pg_get_userbyid(n.nspowner) owner,
            (n.nspacl is null) acl_is_null, n.nspname ident
       from pg_namespace n where n.nspname = any($1::text[]) order by 1`, [schemas])).rows;

  // 보완 1: 컬럼 단위 ACL (attacl 이 NULL 이 아닌 것만 — NULL 은 테이블 ACL 상속)
  inv.columns = (await client.query(
    `select a.attrelid::int relid, n.nspname sch, c.relname, a.attname,
            (n.nspname||'.'||quote_ident(c.relname)||'.'||quote_ident(a.attname)) ident
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1::text[]) and a.attnum > 0 and not a.attisdropped
        and a.attacl is not null
      order by 2,3,4`, [schemas])).rows;

  return inv;
}

// ── CANONICAL_EXPANDED_ACL_VECTOR ────────────────────────────
/**
 * NULL ACL 을 acldefault(type, owner) 로 전개해 정규 튜플을 만든다.
 * grantee 0 = PUBLIC. grantor·is_grantable 까지 포함해야
 * "effective 는 같은데 grantor 가 다른" 경우를 잡을 수 있다(GPT 요구).
 */
export async function expandedAclVector(client, inv) {
  const out = [];
  const push = (kind, ident, rows) => {
    for (const r of rows) {
      out.push([kind, ident, r.grantor, r.grantee_name, r.privilege_type, r.is_grantable].join("|"));
    }
  };

  const relSql = `
    select pg_get_userbyid(a.grantor) grantor,
           case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end grantee_name,
           a.privilege_type, a.is_grantable
      from pg_class c, aclexplode(coalesce(c.relacl, acldefault($2, c.relowner))) a
     where c.oid = $1`;
  for (const r of inv.relations) push("relation", r.ident, (await client.query(relSql, [r.oid, ACL_TYPE.relation])).rows);
  for (const s of inv.sequences) push("sequence", s.ident, (await client.query(relSql, [s.oid, ACL_TYPE.sequence])).rows);

  for (const f of inv.routines) {
    push("routine", f.ident, (await client.query(`
      select pg_get_userbyid(a.grantor) grantor,
             case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end grantee_name,
             a.privilege_type, a.is_grantable
        from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.oid = $1`, [f.oid])).rows);
  }
  for (const s of inv.schemas) {
    push("schema", s.ident, (await client.query(`
      select pg_get_userbyid(a.grantor) grantor,
             case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end grantee_name,
             a.privilege_type, a.is_grantable
        from pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
       where n.oid = $1`, [s.oid])).rows);
  }
  // 컬럼은 attacl 이 NULL 이 아닌 것만 (NULL 은 기본값이 아니라 "컬럼 고유 grant 없음")
  for (const col of inv.columns) {
    push("column", col.ident, (await client.query(`
      select pg_get_userbyid(a.grantor) grantor,
             case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end grantee_name,
             a.privilege_type, a.is_grantable
        from pg_attribute at, aclexplode(at.attacl) a
       where at.attrelid = $1 and at.attname = $2`, [col.relid, col.attname])).rows);
  }

  out.sort();
  return out;
}

// ── EFFECTIVE_PRIVILEGE_VECTOR ───────────────────────────────
export async function effectiveVector(client, inv, roles = [...TARGET_ROLES, ...PRESERVE_ROLES]) {
  const v = {};
  const one = async (sql, params) => (await client.query(sql, params)).rows[0].x;

  // 예외가 날 수 있는 조회는 반드시 SAVEPOINT 로 감싼다.
  // PostgreSQL 은 쿼리 하나가 실패하면 트랜잭션 전체가 aborted 되므로
  // try/catch 만으로는 복구되지 않는다. 이후 모든 문장이 연쇄 실패한다.
  // (권한명이 버전마다 다른 MAINTAIN 등이 여기에 해당한다)
  let spN = 0;
  const safeOne = async (sql, params, fallback = "UNSUPPORTED") => {
    const sp = `evsp_${++spN}`;
    await client.query(`savepoint ${sp}`);
    try {
      const r = await one(sql, params);
      await client.query(`release savepoint ${sp}`);
      return r;
    } catch {
      await client.query(`rollback to savepoint ${sp}`);
      await client.query(`release savepoint ${sp}`);
      return fallback;
    }
  };

  // ⚠ OID 파라미터에는 반드시 ::oid 캐스트를 붙인다.
  // has_*_privilege 는 (name, text, text) 와 (name, oid, text) 오버로드를 갖는데,
  // node-pg 가 숫자를 텍스트로 보내면 Postgres 가 **text 오버로드(객체 이름)** 로 해석해
  // `relation "27382" does not exist` 로 실패한다.
  for (const role of roles) {
    for (const r of inv.relations) {
      for (const p of [...REVOKE_REL_PRIVS, "SELECT"]) {
        v[`rel|${role}|${r.ident}|${p}`] = await safeOne(`select has_table_privilege($1,$2::oid,$3) x`, [role, r.oid, p]);
      }
    }
    for (const s of inv.sequences) {
      for (const p of [...REVOKE_SEQ_PRIVS, "SELECT"]) {
        v[`seq|${role}|${s.ident}|${p}`] = await safeOne(`select has_sequence_privilege($1,$2::oid,$3) x`, [role, s.oid, p]);
      }
    }
    for (const f of inv.routines) {
      v[`fn|${role}|${f.ident}|EXECUTE`] = await one(`select has_function_privilege($1,$2::oid,'EXECUTE') x`, [role, f.oid]);
    }
    for (const s of inv.schemas) {
      for (const p of ["CREATE", "USAGE"]) {
        v[`sch|${role}|${s.ident}|${p}`] = await one(`select has_schema_privilege($1,$2,$3) x`, [role, s.ident, p]);
      }
    }
    // 보완 1: 컬럼 단위 실효 권한 (relid 도 ::oid 캐스트 필수)
    for (const col of inv.columns) {
      for (const p of REVOKE_COL_PRIVS) {
        v[`col|${role}|${col.ident}|${p}`] =
          await safeOne(`select has_column_privilege($1,$2::oid,$3,$4) x`, [role, col.relid, col.attname, p]);
      }
    }
    // 보완 6: database CREATE
    v[`db|${role}|CREATE`] = await one(`select has_database_privilege($1, current_database(), 'CREATE') x`, [role]);
  }
  return v;
}

// ── 물질화 최소화 REVOKE 생성 ────────────────────────────────
/**
 * expanded inventory 에 **실제로 존재하는** (object, grantee, privilege) 에만 REVOKE 를 만든다.
 *
 * 없는 권한에 REVOKE 를 쏘면 NULL ACL 이 불필요하게 명시배열로 물질화된다.
 * 반대로 NULL ACL 함수의 PUBLIC EXECUTE 는 expanded 에 나타나므로 회수 대상이며,
 * 그 물질화는 **필요한 것**으로 분류해 receipt 에 남긴다.
 */
export function buildFenceSql(expanded, inv) {
  const want = new Set(["PUBLIC", ...TARGET_ROLES]);
  const stmts = [];
  const materialized = [];   // 이번 REVOKE 로 NULL → 명시배열이 되는 객체
  const byObj = new Map();

  for (const row of expanded) {
    const [kind, ident, , grantee, priv] = row.split("|");
    if (!want.has(grantee)) continue;
    const allowed =
      kind === "relation" ? REVOKE_REL_PRIVS :
      kind === "sequence" ? REVOKE_SEQ_PRIVS :
      kind === "routine" ? ["EXECUTE"] :
      kind === "schema" ? ["CREATE"] :
      kind === "column" ? REVOKE_COL_PRIVS : [];
    if (!allowed.includes(priv)) continue;
    const key = `${kind}|${ident}|${grantee}`;
    if (!byObj.has(key)) byObj.set(key, new Set());
    byObj.get(key).add(priv);
  }

  const nullAclIdents = new Set([
    ...inv.routines.filter((r) => r.acl_is_null).map((r) => r.ident),
    ...inv.relations.filter((r) => r.acl_is_null).map((r) => r.ident),
    ...inv.sequences.filter((r) => r.acl_is_null).map((r) => r.ident),
    ...inv.schemas.filter((r) => r.acl_is_null).map((r) => r.ident),
  ]);

  for (const [key, privs] of [...byObj.entries()].sort()) {
    const [kind, ident, grantee] = key.split("|");
    const to = grantee === "PUBLIC" ? "PUBLIC" : q(grantee);
    const list = [...privs].sort().join(", ");
    if (kind === "relation") stmts.push(`revoke ${list} on table ${ident} from ${to};`);
    else if (kind === "sequence") stmts.push(`revoke ${list} on sequence ${ident} from ${to};`);
    else if (kind === "routine") stmts.push(`revoke execute on function ${ident} from ${to};`);
    else if (kind === "schema") stmts.push(`revoke ${list} on schema ${ident} from ${to};`);
    else if (kind === "column") {
      const parts = ident.split(".");
      const col = parts.pop();
      const tbl = parts.join(".");
      for (const p of [...privs].sort()) stmts.push(`revoke ${p} (${col}) on table ${tbl} from ${to};`);
    }
    if (nullAclIdents.has(ident)) materialized.push({ kind, ident, reason: "NULL_ACL_REVOKE_REQUIRED" });
  }
  return { stmts, materialized };
}

/** 이번 fence 가 제거한 grant 만 복원하는 SQL */
export function buildRollbackSql(expanded) {
  const want = new Set(["PUBLIC", ...TARGET_ROLES]);
  const stmts = [];
  for (const row of expanded) {
    const [kind, ident, , grantee, priv, grantable] = row.split("|");
    if (!want.has(grantee)) continue;
    const allowed =
      kind === "relation" ? REVOKE_REL_PRIVS :
      kind === "sequence" ? REVOKE_SEQ_PRIVS :
      kind === "routine" ? ["EXECUTE"] :
      kind === "schema" ? ["CREATE"] :
      kind === "column" ? REVOKE_COL_PRIVS : [];
    if (!allowed.includes(priv)) continue;
    const to = grantee === "PUBLIC" ? "PUBLIC" : q(grantee);
    const opt = grantable === "true" ? " with grant option" : "";
    if (kind === "relation") stmts.push(`grant ${priv} on table ${ident} to ${to}${opt};`);
    else if (kind === "sequence") stmts.push(`grant ${priv} on sequence ${ident} to ${to}${opt};`);
    else if (kind === "routine") stmts.push(`grant execute on function ${ident} to ${to}${opt};`);
    else if (kind === "schema") stmts.push(`grant ${priv} on schema ${ident} to ${to}${opt};`);
    else if (kind === "column") {
      const parts = ident.split("."); const col = parts.pop(); const tbl = parts.join(".");
      stmts.push(`grant ${priv} (${col}) on table ${tbl} to ${to}${opt};`);
    }
  }
  return stmts.sort();
}

// ── raw ACL 스냅샷 (LAYER_A 용 — NULL 여부까지 보존) ──────────
export async function rawAclSnapshot(client, schemas) {
  const { rows } = await client.query(`
    select 'rel'  k, n.nspname||'.'||c.relname ident, c.relacl::text acl, (c.relacl is null) nul
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname = any($1::text[]) and c.relkind in ('r','p','v','m','f','S')
    union all
    select 'proc' k, p.oid::regprocedure::text, p.proacl::text, (p.proacl is null)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname = any($1::text[])
    union all
    select 'nsp'  k, n.nspname, n.nspacl::text, (n.nspacl is null)
      from pg_namespace n where n.nspname = any($1::text[])
    union all
    select 'attr' k, n.nspname||'.'||c.relname||'.'||a.attname, a.attacl::text, (a.attacl is null)
      from pg_attribute a join pg_class c on c.oid=a.attrelid
      join pg_namespace n on n.oid=c.relnamespace
     where n.nspname = any($1::text[]) and a.attnum>0 and not a.attisdropped and a.attacl is not null
    order by 1,2`, [schemas]);
  return rows.map((r) => `${r.k}|${r.ident}|${r.nul ? "NULL" : r.acl}`);
}

/** 두 벡터 비교 — 차이 목록 반환 */
export function diffVectors(a, b) {
  if (Array.isArray(a)) {
    const sa = new Set(a), sb = new Set(b);
    return {
      onlyInA: a.filter((x) => !sb.has(x)),
      onlyInB: b.filter((x) => !sa.has(x)),
    };
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return { changed: [...keys].filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k]} → ${b[k]}`) };
}
