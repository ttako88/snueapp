// ============================================================
// observer-lib.mjs — COMMIT 전 가시성 검사 + fence 직전 raw 봉인
// ============================================================
// GPT P-20260721-PASS_B_FORMAL_GAP_AND_TX_A_HOLD_01 §3·§4 대응으로 신설.
//
// 왜 필요한가
//   1. to_regclass 는 relation·sequence 만 해석한다. dev PASS_B 는 이것만
//      써서 생성 객체 95개 중 38개만 검사했다(routine 55 + schema 2 누락).
//      kind 마다 맞는 lookup 을 쓴다.
//   2. PASS_B 는 fence 직전 RAW ACL 을 봉인하지 않아 롤백 드릴의 raw exact
//      대조가 사후에 불가능해졌다. 운영에서는 fence 직전에 봉인한다.
//
// 이 모듈은 아무것도 쓰지 않는다. 호출자의 트랜잭션 안에서 동작한다.
// ============================================================
import { createHash } from "node:crypto";

/** kind → 그 kind 를 정확히 해석하는 catalog lookup */
export const OBSERVER_LOOKUP = {
  relation: "to_regclass",
  sequence: "to_regclass",
  routine:  "to_regprocedure",
  schema:   "to_regnamespace",
  type:     "to_regtype",
};

const LOOKUP_SQL = {
  to_regclass:     `select to_regclass($1) is not null v`,
  to_regprocedure: `select to_regprocedure($1) is not null v`,
  to_regnamespace: `select to_regnamespace($1) is not null v`,
  to_regtype:      `select to_regtype($1) is not null v`,
};

/**
 * 트랜잭션 안에서 생성된 객체 매니페스트를 kind 별로 산출한다.
 * 분모를 상수로 박지 않는다 — 매 실행마다 실제 카탈로그에서 센다.
 * baselineIdents 는 "kind|ident" 문자열 Set.
 */
export async function createdManifest(client, schemas, baselineIdents = new Set()) {
  const q = async (s, p = []) => (await client.query(s, p)).rows;
  const out = [];
  const push = (kind, rows) => {
    for (const r of rows) if (!baselineIdents.has(`${kind}|${r.ident}`))
      out.push({ kind, ident: r.ident, namespace: r.sch, owner: r.owner });
  };
  push("schema", await q(
    `select n.nspname sch, n.nspname ident, pg_get_userbyid(n.nspowner) owner
       from pg_namespace n where n.nspname = any($1::text[]) order by 1`, [schemas]));
  push("relation", await q(
    `select n.nspname sch, n.nspname||'.'||quote_ident(c.relname) ident,
            pg_get_userbyid(c.relowner) owner
       from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname = any($1::text[]) and c.relkind in ('r','p','v','m','f')
      order by 1,2`, [schemas]));
  push("sequence", await q(
    `select n.nspname sch, n.nspname||'.'||quote_ident(c.relname) ident,
            pg_get_userbyid(c.relowner) owner
       from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname = any($1::text[]) and c.relkind='S' order by 1,2`, [schemas]));
  push("routine", await q(
    `select n.nspname sch, p.oid::regprocedure::text ident,
            pg_get_userbyid(p.proowner) owner
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname = any($1::text[]) and p.prokind in ('f','p','a','w')
      order by 1,2`, [schemas]));
  push("type", await q(
    `select n.nspname sch, n.nspname||'.'||t.typname ident,
            pg_get_userbyid(t.typowner) owner
       from pg_type t join pg_namespace n on n.oid=t.typnamespace
      where n.nspname = any($1::text[]) and t.typtype in ('e','d','r')
      order by 1,2`, [schemas]));

  const byKind = {};
  for (const o of out) byKind[o.kind] = (byKind[o.kind] || 0) + 1;
  return { objects: out, byKind, total: out.length };
}

/**
 * observer(별도 연결)에서 매니페스트 전체의 가시성을 센다.
 * COMMIT 전에는 0 이어야 한다. 0 이 아니면 호출자가 COMMIT 을 막아야 한다.
 * 해석 불가능한 kind 가 있으면 unresolvable 로 세어 조용히 넘어가지 않는다.
 */
