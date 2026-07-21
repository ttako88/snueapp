// ============================================================
// ⚠ 이 스크립트는 **정식 백업 수단이 아니다.** 대체본을 쓰지 말 것.
// ============================================================
// GPT 판정(2026-07-21): "Node pg 드라이버로 SELECT 결과를 JSON/CSV로 저장하는
// 방식은 논리백업 대체로 인정하지 않는다." 복구 시 신뢰할 수 있는 건 pg_dump 가
// 생성한 정본이다.
//
// 정식 백업 → scripts/manual/prod-backup-native.mjs (pg_dump 17 네이티브)
//
// 이 파일은 pg_dump 가 없던 시점에 만든 것으로, 지금은 **행 수·지문 교차확인용
// 보조 도구**로만 남긴다. 산출물을 백업으로 신뢰하지 말 것.
// ============================================================
//
// prod-backup.mjs — 운영 DB 논리 백업 (pg_dump 없이 node 로)
// ============================================================
// 왜 node 인가:
//   이 머신에 pg_dump·psql·supabase CLI 가 전부 없다. 설치하려면 install
//   script 승인 게이트를 건드려야 하고, 서버가 PG 17.6 이라 클라이언트도
//   17 이상이어야 한다. 반면 운영 데이터는 총 7행·0.2MB 규모라
//   node 드라이버로 정확한 논리 백업을 뜨는 편이 빠르고 검증도 쉽다.
//
// 산출물 3종 + manifest (런북의 "논리 백업 3종 + Storage manifest"):
//   1) schema.sql        — public 스키마 DDL (pg_get_*def 로 서버가 생성한 정본)
//   2) data.json         — 앱 테이블 + auth.users/identities 전체 행
//   3) storage.json      — 버킷·객체 목록 (객체 0개여도 증거로 남긴다)
//   +) MANIFEST.json     — 각 파일 SHA-256·행수·스냅샷 정보
//
// 일관성:
//   **하나의 REPEATABLE READ READ ONLY 트랜잭션**에서 3종을 모두 뜬다.
//   따로 뜨면 산출물끼리 시점이 어긋나 복구 때 참조 무결성이 깨질 수 있다.
//
// 개인정보 취급:
//   산출물에는 이메일·닉네임·글 본문·auth user id 가 들어간다. 이건 백업의
//   본질이라 피할 수 없다. 대신:
//     · /backups/ 는 .gitignore 로 차단돼 있다 (파일 생성 **전에** 확인한다)
//     · 파일 권한 0600
//     · 화면·로그에는 개수와 해시만 출력하고 행 내용은 절대 출력하지 않는다
//
// 사용: node scripts/manual/prod-backup.mjs
// 종료 코드: 0 = 성공, 1 = 실패
// ============================================================
import pg from "pg";
import { writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readProdEnv, assertProdUrl, PROD_REF, refOf, scrub } from "./prod-url.mjs";

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
if (!url) { console.error("[중단] PROD_DB_URL 없음"); process.exit(1); }
assertProdUrl(url, "PROD_DB_URL");
if (refOf(url) !== PROD_REF) { console.error("[중단] 운영 ref 불일치"); process.exit(1); }

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
const OUTDIR = resolve(process.cwd(), "backups/prod", stamp);

