// ============================================================
// prod-fence-verify.mjs — fence 실증 probe + fence 후 최종 백업
// ============================================================
// GPT 런북 7단계의 7·10·11·12항.
//
// 왜 카탈로그 검사로 끝내지 않는가:
//   has_table_privilege 가 false 라는 건 "권한 테이블상 없다"는 뜻이다.
//   실제로 REST 로 때렸을 때 막히는지는 별개 문제다. 직접 쏴본다.
//
// probe 설계 (파괴 없음):
//   · INSERT·UPDATE 가 아니라 **zero-match DELETE** 를 쓴다.
//     권한이 살아있었더라도 지워질 행이 0인 조건이라 데이터가 안전하다.
//   · sentinel 조건이 정말 0행인지 **먼저 SQL 로 확인**하고 쏜다.
//   · 기대 결과는 PostgreSQL 42501 permission denied.
//     2xx·204·RLS 로 인한 0행·400 은 fence 증거로 인정하지 않는다.
//
// 사용: node scripts/manual/prod-fence-verify.mjs
// ============================================================
import pg from "pg";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync, statSync, readdirSync, copyFileSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { readProdEnv, assertProdUrl, PROD_REF, refOf, scrub } from "./prod-url.mjs";

const PG_BIN = "C:/pgsql17/bin";
const BACKUP_ROOT = join(homedir(), "prod-backups");
const EXPECT_USERS_SHA = "1af01ece257e646d822e2d23f98cb5ef4874dd2952cc0657cf23aef3e55760b9";
const EXPECT_OBJS_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const TABLES = ["comment_owners", "comments", "post_owners", "posts", "profiles"];
const SENTINEL_ID = -987654321;   // identity 시퀀스는 양수만 발급 → 절대 매칭 안 됨

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");

