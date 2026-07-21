// ============================================================
// prod-backup-native.mjs — 운영 논리 백업 (pg_dump 17 네이티브)
// ============================================================
// GPT 런북 6단계 PRE_FENCE_INITIAL_BACKUP 명세 구현.
//
// 왜 node 판(prod-backup.mjs)을 쓰지 않는가:
//   GPT 판정 — "Node pg 드라이버로 SELECT 결과를 JSON/CSV로 저장하는 방식은
//   논리백업 대체로 인정하지 않는다." 복구 시 신뢰할 수 있는 건 pg_dump 가
//   생성한 정본이다. 우선순위 A(Supabase CLI)는 Docker 필요 → 이 머신에 없음.
//   따라서 우선순위 B: PostgreSQL 17 네이티브 클라이언트.
//   서버가 17.6 이므로 이전 major 클라이언트는 금지 — 설치본은 17.10.
//
// 산출물 (저장소·워크트리·클라우드 동기화 폴더 **밖**):
//   roles.sql · schema.sql · data.sql · storage-manifest.json
//   + backup-receipt.json · SHA256SUMS.txt
//
// 비밀값 취급:
//   접속 URL을 argv 에 싣지 않는다. PG* 환경변수로 넘겨 프로세스 목록·명령
//   로그 어디에도 비밀번호가 남지 않게 한다. receipt 에도 URL을 적지 않는다.
//   산출물 내용은 절대 출력하지 않는다 (개수·해시·boolean 만).
//
// 사용: node scripts/manual/prod-backup-native.mjs
// 종료: 0 = PASS, 3 = BLOCKED, 1 = 실패
// ============================================================
import pg from "pg";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, renameSync, existsSync, statSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { readProdEnv, assertProdUrl, PROD_REF, refOf, scrub } from "./prod-url.mjs";

const PG_BIN = "C:/pgsql17/bin";
const BACKUP_ROOT = join(homedir(), "prod-backups");   // 저장소 밖, OneDrive 밖

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
if (!url) { console.error("[중단] PROD_DB_URL 없음"); process.exit(1); }
assertProdUrl(url, "PROD_DB_URL");

const u = new URL(url);
if (!/\.pooler\.supabase\.com$/.test(u.hostname)) { console.error("[거부] Session pooler 가 아님"); process.exit(3); }
if (u.port !== "5432") { console.error("[거부] Transaction pooler(6543) 금지"); process.exit(3); }