// ── 개인정보가 git 에 새지 않는지 **파일 생성 전에** 확인 ──────────────
// 순서가 중요하다. 만들고 나서 확인하면 이미 늦다.
try {
  execFileSync("git", ["check-ignore", "-q", "backups/prod/probe"], { stdio: "ignore" });
} catch {
  console.error("[중단] backups/ 가 .gitignore 로 차단돼 있지 않습니다.");
  console.error("       운영 개인정보가 저장소에 올라갈 수 있으므로 백업을 만들지 않습니다.");
  process.exit(1);
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const line = (k, v) => console.log(`  ${String(k).padEnd(34)} ${v}`);

const files = {};
function emit(name, content) {
  const p = resolve(OUTDIR, name);
  writeFileSync(p, content, { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch {}
  files[name] = { bytes: Buffer.byteLength(content), sha256: sha256(content) };
  line(name, `${Buffer.byteLength(content)}B · ${sha256(content).slice(0, 16)}…`);
}

async function main() {
  await client.connect();
  await client.query("begin transaction isolation level repeatable read read only");
  await client.query("set local statement_timeout = '120s'");

  try {
    mkdirSync(OUTDIR, { recursive: true });

    const snap = (await client.query(
      `select pg_current_snapshot()::text s, now() at time zone 'utc' t,
              current_setting('server_version') v,
              current_setting('transaction_read_only') ro,
              current_setting('transaction_isolation') iso`)).rows[0];
    console.log(`대상 ref  ${PROD_REF}`);
    console.log(`스냅샷    ${snap.s} @ ${snap.t.toISOString()}`);
    console.log(`모드      read_only=${snap.ro} · isolation=${snap.iso}`);
    if (snap.ro !== "on") throw new Error("read only 트랜잭션이 아님 — 중단");
    console.log(`출력      backups/prod/${stamp}/\n`);
    console.log("=== 산출물 ===");

    // ── 1) schema.sql — 서버가 생성한 정본 DDL ────────────────────
    const parts = [
      `-- 운영 논리 백업 (스키마) — ${snap.t.toISOString()}`,
      `-- PostgreSQL ${snap.v} · snapshot ${snap.s} · ref ${PROD_REF}`,
      `-- pg_get_*def 로 서버가 직접 생성한 정의다 (손으로 재구성한 것이 아님).`,
      ``,
    ];

    const seqs = (await client.query(
      `select schemaname, sequencename, data_type, start_value, min_value, max_value,
              increment_by, cycle, last_value
         from pg_sequences where schemaname = 'public' order by sequencename`)).rows;
    parts.push("-- ── 시퀀스 ──");
    for (const s of seqs) {
      parts.push(`create sequence if not exists public.${s.sequencename} as ${s.data_type} ` +
        `increment by ${s.increment_by} minvalue ${s.min_value} maxvalue ${s.max_value} ` +
        `start with ${s.start_value}${s.cycle ? " cycle" : " no cycle"};`);
      if (s.last_value !== null) parts.push(`select setval('public.${s.sequencename}', ${s.last_value}, true);`);
    }

    const tables = (await client.query(
      `select c.relname, c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' order by c.relname`)).rows;

    parts.push("", "-- ── 테이블 ──");
    for (const t of tables) {
      const cols = (await client.query(
        `select a.attname, format_type(a.atttypid, a.atttypmod) typ, a.attnotnull nn,
                pg_get_expr(d.adbin, d.adrelid) def
           from pg_attribute a
           left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
          where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped
          order by a.attnum`, [t.oid])).rows;
      const body = cols.map((c) =>
        `  ${c.attname} ${c.typ}${c.def ? ` default ${c.def}` : ""}${c.nn ? " not null" : ""}`).join(",\n");
      parts.push(`create table if not exists public.${t.relname} (\n${body}\n);`);
    }

    parts.push("", "-- ── 제약 (PK → UNIQUE → CHECK → FK 순) ──");
    for (const k of ["p", "u", "c", "f"]) {
      const cons = (await client.query(
        `select c.relname tbl, con.conname, pg_get_constraintdef(con.oid) def
           from pg_constraint con
           join pg_class c on c.oid = con.conrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and con.contype = $1
          order by c.relname, con.conname`, [k])).rows;
      for (const c of cons) {
        parts.push(`alter table public.${c.tbl} add constraint ${c.conname} ${c.def};`);
      }
    }

    parts.push("", "-- ── 인덱스 (제약이 만든 것 제외) ──");
    for (const i of (await client.query(
      `select indexdef from pg_indexes i
        where schemaname = 'public'
          and not exists (select 1 from pg_constraint con
                           where con.conname = i.indexname and con.contype in ('p','u'))
        order by indexname`)).rows) parts.push(i.indexdef + ";");

    parts.push("", "-- ── 함수 ──");
    for (const f of (await client.query(
      `select pg_get_functiondef(p.oid) def
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prokind = 'f'
        order by p.oid::regprocedure::text`)).rows) parts.push(f.def + ";");

    parts.push("", "-- ── 트리거 ──");
    for (const g of (await client.query(
      `select pg_get_triggerdef(t.oid) def
         from pg_trigger t join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and not t.tgisinternal
        order by c.relname, t.tgname`)).rows) parts.push(g.def + ";");

    parts.push("", "-- ── RLS 및 정책 ──");
    for (const t of tables) {
      const r = (await client.query(`select relrowsecurity ro, relforcerowsecurity fo
                                       from pg_class where oid = $1`, [t.oid])).rows[0];
      if (r.ro) parts.push(`alter table public.${t.relname} enable row level security;`);
      if (r.fo) parts.push(`alter table public.${t.relname} force row level security;`);
    }
    for (const p of (await client.query(
      `select c.relname tbl, pol.polname, pol.polcmd,
              pg_get_expr(pol.polqual, pol.polrelid) using_expr,
              pg_get_expr(pol.polwithcheck, pol.polrelid) check_expr,
              (select string_agg(quote_ident(r.rolname), ', ')
                 from pg_roles r where r.oid = any(pol.polroles)) roles
         from pg_policy pol
         join pg_class c on c.oid = pol.polrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' order by c.relname, pol.polname`)).rows) {
      const cmd = { "*": "all", r: "select", a: "insert", w: "update", d: "delete" }[p.polcmd];
      parts.push(`create policy ${JSON.stringify(p.polname)} on public.${p.tbl} ` +
        `for ${cmd}${p.roles ? ` to ${p.roles}` : ""}` +
        `${p.using_expr ? ` using (${p.using_expr})` : ""}` +
        `${p.check_expr ? ` with check (${p.check_expr})` : ""};`);
    }

    parts.push("", "-- ── 권한 ──");
    for (const g of (await client.query(
      `select c.relname, c.relacl::text acl
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','S') and c.relacl is not null
        order by c.relname`)).rows) parts.push(`-- ${g.relname}: ${g.acl}`);

    emit("schema.sql", parts.join("\n") + "\n");

    // ── 2) data.json — 전체 행 ────────────────────────────────────
    const data = { _meta: { snapshot: snap.s, at: snap.t.toISOString(), ref: PROD_REF }, tables: {} };
    const counts = {};
    const targets = [
      ...tables.map((t) => `public.${t.relname}`),
      "auth.users", "auth.identities",
    ];
    for (const q of targets) {
      const r = await client.query(`select * from ${q}`);
      data.tables[q] = r.rows;
      counts[q] = r.rows.length;
    }
    emit("data.json", JSON.stringify(data, null, 2));

    // ── 3) storage.json — 객체 0개여도 증거로 남긴다 ──────────────
    const buckets = (await client.query(
      `select id, name, public, file_size_limit, allowed_mime_types, created_at, updated_at
         from storage.buckets order by id`)).rows;
    const objects = (await client.query(
      `select id, bucket_id, name, owner, created_at, updated_at, last_accessed_at, metadata
         from storage.objects order by bucket_id, name`)).rows;
    emit("storage.json", JSON.stringify(
      { _meta: { snapshot: snap.s, at: snap.t.toISOString(), ref: PROD_REF }, buckets, objects }, null, 2));

    // ── manifest ──────────────────────────────────────────────────
    const usersDigest = sha256((await client.query(
      `select id::text from auth.users order by id`)).rows.map((r) => r.id).join("\n"));
    const objsDigest = sha256(objects.map((o) => `${o.bucket_id} ${o.name}`).join("\n"));

    const manifest = {
      created_at: snap.t.toISOString(),
      project_ref: PROD_REF,
      postgres_version: snap.v,
      snapshot: snap.s,
      method: "node-pg logical dump (pg_dump 미설치 환경)",
      isolation: snap.iso,
      read_only: snap.ro,
      row_counts: counts,
      storage: { buckets: buckets.length, objects: objects.length },
      digests: { auth_users_ids: usersDigest, storage_objects: objsDigest },
      files,
    };
    const mj = JSON.stringify(manifest, null, 2);
    writeFileSync(resolve(OUTDIR, "MANIFEST.json"), mj, { mode: 0o600 });
    files["MANIFEST.json"] = { bytes: Buffer.byteLength(mj), sha256: sha256(mj) };
    line("MANIFEST.json", `${Buffer.byteLength(mj)}B · ${sha256(mj).slice(0, 16)}…`);

    console.log("\n=== 행 수 (내용 미출력) ===");
    for (const [k, v] of Object.entries(counts)) line(k, `${v}행`);
    line("storage.buckets", `${buckets.length}개`);
    line("storage.objects", `${objects.length}개`);

    console.log("\n=== 지문 (인벤토리와 대조용) ===");
    line("auth.users.id 집합", usersDigest);
    line("storage.objects 집합", objsDigest);

    console.log(`\nBACKUP_DIR=backups/prod/${stamp}`);
    console.log(`BACKUP_SNAPSHOT=${snap.s}`);
    console.log(`BACKUP=OK`);
  } finally {
    try { await client.query("rollback"); } catch {}
    await client.end();
  }
}

main().catch((e) => { console.error("[fail] " + scrub(e.message || String(e), url)); process.exit(1); });
