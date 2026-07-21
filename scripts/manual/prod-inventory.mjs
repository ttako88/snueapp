// ============================================================
// prod-inventory.mjs — 운영 DB 읽기 전용 인벤토리 (v2)
// ============================================================
// 파괴적 작업 전에 "지금 운영에 뭐가 들어 있는지"를 사실로 확정한다.
//
// v1 대비 수정 (GPT 검수 지적 반영):
//   [1] **트랜잭션 abort 결함** — Postgres는 쿼리 하나가 실패하면 트랜잭션
//       전체가 aborted 상태가 된다. v1의 try/catch는 이걸 복구하지 못해서
//       "테이블 없음"을 만난 순간 이후 모든 조회가 연쇄 실패했다.
//       → to_regclass()로 존재를 먼저 확인하고, 예외 가능 조회는 SAVEPOINT를
//         잡은 뒤 실패 시 ROLLBACK TO SAVEPOINT로 복구한다.
//       → "조회 오류"와 "테이블 없음"을 구분해서 보고한다.
//   [2] READ COMMITTED라 조회 사이에 상태가 달라질 수 있었다.
//       → REPEATABLE READ READ ONLY로 열고 실제로 그렇게 열렸는지 실측한다.
//       → lock_timeout 5s / statement_timeout 120s.
//   [3] batch_runs·maintenance_leases·실행중 Cron·reset 사전차단 객체 검사 추가.
//
// 안전 경계:
//   · SELECT / SHOW / SET LOCAL / SAVEPOINT / ROLLBACK 만 실행한다.
//   · 앱 RPC·Storage API·Auth Admin API를 호출하지 않는다.
//   · URL·비밀번호·이메일·UUID·학번·본문·파일경로 원문을 출력하지 않는다.
//     식별자 집합은 메모리에서 SHA-256으로만 환원한다.
//
// allowlist는 하드코딩하지 않고 prod-reset-community.sql에서 파싱한다.
// reset이 지울 대상과 인벤토리가 세는 대상이 갈라지면 안 되기 때문이다(A-R3).
//
// 종료 코드: 0 = PASS, 3 = BLOCKED(사람 판단 필요), 1 = 실행 실패
// ============================================================
import pg from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { readProdEnv, assertProdUrl, PROD_REF, refOf, scrub } from "./prod-url.mjs";

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
if (!url) { console.error("[중단] PROD_DB_URL 없음"); process.exit(1); }
assertProdUrl(url, "PROD_DB_URL");

// ── allowlist 파싱 (단일 근원: prod-reset-community.sql) ──────────────
const RESET_SQL_RAW = readFileSync(resolve(process.cwd(), "scripts/manual/prod-reset-community.sql"), "utf8");

// **INSERT 블록만** 파싱한다. 스크립트 뒷부분의 사전검사 SQL에는
// `where kind in ('private_table','test_table')` 같은 조건절이 있어서,
// 파일 전체를 정규식으로 긁으면 그 조건절까지 allowlist 항목으로 오인한다.
// (실제로 private가 18종이 아니라 22종으로 집계되는 버그를 --dry-parse 로 잡았다.)
const RESET_SQL = [...RESET_SQL_RAW.matchAll(/insert\s+into\s+_reset_allowlist[\s\S]*?;/gi)]
  .map((m) => m[0]).join("\n");
if (!RESET_SQL) { console.error("[중단] prod-reset-community.sql 에서 allowlist INSERT를 찾지 못함"); process.exit(1); }