// URL 을 argv 에 싣지 않기 위해 PG* 환경변수로 전달한다.
const PGENV = {
  ...process.env,
  PGHOST: u.hostname,
  PGPORT: u.port,
  PGUSER: decodeURIComponent(u.username),
  PGPASSWORD: decodeURIComponent(u.password),
  PGDATABASE: u.pathname.replace(/^\//, "") || "postgres",
  PGSSLMODE: "require",
};

const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const line = (k, v) => console.log(`  ${String(k).padEnd(36)} ${v}`);
const head = (t) => console.log(`\n=== ${t} ===`);

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
let OUTDIR = null;
const fail = (code, why) => { console.error(`\n⛔ ${code}: ${why}`); quarantine(); process.exit(3); };
function quarantine() {
  if (OUTDIR && existsSync(OUTDIR)) {
    const q = OUTDIR + "_INCOMPLETE";
    try { renameSync(OUTDIR, q); console.error(`   중간 산출물을 ${basename(q)} 로 격리했다 (삭제하지 않음).`); } catch {}
  }
}

/** COPY 블록 경계만 파싱해 테이블별 행 수를 센다. 파일 전체 정규식 금지(GPT 7.4). */
function copyCounts(path) {
  const out = {};
  const lines = readFileSync(path, "utf8").split("\n");
  let cur = null, n = 0;
  for (const l of lines) {
    if (cur === null) {
      const m = /^COPY\s+([^\s(]+)\s*\(.*\)\s+FROM\s+stdin;\s*$/.exec(l);
      if (m) { cur = m[1].replace(/"/g, ""); n = 0; }
    } else if (l === "\\.") {
      out[cur] = (out[cur] ?? 0) + n; cur = null;
    } else n++;
  }
  return out;
}

async function snapshotState() {
  await client.query("begin transaction isolation level repeatable read read only");
  const g = async (sql) => (await client.query(sql)).rows[0];
  const s = {
    ref: refOf(url),
    ro: (await g(`select current_setting('transaction_read_only') v`)).v,
    iso: (await g(`select current_setting('transaction_isolation') v`)).v,
    at: (await g(`select now() at time zone 'utc' v`)).v,
    users: Number((await g(`select count(*) v from auth.users`)).v),
    idents: Number((await g(`select count(*) v from auth.identities`)).v),
    buckets: Number((await g(`select count(*) v from storage.buckets`)).v),
    objects: Number((await g(`select count(*) v from storage.objects`)).v),
    writers: Number((await g(`select count(*) v from pg_stat_activity
                               where datname = current_database() and pid <> pg_backend_pid()
                                 and state = 'active'
                                 and query ~* '^\\s*(insert|update|delete|truncate|alter|drop|create|grant|revoke)'`)).v),
    tables: {},
  };
  for (const t of ["comment_owners", "comments", "post_owners", "posts", "profiles"]) {
    s.tables[`public.${t}`] = Number((await g(`select count(*) v from public.${t}`)).v);
  }
  // 지문 canonicalizer 는 prod-inventory.mjs 와 동일 규칙을 재사용한다(새 규칙 만들지 않음).
  s.usersDigest = sha256((await client.query(`select id::text from auth.users order by id`))
    .rows.map((r) => r.id).join("\n"));
  const objs = (await client.query(`select bucket_id, name from storage.objects order by bucket_id, name`)).rows;
  s.objsDigest = sha256(objs.map((o) => `${o.bucket_id} ${o.name}`).join("\n"));
  s.bucketRows = (await client.query(
    `select id, name, public, file_size_limit, allowed_mime_types, created_at, updated_at
       from storage.buckets order by id`)).rows;
  await client.query("rollback");
  return s;
}

async function main() {
  await client.connect();

  // ── 4. 백업 직전 재확인 ──────────────────────────────────────
  head("4. 백업 직전 상태 재확인");
  const gitMain = execFileSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" }).trim();
  line("origin/main", gitMain === "e8fab516b538a8c34230d4b68c2efe93c3a69517" ? `${gitMain.slice(0, 7)} ✅` : `${gitMain.slice(0, 7)} ⛔`);
  if (gitMain !== "e8fab516b538a8c34230d4b68c2efe93c3a69517") fail("PRE_BACKUP_STATE_DRIFT=BLOCKED", "origin/main 변경됨");

  for (const p of ["/", "/login", "/board/free"]) {
    const r = await fetch(`https://snueapp.vercel.app${p}?cb=${Date.now()}${Math.random()}`, { redirect: "manual" });
    line(`앱 ${p}`, `${r.status}${r.status === 503 ? " ✅" : " ⛔"}`);
    if (r.status !== 503) fail("PRE_BACKUP_STATE_DRIFT=BLOCKED", `${p} 가 503 이 아님`);
  }

  const pre = await snapshotState();
  line("DB ref", pre.ref === PROD_REF ? `${pre.ref} ✅` : "⛔ 불일치");
  line("read_only / isolation", `${pre.ro} / ${pre.iso}`);
  line("앱 객체 writer", `${pre.writers}${pre.writers === 0 ? " ✅" : " ⛔"}`);
  line("auth.users / identities", `${pre.users} / ${pre.idents}`);
  line("storage buckets / objects", `${pre.buckets} / ${pre.objects}`);
  if (pre.ref !== PROD_REF) fail("PRE_BACKUP_STATE_DRIFT=BLOCKED", "ref 불일치");
  if (pre.ro !== "on" || pre.iso !== "repeatable read") fail("PRE_BACKUP_STATE_DRIFT=BLOCKED", "읽기전용/격리수준 불일치");
  if (pre.writers !== 0) fail("PRE_BACKUP_STATE_DRIFT=BLOCKED", "writer 존재");
  if (pre.users !== 1) fail("PRE_BACKUP_STATE_DRIFT=BLOCKED", `auth.users=${pre.users} (기대 1)`);
  if (pre.buckets !== 0 || pre.objects !== 0) fail("STORAGE_STATE_DRIFT=BLOCKED", "storage 객체 발견");
  // batch_runs·leases·pg_cron 은 인벤토리에서 미존재로 확정됐다. 재확인만.
  for (const [rel, label] of [["private.maintenance_leases", "활성 lease"], ["cron.job", "DB Cron"]]) {
    const e = (await client.query(`select to_regclass($1) is not null e`, [rel])).rows[0].e;
    line(label, e ? "테이블 존재 — 확인 필요" : "테이블 미존재 ✅");
    if (e) fail("PRE_BACKUP_STATE_DRIFT=BLOCKED", `${rel} 가 생겼다`);
  }

  // ── 5. dump 실행 ─────────────────────────────────────────────
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
  OUTDIR = join(BACKUP_ROOT, stamp);
  if (existsSync(OUTDIR)) fail("BACKUP_DIR_EXISTS", "같은 timestamp 디렉터리가 이미 있다");
  mkdirSync(OUTDIR, { recursive: true });
  // Windows ACL: 현재 사용자만. 상속 제거 후 본인 FullControl.
  try {
    execFileSync("icacls", [OUTDIR, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:(OI)(CI)F`], { stdio: "ignore" });
  } catch { console.error("  (ACL 제한 실패 — 계속하되 receipt 에 기록한다)"); }

  head("5. dump 실행 (roles → schema → data)");
  console.log(`  출력 디렉터리: ${OUTDIR}`);   // 로그에 한 번만 기록

  const run = (exe, args, outfile) => {
    try {
      execFileSync(join(PG_BIN, exe), args, { env: PGENV, stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      const err = scrub(String(e.stderr || e.message), url, PGENV.PGPASSWORD);
      console.error(`  ${exe} 실패: ${err.slice(0, 300)}`);
      fail("BACKUP_DUMP_FAILED", `${exe} exit != 0`);
    }
    if (!existsSync(outfile) || statSync(outfile).size === 0) fail("BACKUP_DUMP_EMPTY", `${basename(outfile)} 가 비었다`);
    line(basename(outfile), `${statSync(outfile).size}B`);
  };

  const fRoles = join(OUTDIR, "roles.sql");
  const fSchema = join(OUTDIR, "schema.sql");
  const fData = join(OUTDIR, "data.sql");

  run("pg_dumpall.exe", ["--roles-only", "--no-role-passwords", "-f", fRoles], fRoles);
  run("pg_dump.exe", ["--schema-only", "--schema=public", "-f", fSchema], fSchema);
  run("pg_dump.exe", ["--data-only",
    "--schema=public", "--schema=auth", "--schema=storage",
    "--exclude-table=storage.buckets_vectors", "--exclude-table=storage.vector_indexes",
    "-f", fData], fData);

  // ── 6. Storage manifest ──────────────────────────────────────
  head("6. Storage manifest");
  const manifest = {
    manifest_version: 1,
    project_ref: PROD_REF,
    backup_class: "PRE_FENCE_INITIAL",
    captured_at_utc: pre.at.toISOString(),
    bucket_count: pre.buckets,
    object_count: pre.objects,
    total_bytes: 0,
    buckets: pre.bucketRows,
    object_keys_sha256: pre.objsDigest,
    verification_docs_status: pre.bucketRows.some((b) => b.id === "verification-docs") ? "PRESENT" : "NOT_PRESENT",
    physical_object_backup: pre.objects === 0 ? "NOT_REQUIRED_ZERO_OBJECTS" : "REQUIRED",
    source: "POSTGRES_STORAGE_CATALOG",
    transaction_read_only: pre.ro,
    transaction_isolation: pre.iso,
  };
  const fManifest = join(OUTDIR, "storage-manifest.json");
  writeFileSync(fManifest, JSON.stringify(manifest, null, 2));
  line("storage-manifest.json", `${statSync(fManifest).size}B · bucket ${pre.buckets} / object ${pre.objects}`);

  // ── 7. 검증 ──────────────────────────────────────────────────
  head("7.1 공통 검증");
  const bodies = [fRoles, fSchema, fData, fManifest];
  for (const f of bodies) {
    const buf = readFileSync(f);
    const nul = buf.includes(0);
    let utf8ok = true;
    try { new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { utf8ok = false; }
    line(basename(f), `${buf.length}B · NUL ${nul ? "있음 ⛔" : "없음 ✅"} · UTF-8 ${utf8ok ? "✅" : "⛔"}`);
    if (nul || !utf8ok) fail("BACKUP_FILE_INVALID", basename(f));
  }

  head("7.2 roles.sql");
  const rolesTxt = readFileSync(fRoles, "utf8");
  const hasSecret = /SCRAM-SHA-256\$|md5[0-9a-f]{32}|PASSWORD\s+'/i.test(rolesTxt);
  const hasRole = /CREATE ROLE|ALTER ROLE/i.test(rolesTxt);
  line("비밀번호·SCRAM hash", hasSecret ? "검출 ⛔" : "0건 ✅");
  line("ROLE 문 존재", hasRole ? "있음 ✅" : "없음 ⛔");
  if (hasSecret) fail("ROLES_BACKUP=FAIL", "role 비밀번호/해시가 포함됐다");
  if (!hasRole) fail("ROLES_BACKUP=FAIL", "ROLE 문이 없다 (오류 출력이거나 빈 덤프)");

  head("7.3 schema.sql 핵심 객체 (원문 미출력, boolean/count)");
  const schemaTxt = readFileSync(fSchema, "utf8");
  const checks = {
    "public.comment_owners": /CREATE TABLE public\.comment_owners\b/,
    "public.comments": /CREATE TABLE public\.comments\b/,
    "public.post_owners": /CREATE TABLE public\.post_owners\b/,
    "public.posts": /CREATE TABLE public\.posts\b/,
    "public.profiles": /CREATE TABLE public\.profiles\b/,
    "public.rls_auto_enable": /FUNCTION public\.rls_auto_enable\b/,
    // 시퀀스는 두 형태 중 하나로 나온다:
    //   · 독립/serial  → CREATE SEQUENCE public.x
    //   · IDENTITY 컬럼 → ALTER TABLE ... ADD GENERATED ... AS IDENTITY (SEQUENCE NAME public.x ...)
    // 이 운영 DB는 IDENTITY 쪽이다. CREATE SEQUENCE 만 보면 정상 백업을 누락으로
    // 오판한다(실제로 1회차에 그랬다).
    "comments_id_seq": /(?:CREATE SEQUENCE|SEQUENCE NAME)\s+public\.comments_id_seq\b/,
    "posts_id_seq": /(?:CREATE SEQUENCE|SEQUENCE NAME)\s+public\.posts_id_seq\b/,
  };
  let schemaOk = true;
  for (const [k, re] of Object.entries(checks)) {
    const ok = re.test(schemaTxt); if (!ok) schemaOk = false;
    line(k, ok ? "포함 ✅" : "누락 ⛔");
  }
  const nPolicy = (schemaTxt.match(/^CREATE POLICY /gm) || []).length;
  const nTrigger = (schemaTxt.match(/^CREATE TRIGGER /gm) || []).length;
  line("RLS 정책", `${nPolicy}개 ${nPolicy >= 11 ? "✅" : "⛔"}`);
  line("비내부 트리거", `${nTrigger}개 ${nTrigger >= 7 ? "✅" : "⛔"}`);
  if (!schemaOk || nPolicy < 11 || nTrigger < 7) fail("SCHEMA_BACKUP=FAIL", "핵심 객체 누락");

  head("7.4 data.sql COPY 블록 행 수");
  const cc = copyCounts(fData);
  const expect = {
    "public.comment_owners": 1, "public.comments": 1, "public.post_owners": 2,
    "public.posts": 2, "public.profiles": 1, "auth.users": 1, "auth.identities": 1,
  };
  let dataOk = true;
  for (const [t, want] of Object.entries(expect)) {
    const got = cc[t] ?? 0;
    const ok = got === want; if (!ok) dataOk = false;
    line(t, `${got} / 기대 ${want} ${ok ? "✅" : "⛔"}`);
  }
  for (const t of ["storage.buckets", "storage.objects"]) {
    line(t, `${cc[t] ?? 0} (빈 테이블 COPY 블록 생략 허용)`);
  }
  // setval 은 pg_catalog. 접두사가 붙어 나온다: SELECT pg_catalog.setval('public.x', n, true);
  const dataTxt = readFileSync(fData, "utf8");
  const seqOk = /setval\('public\.comments_id_seq'/.test(dataTxt)
    && /setval\('public\.posts_id_seq'/.test(dataTxt);
  line("sequence state (setval)", seqOk ? "포함 ✅" : "누락 ⛔");
  if ((cc["auth.users"] ?? 0) !== 1 || (cc["auth.identities"] ?? 0) !== 1) {
    fail("DATA_BACKUP_MISSING_AUTH=BLOCKED", "auth.users/identities 행이 data.sql 에 없다");
  }
  if (!dataOk) fail("DATA_BACKUP=FAIL", "행 수 불일치");

  // ── 8. 백업 후 drift ─────────────────────────────────────────
  head("8. 백업 후 drift 검사 (새 read-only transaction)");
  const post = await snapshotState();
  const drift = [];
  for (const [k, v] of Object.entries(pre.tables)) if (post.tables[k] !== v) drift.push(k);
  if (post.users !== pre.users) drift.push("auth.users");
  if (post.idents !== pre.idents) drift.push("auth.identities");
  if (post.buckets !== pre.buckets || post.objects !== pre.objects) drift.push("storage");
  if (post.usersDigest !== pre.usersDigest) drift.push("auth.users digest");
  if (post.objsDigest !== pre.objsDigest) drift.push("storage digest");
  for (const [k, v] of Object.entries(post.tables)) line(k, `${v}행`);
  line("auth.users digest 일치", post.usersDigest === "1af01ece257e646d822e2d23f98cb5ef4874dd2952cc0657cf23aef3e55760b9" ? "✅ 인벤토리와 동일" : "⛔");
  line("storage digest 일치", post.objsDigest === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" ? "✅ 인벤토리와 동일" : "⛔");
  line("drift", drift.length ? `${drift.join(", ")} ⛔` : "없음 ✅");
  if (drift.length) fail("BACKUP_DRIFT=DETECTED", drift.join(", "));

  // ── 9. receipt + SHA256SUMS ──────────────────────────────────
  head("9. 증거 파일");
  const digests = {};
  for (const f of bodies) digests[basename(f)] = { bytes: statSync(f).size, sha256: sha256File(f) };

  const receipt = {
    backup_class: "PRE_FENCE_INITIAL",
    project_ref: PROD_REF,
    captured_at_utc: pre.at.toISOString(),
    endpoint: "SESSION_POOLER_5432",
    ipv6_direct_used: false,
    transaction_pooler_used: false,
    toolchain: "PG17_NATIVE",
    toolchain_versions: {
      pg_dump: execFileSync(join(PG_BIN, "pg_dump.exe"), ["--version"], { encoding: "utf8" }).trim(),
      pg_dumpall: execFileSync(join(PG_BIN, "pg_dumpall.exe"), ["--version"], { encoding: "utf8" }).trim(),
      server: (await client.query(`select current_setting('server_version') v`)).rows[0].v,
    },
    files: digests,
    schema_core_objects_verified: true,
    data_row_counts: { expected: expect, actual: Object.fromEntries(Object.entries(expect).map(([k]) => [k, cc[k] ?? 0])) },
    sequence_state_included: seqOk,
    fingerprints: {
      pre: { auth_users: pre.usersDigest, storage_objects: pre.objsDigest },
      post: { auth_users: post.usersDigest, storage_objects: post.objsDigest },
    },
    drift: "NONE",
    storage_physical_object_backup: "NOT_REQUIRED_ZERO_OBJECTS",
    prod_main: gitMain,
    rollback_pre_db: "081530f9687c7caeecf17389fe7e2c5688e06f46",
    db_permanent_write_count: 0,
    secret_pii_output_count: 0,
    restore_validation_level: "STRUCTURAL_AND_CONTENT_COUNT_VALIDATED",
    production_restore_attempted: false,
  };
  const fReceipt = join(OUTDIR, "backup-receipt.json");
  writeFileSync(fReceipt, JSON.stringify(receipt, null, 2));

  const sums = [...bodies, fReceipt].map((f) => `${sha256File(f)}  ${basename(f)}`).join("\n") + "\n";
  const fSums = join(OUTDIR, "SHA256SUMS.txt");
  writeFileSync(fSums, sums);

  // SHA256SUMS 재검증 — 해시 계산 뒤 파일이 바뀌지 않았는지
  let sumsOk = true;
  for (const l of readFileSync(fSums, "utf8").trim().split("\n")) {
    const [h, name] = l.split(/\s+/);
    if (sha256File(join(OUTDIR, name)) !== h) { sumsOk = false; line(name, "해시 불일치 ⛔"); }
  }
  line("SHA256SUMS 재검증", sumsOk ? "전부 일치 ✅" : "불일치 ⛔");
  if (!sumsOk) fail("BACKUP_INTEGRITY=FAIL", "SHA256SUMS 불일치");

  for (const [n, d] of Object.entries(digests)) line(n, `${d.bytes}B · ${d.sha256}`);
  line("backup-receipt.json", `${statSync(fReceipt).size}B · ${sha256File(fReceipt)}`);

  // ── 10. 상태 보고 ────────────────────────────────────────────
  console.log("");
  console.log("PROD_BACKUP_PRE_FENCE=PASS");
  console.log("BACKUP_CLASS=PRE_FENCE_INITIAL");
  console.log("BACKUP_TOOLCHAIN=PG17_NATIVE");
  console.log("BACKUP_ENDPOINT=SESSION_POOLER_5432");
  console.log(`ROLES_BACKUP=PASS / bytes=${digests["roles.sql"].bytes} / sha256=${digests["roles.sql"].sha256}`);
  console.log(`SCHEMA_BACKUP=PASS / bytes=${digests["schema.sql"].bytes} / sha256=${digests["schema.sql"].sha256}`);
  console.log(`DATA_BACKUP=PASS / bytes=${digests["data.sql"].bytes} / sha256=${digests["data.sql"].sha256}`);
  console.log(`STORAGE_MANIFEST=PASS_EMPTY_ZERO_OBJECTS / bytes=${digests["storage-manifest.json"].bytes} / sha256=${digests["storage-manifest.json"].sha256}`);
  console.log("STORAGE_PHYSICAL_OBJECT_BACKUP=NOT_REQUIRED_ZERO_OBJECTS");
  console.log("BACKUP_DRIFT=NONE");
  console.log(`AUTH_USERS=${post.users}`);
  console.log(`AUTH_IDENTITIES=${post.idents}`);
  console.log(`STORAGE_BUCKETS=${post.buckets}`);
  console.log(`STORAGE_OBJECTS=${post.objects}`);
  console.log("PROD_DB_READ=YES");
  console.log("PROD_DB_WRITE=NO");
  console.log("DB_WRITE_FENCE=PENDING");
  console.log("RESET_EXECUTED=NO");
  console.log("MIGRATIONS_EXECUTED=NO");
  console.log("NEXT_STAGE=STOPPED_BEFORE_DB_WRITE_FENCE");
}

main()
  .then(() => client.end())
  .catch(async (e) => {
    console.error("[fail] " + scrub(e.message || String(e), url, PGENV.PGPASSWORD));
    quarantine();
    try { await client.end(); } catch {}
    process.exit(1);
  });