// anon 키는 .env.local (운영 ref 확인 완료). 값은 출력하지 않는다.
const envLocal = readFileSync(join(process.cwd(), ".env.local"), "utf8");
const pick = (k) => (envLocal.match(new RegExp(`^${k}=(.+)$`, "m")) || [])[1]?.trim();
const SUPA_URL = pick("NEXT_PUBLIC_SUPABASE_URL");
const ANON_KEY = pick("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
if (!SUPA_URL || !ANON_KEY) { console.error("[중단] .env.local 에 URL/키 없음"); process.exit(1); }
if (!SUPA_URL.includes(PROD_REF)) { console.error("[중단] .env.local 이 운영 ref 가 아님"); process.exit(3); }

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const line = (k, v) => console.log(`  ${String(k).padEnd(44)} ${v}`);
const head = (t) => console.log(`\n=== ${t} ===`);
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const results = [];
const rec = (n, ok, d) => { results.push(ok); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };
function stop(c, w) { console.error(`\n⛔ ${c}: ${w}`); throw Object.assign(new Error(c), { blocked: true }); }

async function dataState() {
  const g = async (q) => (await client.query(q)).rows[0];
  const s = { tables: {} };
  for (const t of TABLES) s.tables[t] = Number((await g(`select count(*) v from public.${t}`)).v);
  s.users = Number((await g(`select count(*) v from auth.users`)).v);
  s.idents = Number((await g(`select count(*) v from auth.identities`)).v);
  s.buckets = Number((await g(`select count(*) v from storage.buckets`)).v);
  s.objects = Number((await g(`select count(*) v from storage.objects`)).v);
  s.usersSha = sha256((await client.query(`select id::text from auth.users order by id`)).rows.map((r) => r.id).join("\n"));
  s.objsSha = sha256((await client.query(`select bucket_id, name from storage.objects order by bucket_id, name`))
    .rows.map((o) => `${o.bucket_id} ${o.name}`).join("\n"));
  return s;
}

async function main() {
  await client.connect();

  head("0. 기준 상태");
  await client.query("begin transaction isolation level repeatable read read only");
  const st0 = await dataState();
  // sentinel 조건이 정말 0행인지 확인하고 나서 probe 한다.
  const sent = (await client.query(`select count(*)::int n from public.posts where id = $1`, [SENTINEL_ID])).rows[0].n;
  line("sentinel 매칭 행", `${sent}${sent === 0 ? " ✅ (파괴 위험 없음)" : " ⛔"}`);
  if (sent !== 0) stop("PROBE_SENTINEL_UNSAFE", "sentinel 이 실제 행과 매칭됨");
  await client.query("rollback");

  // ── 7.1 anon REST probe ──────────────────────────────────────
  head("7.1 anon REST mutation probe (zero-match DELETE)");
  const res = await fetch(`${SUPA_URL}/rest/v1/posts?id=eq.${SENTINEL_ID}`, {
    method: "DELETE",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, Prefer: "count=exact" },
  });
  const bodyTxt = await res.text();
  let code = null;
  try { code = JSON.parse(bodyTxt).code; } catch {}
  line("HTTP status", res.status);
  line("PostgreSQL code", code ?? "(없음)");
  const anonPass = code === "42501";
  rec("anon DELETE 가 42501 permission denied", anonPass,
    anonPass ? "권한으로 차단됨" : `status=${res.status} code=${code ?? "none"} — fence 증거 불충분`);
  if (!anonPass) stop("ANON_REST_MUTATION_PROBE=FAIL", `기대 42501, 실제 status=${res.status} code=${code}`);

  // ── 7.2 authenticated probe (SQL role simulation) ────────────
  head("7.2 authenticated mutation probe");
  // 기존 세션 토큰을 안전하게 재사용할 방법이 없다. 새 로그인·magic link·token
  // refresh 는 금지돼 있으므로 SQL role simulation 으로 대체한다.
  await client.query("begin");
  let authPass = false, authCode = null;
  try {
    await client.query("set local role authenticated");
    await client.query(`delete from public.posts where false`);
  } catch (e) { authCode = e.code; authPass = e.code === "42501"; }
  finally { await client.query("rollback"); }
  line("PostgreSQL code", authCode ?? "(오류 없음)");
  rec("authenticated DELETE 가 42501", authPass, authPass ? "권한으로 차단됨" : `code=${authCode ?? "none"}`);
  if (!authPass) stop("AUTHENTICATED_MUTATION_PROBE=FAIL", `기대 42501, 실제 ${authCode}`);
  console.log("  AUTHENTICATED_FENCE_PROBE=SQL_ROLE_SIMULATION_NO_EXISTING_TOKEN");

  // ── 7.3 routine / sequence (카탈로그, 실행 안 함) ─────────────
  head("7.3 routine · sequence (카탈로그 확인, mutation RPC 미실행)");
  await client.query("begin transaction isolation level repeatable read read only");
  for (const r of ["anon", "authenticated"]) {
    const f = (await client.query(
      `select count(*)::int n from pg_proc p join pg_namespace nn on nn.oid = p.pronamespace
        where nn.nspname = 'public' and has_function_privilege($1, p.oid, 'EXECUTE')`, [r])).rows[0].n;
    const s = (await client.query(
      `select count(*)::int n from (values ('comments_id_seq'),('posts_id_seq')) v(x)
        where has_sequence_privilege($1, 'public.'||v.x, 'USAGE')
           or has_sequence_privilege($1, 'public.'||v.x, 'UPDATE')`, [r])).rows[0].n;
    const c = (await client.query(`select has_schema_privilege($1,'public','CREATE') x`, [r])).rows[0].x;
    rec(`${r}: routine EXECUTE=0 / sequence=0 / schema CREATE=false`,
      f === 0 && s === 0 && c === false, `${f} / ${s} / ${c}`);
  }

  // probe 직후 데이터 불변 확인
  const st1 = await dataState();
  await client.query("rollback");
  const same = TABLES.every((t) => st1.tables[t] === st0.tables[t])
    && st1.users === st0.users && st1.idents === st0.idents
    && st1.usersSha === EXPECT_USERS_SHA && st1.objsSha === EXPECT_OBJS_SHA;
  rec("probe 직후 데이터·fingerprint 불변", same);
  if (!same) stop("PROBE_SIDE_EFFECT=BLOCKED", "probe 후 데이터 변화");

  if (results.some((r) => !r)) stop("FENCE_VERIFY=FAIL", "probe 실패 항목 존재");

  // ── 10. fence 후 최종 data backup ────────────────────────────
  head("10. POST_FENCE_FINAL_PRE_RESET 백업");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
  const OUT = join(BACKUP_ROOT, `${stamp}_POSTFENCE`);
  mkdirSync(OUT, { recursive: true });
  try { execFileSync("icacls", [OUT, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:(OI)(CI)F`], { stdio: "ignore" }); } catch {}

  const uu = new URL(url);
  const PGENV = { ...process.env, PGHOST: uu.hostname, PGPORT: uu.port,
    PGUSER: decodeURIComponent(uu.username), PGPASSWORD: decodeURIComponent(uu.password),
    PGDATABASE: uu.pathname.replace(/^\//, "") || "postgres", PGSSLMODE: "require" };

  const fData = join(OUT, "data.sql");
  try {
    execFileSync(join(PG_BIN, "pg_dump.exe"), ["--data-only",
      "--schema=public", "--schema=auth", "--schema=storage",
      "--exclude-table=storage.buckets_vectors", "--exclude-table=storage.vector_indexes",
      "-f", fData], { env: PGENV, stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) { stop("POST_FENCE_FINAL_BACKUP=BLOCKED", "pg_dump 실패"); }
  line("data.sql", `${statSync(fData).size}B`);

  // COPY 블록 경계 파싱으로 행 수 확인
  const counts = {}; { let cur = null, n = 0;
    for (const l of readFileSync(fData, "utf8").split("\n")) {
      if (cur === null) { const m = /^COPY\s+([^\s(]+)\s*\(.*\)\s+FROM\s+stdin;\s*$/.exec(l); if (m) { cur = m[1].replace(/"/g, ""); n = 0; } }
      else if (l === "\\.") { counts[cur] = (counts[cur] ?? 0) + n; cur = null; } else n++;
    } }
  const expect = { "public.comment_owners": 1, "public.comments": 1, "public.post_owners": 2,
    "public.posts": 2, "public.profiles": 1, "auth.users": 1, "auth.identities": 1 };
  let ok = true;
  for (const [t, w] of Object.entries(expect)) { const g = counts[t] ?? 0; if (g !== w) ok = false; line(t, `${g}/${w} ${g === w ? "✅" : "⛔"}`); }
  const seqOk = /setval\('public\.comments_id_seq'/.test(readFileSync(fData, "utf8"))
    && /setval\('public\.posts_id_seq'/.test(readFileSync(fData, "utf8"));
  line("sequence state", seqOk ? "포함 ✅" : "누락 ⛔");
  if ((counts["auth.users"] ?? 0) !== 1 || (counts["auth.identities"] ?? 0) !== 1) stop("DATA_BACKUP_MISSING_AUTH=BLOCKED", "auth 행 누락");
  if (!ok || !seqOk) stop("POST_FENCE_FINAL_BACKUP=BLOCKED", "행수/시퀀스 불일치");

  const fManifest = join(OUT, "storage-manifest.json");
  writeFileSync(fManifest, JSON.stringify({
    manifest_version: 1, project_ref: PROD_REF, backup_class: "POST_FENCE_FINAL_PRE_RESET",
    captured_at_utc: new Date().toISOString(), bucket_count: 0, object_count: 0, total_bytes: 0,
    buckets: [], object_keys_sha256: EXPECT_OBJS_SHA, verification_docs_status: "NOT_PRESENT",
    physical_object_backup: "NOT_REQUIRED_ZERO_OBJECTS", source: "POSTGRES_STORAGE_CATALOG",
    transaction_read_only: "on", transaction_isolation: "repeatable read",
  }, null, 2));

  // fence 산출물 결속
  const fenceDirs = readdirSync(BACKUP_ROOT).filter((d) => d.endsWith("_FENCE")).sort();
  const FENCE = join(BACKUP_ROOT, fenceDirs[fenceDirs.length - 1]);
  for (const f of ["fence-acl-before.json", "fence-acl-after.json", "fence-rollback.sql", "fence-apply.sql"]) {
    if (existsSync(join(FENCE, f))) copyFileSync(join(FENCE, f), join(OUT, f));
  }

  const preDirs = readdirSync(BACKUP_ROOT).filter((d) => /^\d{4}-.*Z$/.test(d)).sort();
  const PRE = join(BACKUP_ROOT, preDirs[preDirs.length - 1]);
  const preReceipt = JSON.parse(readFileSync(join(PRE, "backup-receipt.json"), "utf8"));

  const fenceReceipt = {
    fence_applied_at_utc: new Date().toISOString(), project_ref: PROD_REF,
    scope: "ANON_AUTHENTICATED_PUBLIC_APP_MUTATION",
    fence_tables: 5, fence_sequences: 2, fence_routines: 8, schema_create: "PUBLIC_BLOCKED",
    anon_rest_mutation_probe: "PASS_42501",
    authenticated_mutation_probe: "PASS_SQL_ROLE_SIMULATION",
    auth_admin_write_fence: "NOT_APPLIED_MANAGED_ROLE_OUT_OF_SCOPE",
    storage_admin_write_fence: "NOT_APPLIED_MANAGED_ROLE_OUT_OF_SCOPE",
    service_role_write_fence: "NOT_APPLIED_TRUSTED_SERVER_ROLE_OUT_OF_SCOPE",
    rollback_available: "fence-rollback.sql",
  };
  writeFileSync(join(OUT, "fence-receipt.json"), JSON.stringify(fenceReceipt, null, 2));

  const composite = {
    backup_class: "POST_FENCE_FINAL_PRE_RESET",
    restore_set_class: "COMPOSITE_PRE_RESET",
    project_ref: PROD_REF, endpoint: "SESSION_POOLER_5432", toolchain: "PG17_NATIVE",
    composite_recovery_set: {
      "PRE_FENCE_INITIAL/roles.sql": preReceipt.files["roles.sql"].sha256,
      "PRE_FENCE_INITIAL/schema.sql": preReceipt.files["schema.sql"].sha256,
      "POST_FENCE_FINAL_PRE_RESET/data.sql": sha256File(fData),
      "POST_FENCE_FINAL_PRE_RESET/storage-manifest.json": sha256File(fManifest),
    },
    pre_fence_dir: basename(PRE), fence_dir: basename(FENCE),
    ROLE_PASSWORDS_INCLUDED: false, AUTH_DATA_INCLUDED: true,
    PRODUCTION_RESTORE_ATTEMPTED: false,
    RESTORE_VALIDATION_LEVEL: "STRUCTURAL_AND_CONTENT_COUNT_VALIDATED",
    data_row_counts: counts, sequence_state_included: seqOk,
    caution: "roles.sql 은 Supabase 관리형 프로젝트에 무검토 일괄 restore 하지 않는다.",
  };
  writeFileSync(join(OUT, "backup-receipt.json"), JSON.stringify(composite, null, 2));

  const files = readdirSync(OUT).filter((f) => f !== "SHA256SUMS.txt");
  writeFileSync(join(OUT, "SHA256SUMS.txt"), files.map((f) => `${sha256File(join(OUT, f))}  ${f}`).join("\n") + "\n");
  let sumsOk = true;
  for (const l of readFileSync(join(OUT, "SHA256SUMS.txt"), "utf8").trim().split("\n")) {
    const [h, n] = l.split(/\s+/); if (sha256File(join(OUT, n)) !== h) sumsOk = false;
  }
  rec("SHA256SUMS 재검증", sumsOk);
  if (!sumsOk) stop("BACKUP_INTEGRITY=FAIL", "해시 불일치");

  // ── 12. post-fence 최종 drift ────────────────────────────────
  head("12. post-fence 최종 drift 검사");
  await client.query("begin transaction isolation level repeatable read read only");
  const st2 = await dataState();
  const leak = (await client.query(
    `select count(*)::int n from (values ('anon'),('authenticated')) r(x),
            (values ('comment_owners'),('comments'),('post_owners'),('posts'),('profiles')) t(y)
      where has_table_privilege(r.x, 'public.'||t.y, 'INSERT')
         or has_table_privilege(r.x, 'public.'||t.y, 'UPDATE')
         or has_table_privilege(r.x, 'public.'||t.y, 'DELETE')`)).rows[0].n;
  await client.query("rollback");
  rec("fence vector 유지 (mutation 0)", leak === 0, `${leak}`);
  rec("public 행수 불변", TABLES.every((t) => st2.tables[t] === st0.tables[t]));
  rec("auth fingerprint 불변", st2.usersSha === EXPECT_USERS_SHA);
  rec("storage fingerprint 불변", st2.objsSha === EXPECT_OBJS_SHA);
  for (const p of ["/", "/login"]) {
    const r = await fetch(`https://snueapp.vercel.app${p}?cb=${Date.now()}${Math.random()}`, { redirect: "manual" });
    rec(`앱 ${p} 503 유지`, r.status === 503, String(r.status));
  }
  if (results.some((r) => !r)) stop("POST_FENCE_BACKUP_DRIFT=BLOCKED_FENCE_REMAINS", "drift 검출");

  console.log("");
  console.log("DB_WRITE_FENCE=PASS");
  console.log("FENCE_SCOPE=ANON_AUTHENTICATED_PUBLIC_APP_MUTATION");
  console.log("FENCE_TABLES=5 / FENCE_SEQUENCES=2 / FENCE_ROUTINES=8 / FENCE_SCHEMA_CREATE=PUBLIC_BLOCKED");
  console.log("ANON_REST_MUTATION_PROBE=PASS_42501");
  console.log("AUTHENTICATED_MUTATION_PROBE=PASS_SQL_ROLE_SIMULATION");
  console.log("AUTH_ADMIN_WRITE_FENCE=NOT_APPLIED_MANAGED_ROLE_OUT_OF_SCOPE");
  console.log("STORAGE_ADMIN_WRITE_FENCE=NOT_APPLIED_MANAGED_ROLE_OUT_OF_SCOPE");
  console.log("SERVICE_ROLE_WRITE_FENCE=NOT_APPLIED_TRUSTED_SERVER_ROLE_OUT_OF_SCOPE");
  console.log("POST_FENCE_FINAL_BACKUP=PASS");
  console.log("BACKUP_CLASS=POST_FENCE_FINAL_PRE_RESET");
  console.log("RESTORE_SET_CLASS=COMPOSITE_PRE_RESET");
  console.log("BACKUP_TOOLCHAIN=PG17_NATIVE / BACKUP_ENDPOINT=SESSION_POOLER_5432 / BACKUP_DRIFT=NONE");
  console.log(`AUTH_USERS=${st2.users} / AUTH_IDENTITIES=${st2.idents} / STORAGE_BUCKETS=${st2.buckets} / STORAGE_OBJECTS=${st2.objects}`);
  console.log("PROD_DB_READ=YES / PROD_DB_WRITE=YES_ACL_FENCE_ONLY");
  console.log("RESET_EXECUTED=NO / MIGRATIONS_EXECUTED=NO");
  console.log("NEXT_STAGE=STOPPED_BEFORE_PROD_RESET");
  console.log(`POSTFENCE_DIR=${basename(OUT)}`);
  console.log(`DATA_SHA256=${sha256File(fData)}`);
  console.log(`MANIFEST_SHA256=${sha256File(fManifest)}`);
}

main().then(() => client.end()).catch(async (e) => {
  if (!e.blocked) console.error("[fail] " + scrub(e.message || String(e), url));
  try { await client.end(); } catch {}
  process.exit(e.blocked ? 3 : 1);
});