const pick = (kind) => [...RESET_SQL.matchAll(new RegExp(`\\('${kind}','([^']+)'`, "g"))].map((m) => m[1]);
const ALLOW = {
  publicTables: pick("public_table"),
  privateTables: pick("private_table"),
  testTables: pick("test_table"),
  cronJobs: pick("cron_job"),
  // public_function 은 ('public_function','<signature>','<name>',...) 형태라 2번째가 시그니처
  publicFunctionSigs: [...RESET_SQL.matchAll(/\('public_function','([^']+)','([^']+)'/g)].map((m) => m[1]),
  publicFunctionNames: [...new Set([...RESET_SQL.matchAll(/\('public_function','[^']+','([^']+)'/g)].map((m) => m[1]))],
};

// 서버 Cron(Vercel)과 DB Cron(pg_cron) 양쪽의 허용 job 이름
const ALLOWED_BATCH_JOBS = new Set([
  ...ALLOW.cronJobs,                                     // DB Cron 4종
  "stale-reviews", "expire-uploads", "purge-verification-docs", "delete-accounts", // 서버 Cron 4종
]);

// reset을 막아야 하는 테스트 흔적 (운영에서는 전부 0이어야 함)
const TEST_ARTIFACT_FUNCS = [
  "private._assert(text,text,text,boolean,text)",
  "private._assert_ok(text,text,text)",
  "private._assert_raises(text,text,text)",
  "authz._log(text,text,boolean,text)",
];

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// --dry-parse: DB에 접속하지 않고 allowlist 파싱 결과만 확인한다.
// 운영에 붙기 전에 "reset이 지울 대상"과 "인벤토리가 셀 대상"이 일치하는지 눈으로 본다.
if (process.argv.includes("--dry-parse")) {
  console.log("allowlist 파싱 결과 (prod-reset-community.sql 기준, DB 무접속)\n");
  console.log(`  public 테이블   ${ALLOW.publicTables.length}종: ${ALLOW.publicTables.join(", ")}`);
  console.log(`  private 테이블  ${ALLOW.privateTables.length}종: ${ALLOW.privateTables.join(", ")}`);
  console.log(`  test 테이블     ${ALLOW.testTables.length}종: ${ALLOW.testTables.join(", ")}`);
  console.log(`  cron job        ${ALLOW.cronJobs.length}종: ${ALLOW.cronJobs.join(", ")}`);
  console.log(`  public 함수     ${ALLOW.publicFunctionSigs.length}개 시그니처 / ${ALLOW.publicFunctionNames.length}개 이름`);
  console.log(`  batch job 허용  ${ALLOWED_BATCH_JOBS.size}종: ${[...ALLOWED_BATCH_JOBS].join(", ")}`);
  console.log(`\n  기대값: public 9 · private 18 · test 1 · cron 4 · 함수 46`);
  const ok = ALLOW.publicTables.length === 9 && ALLOW.privateTables.length === 18
    && ALLOW.testTables.length === 1 && ALLOW.cronJobs.length === 4
    && ALLOW.publicFunctionSigs.length === 46;
  console.log(`  ${ok ? "✅ 전부 일치" : "⛔ 불일치 — 파서 수정 필요"}`);
  process.exit(ok ? 0 : 1);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

// ── 판정 수집 ────────────────────────────────────────────────────────
const findings = [];      // BLOCKED 사유
const errors = [];        // 조회 실패 (테이블 없음과 구분)
let sp = 0;

const line = (k, v) => console.log(`  ${String(k).padEnd(38)} ${v}`);
const head = (t) => console.log(`\n=== ${t} ===`);
const block = (why) => { findings.push(why); console.log(`  ⛔ BLOCKED: ${why}`); };

/**
 * 예외가 날 수 있는 조회. SAVEPOINT로 감싸서 실패해도 트랜잭션을 살린다.
 * 반환: { ok:true, rows } | { ok:false, code, message }
 */
async function q(sql, params = []) {
  const name = `sp_${++sp}`;
  await client.query(`savepoint ${name}`);
  try {
    const r = await client.query(sql, params);
    await client.query(`release savepoint ${name}`);
    return { ok: true, rows: r.rows };
  } catch (e) {
    await client.query(`rollback to savepoint ${name}`);
    return { ok: false, code: e.code, message: scrub(e.message, url) };
  }
}

/** 릴레이션 존재 확인 — 없으면 조회 자체를 시도하지 않는다 */
async function relExists(qualified) {
  const r = await q(`select to_regclass($1) is not null as e`, [qualified]);
  if (!r.ok) { errors.push(`to_regclass(${qualified}): ${r.code}`); return null; }
  return r.rows[0].e;
}

/** 존재하면 행 수, 없으면 null, 조회 실패면 "ERR" */
async function countOf(qualified) {
  const e = await relExists(qualified);
  if (e === null) return "ERR";
  if (!e) return null;
  const r = await q(`select count(*)::bigint n from ${qualified}`);
  if (!r.ok) { errors.push(`count(${qualified}): ${r.code}`); return "ERR"; }
  return Number(r.rows[0].n);
}

// ── 본체 ─────────────────────────────────────────────────────────────
async function main() {
  await client.connect();

  // [2] 스냅샷 일관성 + 타임아웃. read only 는 DB가 강제한다.
  await client.query("begin transaction isolation level repeatable read read only");
  await client.query("set local lock_timeout = '5s'");
  await client.query("set local statement_timeout = '120s'");

  try {
    // ── 1. 접속·스냅샷 ────────────────────────────────────────────
    head("1. 접속·스냅샷");
    const who = (await q(`select current_database() db, current_user usr,
                                 current_setting('server_version') ver,
                                 current_setting('TimeZone') tz,
                                 current_setting('transaction_read_only') ro,
                                 current_setting('transaction_isolation') iso,
                                 pg_current_snapshot()::text snap,
                                 now() at time zone 'utc' utc`)).rows[0];
    line("database", who.db);
    line("user", who.usr);
    line("PostgreSQL", who.ver);
    line("server timezone", who.tz);
    line("transaction_read_only", `${who.ro} ${who.ro === "on" ? "✅" : "⛔"}`);
    line("transaction_isolation", `${who.iso} ${who.iso === "repeatable read" ? "✅" : "⛔"}`);
    line("snapshot (UTC)", who.utc.toISOString ? who.utc.toISOString() : String(who.utc));
    line("pg_current_snapshot", who.snap);
    line("project ref", refOf(url) === PROD_REF ? `${PROD_REF} ✅ 운영` : "⛔ 불일치");

    if (who.ro !== "on") block("transaction_read_only 가 on 이 아님");
    if (who.iso !== "repeatable read") block("격리수준이 repeatable read 가 아님");
    if (refOf(url) !== PROD_REF) block("운영 ref 불일치");

    // ── 2. 객체·스키마 ────────────────────────────────────────────
    head("2. 스키마·소유자");
    for (const s of (await q(`select n.nspname, pg_get_userbyid(n.nspowner) owner
                                from pg_namespace n
                               where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
                               order by 1`)).rows) {
      line(s.nspname, `owner=${s.owner}`);
    }

    head("2-1. public / private / authz 릴레이션");
    const rels = (await q(`select n.nspname sch, c.relname rel, c.relkind kind,
                                  c.relrowsecurity rls, c.relforcerowsecurity frls,
                                  (select count(*) from pg_policy p where p.polrelid = c.oid)::int pols,
                                  (select count(*) from pg_trigger t
                                    where t.tgrelid = c.oid and not t.tgisinternal)::int trg
                             from pg_class c join pg_namespace n on n.oid = c.relnamespace
                            where n.nspname in ('public','private','authz')
                              and c.relkind in ('r','v','m','S','f')
                            order by 1, 3, 2`)).rows;
    if (!rels.length) line("(없음)", "");
    for (const r of rels) {
      // 주의: SELECT 별칭이 kind 다. r.relkind 로 읽으면 전부 undefined 가 되어
      //       RLS·정책·트리거 정보가 통째로 사라진다(실제로 1회차에 그랬다).
      const k = { r: "table", v: "view", m: "matview", S: "sequence", f: "foreign" }[r.kind] ?? r.kind;
      const extra = r.kind === "r"
        ? `RLS ${r.rls ? "ON" : "OFF"}${r.frls ? "/FORCE" : ""} · 정책 ${r.pols} · 트리거 ${r.trg}`
        : "";
      line(`${r.sch}.${r.rel} [${k}]`, extra);
    }

    head("2-2. 함수 (identity signature 기준)");
    const fns = (await q(`select n.nspname sch, p.oid::regprocedure::text sig
                            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname in ('public','private','authz')
                           order by 1, 2`)).rows;
    line("함수 총 개수", fns.length);
    for (const s of ["public", "private", "authz"]) {
      line(`  ${s}`, fns.filter((f) => f.sch === s).length);
    }

    head("2-3. auth.users 의 비내부 트리거");
    const at = await q(`select t.tgname from pg_trigger t
                         where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal
                         order by 1`);
    if (!at.ok) { line("조회 실패", at.code); errors.push(`auth.users triggers: ${at.code}`); }
    else if (!at.rows.length) line("트리거", "0개");
    else for (const t of at.rows) line("트리거", t.tgname);

    head("2-4. realtime publication 등록");
    const pub = await q(`select p.pubname, count(pr.prrelid)::int n
                           from pg_publication p
                           left join pg_publication_rel pr on pr.prpubid = p.oid
                          group by 1 order by 1`);
    if (!pub.ok) line("조회 실패", pub.code);
    else if (!pub.rows.length) line("publication", "없음");
    else for (const p of pub.rows) line(p.pubname, `${p.n}개 릴레이션`);

    head("2-5. supabase_migrations.schema_migrations");
    const smExists = await relExists("supabase_migrations.schema_migrations");
    if (!smExists) line("상태", "테이블 없음 (Supabase CLI 미사용)");
    else {
      const sm = await q(`select version from supabase_migrations.schema_migrations order by version`);
      if (!sm.ok) line("조회 실패", sm.code);
      else { line("적용 항목 수", sm.rows.length); for (const r of sm.rows) line("  version", r.version); }
    }

    head("2-6. 확장");
    for (const e of (await q(`select e.extname, e.extversion, n.nspname sch
                                from pg_extension e join pg_namespace n on n.oid = e.extnamespace
                               order by 1`)).rows) {
      line(e.extname, `v${e.extversion} @ ${e.sch}`);
    }

    head("2-7. public.rls_auto_enable (001~009 산출물 아님 — 삭제 금지 대상)");
    const rae = (await q(`select p.oid::regprocedure::text sig, pg_get_userbyid(p.proowner) owner
                            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'public' and p.proname = 'rls_auto_enable'`)).rows;
    line("개수", rae.length);
    for (const r of rae) line("  " + r.sig, `owner=${r.owner}`);

    // ── 3. 데이터 규모 ────────────────────────────────────────────
    head("3. reset allowlist 대상 행 수 (개인정보 미출력)");
    console.log(`  [public ${ALLOW.publicTables.length}종]`);
    const counts = {};
    for (const t of ALLOW.publicTables) {
      const n = await countOf(`public.${t}`);
      counts[`public.${t}`] = n;
      line(`  public.${t}`, n === null ? "없음" : n === "ERR" ? "조회실패" : `${n}행`);
    }
    console.log(`  [private ${ALLOW.privateTables.length}종]`);
    for (const t of ALLOW.privateTables) {
      const n = await countOf(`private.${t}`);
      counts[`private.${t}`] = n;
      line(`  private.${t}`, n === null ? "없음" : n === "ERR" ? "조회실패" : `${n}행`);
    }

    head("3-1. auth / storage");
    for (const t of ["auth.users", "auth.identities", "storage.buckets", "storage.objects"]) {
      const n = await countOf(t);
      counts[t] = n;
      line(t, n === null ? "없음" : n === "ERR" ? "조회실패" : `${n}행`);
    }

    head("3-2. 비allowlist public 릴레이션 (추정 행 수·크기)");
    const known = new Set(ALLOW.publicTables);
    const others = (await q(`select c.relname, coalesce(s.n_live_tup,0)::bigint est,
                                    pg_total_relation_size(c.oid) bytes
                               from pg_class c join pg_namespace n on n.oid = c.relnamespace
                               left join pg_stat_user_tables s on s.relid = c.oid
                              where n.nspname = 'public' and c.relkind = 'r'
                              order by 1`)).rows.filter((r) => !known.has(r.relname));
    if (!others.length) line("(없음)", "");
    for (const o of others) line(`  public.${o.relname}`, `약 ${o.est}행 · ${Math.round(Number(o.bytes) / 1024)}KB`);

    head("3-3. 전체 크기");
    const sz = (await q(`select pg_database_size(current_database()) db,
                                coalesce(sum(pg_total_relation_size(c.oid)),0) app
                           from pg_class c join pg_namespace n on n.oid = c.relnamespace
                          where n.nspname in ('public','private','authz') and c.relkind = 'r'`)).rows[0];
    line("데이터베이스 전체", `${(Number(sz.db) / 1048576).toFixed(1)} MB`);
    line("앱 스키마 테이블 합계", `${(Number(sz.app) / 1048576).toFixed(1)} MB`);

    // ── 4. reset 사전차단 항목 ────────────────────────────────────
    head("4. reset 사전차단 검사 (전부 0이어야 정상)");

    for (const t of ALLOW.testTables) {
      const n = await countOf(`private.${t}`);
      line(`private.${t}`, n === null ? "없음 ✅" : `존재 (${n}행) ⛔`);
      if (n !== null && n !== "ERR") block(`테스트 테이블 private.${t} 존재`);
    }

    const tf = await q(`select p.oid::regprocedure::text sig
                          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname in ('private','authz')
                           and p.proname in ('_assert','_assert_ok','_assert_raises','_log')
                         order by 1`);
    line("테스트 함수(_assert*/_log)", tf.ok ? (tf.rows.length ? `${tf.rows.length}개 ⛔` : "0개 ✅") : "조회실패");
    if (tf.ok) for (const r of tf.rows) { line("  " + r.sig, "⛔"); block(`테스트 함수 존재: ${r.sig}`); }

    // public allowlist 함수와 동명인 비allowlist overload
    //
    // 문자열 비교로 하면 안 된다. allowlist는 'public.enforce_snue_email()' 처럼
    // 스키마를 붙여 적었는데, regprocedure 는 search_path 에 있는 스키마를 생략해
    // 'enforce_snue_email()' 로 돌려준다. 1회차에서 정상 함수 7개가 전부 위반으로
    // 잡히는 오탐이 났다.
    // → prod-reset-community.sql 이 쓰는 방식과 동일하게 **to_regprocedure 로 OID를
    //   해석해서 비교**한다. 표기 차이에 영향받지 않는다.
    const ovlQ = await q(
      `select p.oid::regprocedure::text sig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1)
          and p.oid not in (select to_regprocedure(s)::oid
                              from unnest($2::text[]) s
                             where to_regprocedure(s) is not null)
        order by 1`,
      [ALLOW.publicFunctionNames, ALLOW.publicFunctionSigs]);
    if (!ovlQ.ok) { line("동명 overload 조회 실패", ovlQ.code); errors.push(`overload: ${ovlQ.code}`); }
    else {
      line("동명 비allowlist overload", ovlQ.rows.length ? `${ovlQ.rows.length}개 ⛔` : "0개 ✅");
      for (const r of ovlQ.rows) { line("  " + r.sig, "⛔"); block(`비allowlist overload: ${r.sig}`); }
    }

    // allowlist 시그니처 중 운영에 실제로 존재하는 개수도 함께 본다
    // (reset 이 지울 대상이 실제로 몇 개인지 = 사후검증 기준선)
    const presentQ = await q(
      `select count(*)::int n from unnest($1::text[]) s where to_regprocedure(s) is not null`,
      [ALLOW.publicFunctionSigs]);
    if (presentQ.ok) line("allowlist 함수 중 실존", `${presentQ.rows[0].n} / ${ALLOW.publicFunctionSigs.length}`);

    // private/authz 의 비allowlist relation
    const privKnown = new Set([...ALLOW.privateTables, ...ALLOW.testTables]);
    const extraRels = rels.filter((r) => (r.sch === "private" && !privKnown.has(r.rel)) || r.sch === "authz");
    line("private/authz 비allowlist 릴레이션", extraRels.length ? `${extraRels.length}개` : "0개 ✅");
    for (const r of extraRels) line(`  ${r.sch}.${r.rel}`, `[${r.relkind}] — 확인 필요`);
    if (extraRels.length) block(`private/authz 예상 밖 릴레이션 ${extraRels.length}개`);

    // private/authz 에 설치된 extension
    const pex = (await q(`select e.extname, n.nspname sch from pg_extension e
                            join pg_namespace n on n.oid = e.extnamespace
                           where n.nspname in ('private','authz')`)).rows;
    line("private/authz 내 extension", pex.length ? `${pex.length}개 ⛔` : "0개 ✅");
    for (const e of pex) { line(`  ${e.sch}.${e.extname}`, "⛔"); block(`private/authz extension: ${e.extname}`); }

    // 앱 객체를 참조하는 예상 밖 외부 dependency
    const dep = await q(`select distinct dn.nspname ext_sch, dc.relname ext_rel
                           from pg_depend d
                           join pg_class rc on rc.oid = d.refobjid
                           join pg_namespace rn on rn.oid = rc.relnamespace
                           join pg_class dc on dc.oid = d.objid
                           join pg_namespace dn on dn.oid = dc.relnamespace
                          where rn.nspname in ('private','authz')
                            and dn.nspname not in ('private','authz','pg_catalog','pg_toast')
                            and d.deptype in ('n','a')
                          order by 1,2`);
    line("앱 객체 참조 외부 dependency", dep.ok ? (dep.rows.length ? `${dep.rows.length}개 ⛔` : "0개 ✅") : "조회실패");
    if (dep.ok) for (const d of dep.rows) { line(`  ${d.ext_sch}.${d.ext_rel}`, "⛔"); block(`외부 dependency: ${d.ext_sch}.${d.ext_rel}`); }

    // 독립·비소유 sequence
    const seq = (await q(`select n.nspname sch, c.relname
                            from pg_class c join pg_namespace n on n.oid = c.relnamespace
                           where c.relkind = 'S' and n.nspname in ('public','private','authz')
                             and not exists (select 1 from pg_depend d
                                              where d.objid = c.oid and d.deptype in ('a','i'))
                           order by 1,2`)).rows;
    line("독립(비소유) sequence", seq.length ? `${seq.length}개` : "0개 ✅");
    for (const s of seq) line(`  ${s.sch}.${s.relname}`, "확인 필요");

    // ── 5. batch_runs ─────────────────────────────────────────────
    head("5. private.batch_runs");
    let batchState = "NOT_PRESENT_PRE_MIGRATION";
    if (!(await relExists("private.batch_runs"))) {
      line("상태", "테이블 없음 → NOT_PRESENT_PRE_MIGRATION (정상, 001~009 미적용)");
    } else {
      const br = await q(`select job_name, last_run_at, last_success_at,
                                 last_processed, fail_streak, (last_error is not null) has_err,
                                 coalesce(last_error,'') err
                            from private.batch_runs order by job_name`);
      if (!br.ok) { line("조회 실패", br.code); errors.push(`batch_runs: ${br.code}`); batchState = "ERR"; }
      else {
        line("전체 행 수", br.rows.length);
        const norm = [];
        for (const r of br.rows) {
          const unknown = !ALLOWED_BATCH_JOBS.has(r.job_name);
          line(`  ${r.job_name}${unknown ? " ⛔UNKNOWN_BATCH_JOB" : ""}`,
            `run=${r.last_run_at ? "있음" : "없음"} · ok=${r.last_success_at ? "있음" : "없음"} · ` +
            `processed=${r.last_processed} · fail_streak=${r.fail_streak} · ` +
            `error=${r.has_err ? sha256(r.err).slice(0, 16) + "…" : "null"}`);
          if (unknown) block(`UNKNOWN_BATCH_JOB: ${r.job_name}`);
          norm.push([r.job_name, r.last_run_at, r.last_success_at, r.last_processed,
                     r.fail_streak, r.has_err ? sha256(r.err) : null].join("|"));
        }
        batchState = `PRESENT:${sha256(norm.join("\n")).slice(0, 32)}`;
        line("결과 digest", batchState);
      }
    }

    // ── 6. maintenance_leases ─────────────────────────────────────
    head("6. private.maintenance_leases");
    let leaseState = "TABLE_NOT_PRESENT";
    if (!(await relExists("private.maintenance_leases"))) {
      line("상태", "테이블 없음 → NOT_PRESENT_PRE_MIGRATION (정상)");
    } else {
      const readLease = () => q(`select job, started_at, leased_until,
                                        (token is not null) has_token,
                                        (token is not null and leased_until > clock_timestamp()) active
                                   from private.maintenance_leases order by job`);
      let lr = await readLease();
      if (!lr.ok) { line("조회 실패", lr.code); errors.push(`leases: ${lr.code}`); leaseState = "ERR"; }
      else {
        let active = lr.rows.filter((r) => r.active);
        // 활성 lease가 있으면 TTL(120s)+30s 까지 기다렸다 한 번 재조회한다.
        // 단 REPEATABLE READ 스냅샷은 갱신되지 않으므로 새 스냅샷이 필요하다 →
        // 여기서는 대기만 하고, 여전히 있으면 BLOCKED로 사람 판단에 넘긴다.
        if (active.length) {
          line("활성 lease", `${active.length}건 — TTL 만료 대기 후 재확인`);
          await new Promise((r) => setTimeout(r, 150_000));
          // 새 스냅샷을 얻기 위해 읽기전용 트랜잭션을 재시작한다 (쓰기 아님)
          await client.query("commit");
          await client.query("begin transaction isolation level repeatable read read only");
          await client.query("set local lock_timeout = '5s'");
          await client.query("set local statement_timeout = '120s'");
          lr = await readLease();
          active = lr.ok ? lr.rows.filter((r) => r.active) : active;
        }
        line("전체 lease 행 수", lr.rows.length);
        for (const r of lr.rows) {
          const bad = r.has_token !== (r.leased_until !== null);
          const unknown = !ALLOWED_BATCH_JOBS.has(r.job);
          line(`  ${r.job}${unknown ? " ⛔UNKNOWN" : ""}${bad ? " ⛔비정상행" : ""}`,
            `started=${r.started_at ? "있음" : "없음"} · until=${r.leased_until ? "있음" : "없음"} · ` +
            `${r.active ? "활성 ⛔" : "비활성"}`);
          if (unknown) block(`알 수 없는 lease job: ${r.job}`);
          if (bad) block(`lease 비정상 행 (token/leased_until 불일치): ${r.job}`);
        }
        const expiredUnreleased = lr.rows.filter((r) => r.has_token && !r.active).length;
        line("만료 미해제 lease", expiredUnreleased);
        leaseState = String(active.length);
        if (active.length) block(`INVENTORY=BLOCKED_ACTIVE_LEASE — 활성 lease ${active.length}건`);
      }
    }

    // ── 7. Cron·동시 실행 ─────────────────────────────────────────
    head("7. Cron · 동시 실행");
    let cronRuns = "PG_CRON_NOT_PRESENT";
    if (!(await relExists("cron.job"))) {
      line("pg_cron", "미설치 또는 접근 불가 → PG_CRON_NOT_PRESENT");
    } else {
      const cj = await q(`select jobid, jobname, schedule, active, database, username, command
                            from cron.job order by jobid`);
      if (!cj.ok) { line("cron.job 조회 실패", cj.code); errors.push(`cron.job: ${cj.code}`); }
      else {
        line("cron.job 전체", `${cj.rows.length}건`);
        for (const j of cj.rows) {
          const known = ALLOW.cronJobs.includes(j.jobname);
          line(`  [${j.jobid}] ${j.jobname}${known ? "" : " ← 비allowlist"}`,
            `${j.schedule} · active=${j.active} · db=${j.database} · user=${j.username} · ` +
            `cmd=${sha256(j.command).slice(0, 16)}…`);
        }
        const nonAllow = cj.rows.filter((j) => !ALLOW.cronJobs.includes(j.jobname));
        if (nonAllow.length) block(`비allowlist Cron ${nonAllow.length}건 — 임의 삭제 금지, 판정 필요`);
      }
      const rd = await q(`select count(*)::int n from cron.job_run_details where status = 'running'`);
      cronRuns = rd.ok ? String(rd.rows[0].n) : "ERR";
      line("현재 실행 중 Cron", cronRuns);
      if (rd.ok && rd.rows[0].n > 0) block(`실행 중인 DB Cron ${rd.rows[0].n}건 — 종료 대기 필요`);
    }

    head("7-1. pg_stat_activity (쿼리 원문 미출력)");
    const sa = await q(`select count(*) filter (where state = 'active')::int active,
                               count(*) filter (where state = 'idle in transaction')::int idle_tx,
                               count(*) filter (where xact_start < now() - interval '60s')::int long_tx,
                               count(*) filter (where state = 'active' and
                                     query ~* '^\\s*(insert|update|delete|truncate|alter|drop|create|grant|revoke)')::int writers
                          from pg_stat_activity
                         where datname = current_database() and pid <> pg_backend_pid()`);
    if (!sa.ok) line("조회 실패", sa.code);
    else {
      const s = sa.rows[0];
      line("active transaction", s.active);
      line("idle in transaction", s.idle_tx);
      line("60초 초과 장기 transaction", s.long_tx);
      line("쓰기형 명령 실행 중", `${s.writers}${s.writers > 0 ? " ⛔" : " ✅"}`);
      if (s.writers > 0) block(`다른 세션에서 쓰기형 명령 ${s.writers}건 실행 중`);
    }

    const lk = await q(`select count(*)::int n from pg_locks l
                          join pg_class c on c.oid = l.relation
                          join pg_namespace n on n.oid = c.relnamespace
                         where n.nspname in ('public','private','authz')
                           and l.mode in ('ExclusiveLock','AccessExclusiveLock','ShareRowExclusiveLock')
                           and l.pid <> pg_backend_pid()`);
    line("앱 객체 충돌성 lock", lk.ok ? lk.rows[0].n : "조회실패");
    if (lk.ok && lk.rows[0].n > 0) block(`앱 객체에 충돌성 lock ${lk.rows[0].n}건`);

    const pt = await q(`select count(*)::int n from pg_prepared_xacts`);
    line("prepared transaction", pt.ok ? pt.rows[0].n : "조회실패");
    if (pt.ok && pt.rows[0].n > 0) block(`prepared transaction ${pt.rows[0].n}건`);

    // ── 8. Storage·Auth 지문 (PRE_FENCE_BASELINE) ─────────────────
    head("8. Storage · Auth 지문 (원문 미출력, SHA-256만)");
    let usersDigest = "N/A", objsDigest = "N/A";
    if (await relExists("auth.users")) {
      const u = await q(`select id::text from auth.users order by id`);
      if (u.ok) {
        usersDigest = sha256(u.rows.map((r) => r.id).join("\n"));
        line("auth.users 개수", u.rows.length);
        line("auth.users.id 집합 SHA-256", usersDigest);
      } else { line("조회 실패", u.code); errors.push(`auth.users ids: ${u.code}`); }
    }
    if (await relExists("storage.objects")) {
      const o = await q(`select bucket_id, name from storage.objects order by bucket_id, name`);
      if (o.ok) {
        objsDigest = sha256(o.rows.map((r) => `${r.bucket_id} ${r.name}`).join("\n"));
        line("storage.objects 개수", o.rows.length);
        line("(bucket_id,name) 집합 SHA-256", objsDigest);
      } else { line("조회 실패", o.code); errors.push(`storage.objects: ${o.code}`); }
    }

    head("8-1. Storage 버킷");
    if (await relExists("storage.buckets")) {
      const b = await q(`select b.id, b.public, b.file_size_limit, b.allowed_mime_types,
                                (select count(*) from storage.objects o where o.bucket_id = b.id)::int n,
                                coalesce((select sum((o.metadata->>'size')::bigint) from storage.objects o
                                           where o.bucket_id = b.id), 0) bytes
                           from storage.buckets b order by b.id`);
      if (!b.ok) { line("조회 실패", b.code); errors.push(`buckets: ${b.code}`); }
      else {
        line("버킷 수", b.rows.length);
        for (const x of b.rows) {
          line(`  ${x.id}`, `${x.public ? "public ⛔" : "private ✅"} · ${x.n}개 · ` +
            `${(Number(x.bytes) / 1048576).toFixed(2)}MB · limit=${x.file_size_limit ?? "없음"} · ` +
            `mime=${x.allowed_mime_types ? x.allowed_mime_types.join(",") : "제한없음"}`);
          if (x.public) block(`버킷 ${x.id} 가 public`);
          if (x.id === "verification-docs") {
            line("  ⚠ verification-docs", "이미 존재 — 삭제·재생성하지 않고 현 설정 보고");
            findings.push("verification-docs 버킷이 이미 존재 (판정 필요)");
          }
        }
      }
    }

    // ── 판정 ──────────────────────────────────────────────────────
    head("판정");
    if (errors.length) {
      console.log("  조회 실패 항목 (테이블 없음과 구분됨):");
      for (const e of errors) console.log(`    · ${e}`);
    }
    const blocked = findings.length > 0 || errors.length > 0;
    console.log("");
    console.log(`PROD_INVENTORY=${blocked ? "BLOCKED" : "PASS_READ_ONLY"}`);
    console.log(`PROD_DB_READ=YES`);
    console.log(`PROD_DB_WRITE=NO`);
    console.log(`DB_WRITE_FENCE=PENDING`);
    console.log(`BATCH_RUNS_BASELINE=${batchState}`);
    console.log(`ACTIVE_MAINTENANCE_LEASES=${leaseState}`);
    console.log(`ACTIVE_DB_CRON_RUNS=${cronRuns}`);
    console.log(`TEST_ARTIFACTS=${findings.filter((f) => /테스트/.test(f)).length}`);
    console.log(`RESET_PREFLIGHT_INVENTORY=${blocked ? "BLOCKED" : "CLEAR"}`);
    console.log(`AUTH_USERS_DIGEST_PRE_FENCE=${usersDigest}`);
    console.log(`STORAGE_OBJECTS_DIGEST_PRE_FENCE=${objsDigest}`);
    if (blocked) {
      console.log("\n⛔ 임의 정리 금지. 위 목록 그대로 판정을 요청할 것.");
      for (const f of findings) console.log(`   · ${f}`);
    }
    process.exitCode = blocked ? 3 : 0;
  } finally {
    // 읽기 전용이라 되돌릴 변경이 없지만, 명시적으로 닫는다.
    try { await client.query("rollback"); } catch {}
    await client.end();
    console.log("\n읽기 전용 트랜잭션으로 실행했습니다. 아무것도 변경하지 않았습니다.");
  }
}

main().catch((e) => { console.error("[fail] " + scrub(e.message || String(e), url)); process.exit(1); });