export async function observerVisibility(observer, manifest) {
  let visible = 0, checked = 0, unresolvable = 0;
  const visibleList = [], unresolvableList = [];
  for (const o of manifest.objects) {
    const fn = OBSERVER_LOOKUP[o.kind];
    if (!fn) { unresolvable++; unresolvableList.push(o.ident); continue; }
    checked++;
    let v = false;
    try { v = (await observer.query(LOOKUP_SQL[fn], [o.ident])).rows[0].v; }
    catch { unresolvable++; unresolvableList.push(o.ident); checked--; continue; }
    if (v) { visible++; visibleList.push(`${o.kind}:${o.ident}`); }
  }
  return {
    denominator: manifest.total, checked, visible, unresolvable,
    visibleList: visibleList.slice(0, 20), unresolvableList: unresolvableList.slice(0, 20),
    // COMMIT 허용 조건: 전수 검사됐고 하나도 보이지 않는다
    commitAllowed: visible === 0 && unresolvable === 0 && checked === manifest.total,
  };
}

/**
 * fence 적용 **직전** RAW ACL 을 봉인한다.
 * dev PASS_B 는 이걸 안 해서 롤백 드릴의 raw exact 대조가
 * 사후에 불가능해졌다. 같은 한계를 운영에서 반복하지 않는다.
 * NULL 여부와 aclitem 배열 순서를 모두 원문 그대로 보존한다.
 */
export async function sealPreFenceRaw(client, schemas) {
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
     where n.nspname = any($1::text[]) and a.attnum>0 and not a.attisdropped
       and a.attacl is not null
    order by 1,2`, [schemas]);
  // 순서 정보를 잃지 않기 위해 acl 원문을 그대로 담는다.
  const entries = rows.map((r) => ({ kind: r.k, ident: r.ident, acl_is_null: r.nul, acl_raw: r.acl }));
  const canonical = entries.map((e) => `${e.kind}|${e.ident}|${e.acl_is_null ? "NULL" : e.acl_raw}`);
  return {
    sealed_at: new Date().toISOString(),
    entry_count: entries.length,
    null_acl_count: entries.filter((e) => e.acl_is_null).length,
    sha256: createHash("sha256").update(canonical.join("\n")).digest("hex"),
    entries,
  };
}

/**
 * 봉인된 pre-fence raw 와 현재 raw 를 exact 대조한다.
 * 순서 차이도 잡아낸다 — acl 원문을 그대로 비교하기 때문이다.
 */
export function compareRawToSeal(seal, currentEntries) {
  const s = new Map(seal.entries.map((e) => [`${e.kind}|${e.ident}`, e]));
  const c = new Map(currentEntries.map((e) => [`${e.kind}|${e.ident}`, e]));
  const diffs = [];
  let orderOnly = 0;
  const norm = (a) => !a ? [] : a.replace(/^\{|\}$/g, "").split(",").map((x) => x.trim()).filter(Boolean);
  for (const key of new Set([...s.keys(), ...c.keys()])) {
    const a = s.get(key), b = c.get(key);
    if (!a) { diffs.push({ key, type: "ONLY_IN_CURRENT", current: b.acl_raw }); continue; }
    if (!b) { diffs.push({ key, type: "ONLY_IN_SEAL", sealed: a.acl_raw }); continue; }
    if (a.acl_is_null !== b.acl_is_null) {
      diffs.push({ key, type: "NULLNESS_DIFF", sealed: a.acl_is_null, current: b.acl_is_null }); continue;
    }
    if (a.acl_raw === b.acl_raw) continue;
    const sa = norm(a.acl_raw), sb = norm(b.acl_raw);
    if (sa.length === sb.length && [...sa].sort().join() === [...sb].sort().join()) {
      orderOnly++;
      diffs.push({ key, type: "ORDER_ONLY", sealed: a.acl_raw, current: b.acl_raw });
    } else diffs.push({ key, type: "CONTENT_DIFF", sealed: a.acl_raw, current: b.acl_raw });
  }
  return {
    exact: diffs.length === 0,
    order_only_difference_count: orderOnly,
    content_difference_count: diffs.filter((d) => d.type === "CONTENT_DIFF").length,
    nullness_difference_count: diffs.filter((d) => d.type === "NULLNESS_DIFF").length,
    diffs,
  };
}
