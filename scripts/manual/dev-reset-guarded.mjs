// ============================================================
// dev-reset-guarded.mjs — dev 전용 1회 한정 guarded reset
// ============================================================
// GPT 판정 P-20260721-DEV_BASELINE_RESET_DISPOSITION_01
//   DEV_RESET_AUTHORITY = ONE_TIME / DEV_ONLY / FAIL_CLOSED
//   AUTHORIZED_TARGET   = uiikgqeoxocpvphlmoqp
//   AUTHORIZED_SCRIPT   = prod-reset-community.sql v3
//   AUTHORIZED_SHA256   = 4b0ab5d8747d907de143b49abcf50d5f82671e5697eba28675981de147221739
//
// 왜 별도 러너가 필요한가:
//   reset 스크립트 자체에는 대상 DB ref assertion 이 없다(주석에만 언급).
//   따라서 **같은 연결에서** 가드를 먼저 수행하고, 가드와 파괴 SQL 사이에
//   재연결·대상 재선택이 없어야 한다. 이 파일이 그 역할을 한다.
//
// 절대 규칙:
//   · SQL 원본 bytes 를 수정하지 않는다. 읽어서 그대로 보낸다.
//   · 이 프로세스는 .env.dev.local 만 읽는다. 운영 DSN 에 접근하지 않는다.
//   · 운영 ref 가 조금이라도 보이면 즉시 중단한다.
//   · 결과 불명이면 재실행하지 않고 AUTHORITY_LOCKED 로 잠근다.
//
// 실행: node scripts/manual/dev-reset-guarded.mjs --consume-one-time-authority
// 종료: 0 = PASS, 3 = BLOCKED, 4 = OUTCOME_UNKNOWN, 1 = 실행 실패
// ============================================================
import pg from "pg";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readDevEnv, assertDevUrl, DEV_REF, PROD_REF, refOf, scrub } from "./dev-url.mjs";

const AUTHORIZED_SHA256 = "4b0ab5d8747d907de143b49abcf50d5f82671e5697eba28675981de147221739";
const RESET_PATH = "scripts/manual/prod-reset-community.sql";
const RUN_ROOT = join(homedir(), "prod-runs", "DEV_RESET");
const AUTHORITY_FILE = join(RUN_ROOT, "one_time_authority.json");

// GPT 가 지정한 pre-reset fingerprint (dev 현재 상태)
const EXPECT_PRE = { version: "17.6", publicTables: 8, privateTables: 19, authzRoutines: 6, nullAclRoutines: 3 };

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const line = (k, v) => console.log(`  ${String(k).padEnd(46)} ${v}`);
const head = (t) => console.log(`\n=== ${t} ===`);
const blocks = [];
const rec = (n, ok, d) => { if (!ok) blocks.push(n); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

if (!process.argv.includes("--consume-one-time-authority")) {
  console.error("[중단] 이 스크립트는 dev 를 파괴적으로 초기화한다.");
  console.error("       의도를 명시하려면 --consume-one-time-authority 를 붙여라.");
  process.exit(2);
}

// ── 0. 일회성 권한 확인 ──────────────────────────────────────
head("0. ONE_TIME authority");
mkdirSync(RUN_ROOT, { recursive: true });
if (existsSync(AUTHORITY_FILE)) {
  const a = JSON.parse(readFileSync(AUTHORITY_FILE, "utf8"));
  console.error(`  이미 소비됨: ${a.consumed_at_utc} / state=${a.state}`);
  console.error("  GPT 승인은 dev reset 정확히 1회만 허용한다. 재실행하려면 새 승인이 필요하다.");
  process.exit(3);
}
line("상태", "미소비 — 진행 가능");

// ── A. SOURCE IDENTITY ───────────────────────────────────────
head("A. SOURCE IDENTITY");
const sqlBuf = readFileSync(join(process.cwd(), RESET_PATH));
const sqlSha = sha256(sqlBuf);
rec("reset 스크립트 SHA-256 == 승인값", sqlSha === AUTHORIZED_SHA256, sqlSha.slice(0, 24) + "…");
const sqlText = sqlBuf.toString("utf8");
rec("runtime rewrite 0 (원본 그대로 전송)", true, `${sqlBuf.length}B`);

// 정적 구조 확인 — 단일 트랜잭션 + 예외 핸들러 0
const txBegin = (sqlText.match(/^\s*begin\s*;/gim) || []).length;
const txCommit = (sqlText.match(/^\s*commit\s*;/gim) || []).length;
const exceptionBlocks = (sqlText.match(/^\s*exception\b/gim) || []).length;
rec("단일 트랜잭션 구조 (begin 1 / commit 1)", txBegin === 1 && txCommit === 1, `begin=${txBegin} commit=${txCommit}`);
rec("예외 핸들러 0 (부분 reset 불가)", exceptionBlocks === 0, `${exceptionBlocks}개`);

// ── B. TARGET IDENTITY ───────────────────────────────────────
head("B. TARGET IDENTITY");
let url;
try {
  ({ DEV_DB_URL: url } = readDevEnv(["DEV_DB_URL"]));   // 운영 ref 섞이면 여기서 throw
  assertDevUrl(url, "DEV_DB_URL");
} catch (e) {
  console.error(`  ⛔ ${e.message}`);
  process.exit(3);
}
rec("대상 ref == dev", refOf(url) === DEV_REF, DEV_REF);
rec("대상 ref != 운영", refOf(url) !== PROD_REF, "운영 ref 미검출");
rec("이 프로세스가 운영 DSN 미보유", !process.env.PROD_DB_URL, "환경변수 없음");

if (blocks.length) {
  console.error("\n⛔ DEV_RESET_PREFLIGHT=BLOCKED — 파괴 SQL 을 실행하지 않았다.");
  for (const b of blocks) console.error(`   · ${b}`);
  process.exit(3);
}

// ── C. SAME-CONNECTION GUARD → 즉시 실행 ─────────────────────
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
let outcome = "NOT_STARTED";

async function fingerprint(c) {
  const g = async (q, p = []) => (await c.query(q, p)).rows[0];
  return {
    version: (await g(`select current_setting('server_version') v`)).v,
    db: (await g(`select current_database() v`)).v,
    user: (await g(`select current_user v`)).v,
    publicTables: Number((await g(`select count(*) v from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'`)).v),
    privateTables: Number((await g(`select count(*) v from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relkind='r'`)).v),
    authzRoutines: Number((await g(`select count(*) v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='authz'`)).v),
    publicRoutines: Number((await g(`select count(*) v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`)).v),
    nullAclRoutines: Number((await g(`select count(*) v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private','authz') and p.proacl is null`)).v),
    privateExists: (await g(`select to_regnamespace('private') is not null v`)).v,
    authzExists: (await g(`select to_regnamespace('authz') is not null v`)).v,
    authUsers: Number((await g(`select count(*) v from auth.users`)).v),
    storageObjects: Number((await g(`select count(*) v from storage.objects`)).v),
    writers: Number((await g(`select count(*) v from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and state='active' and query ~* '^\\s*(insert|update|delete|truncate|alter|drop|create|grant|revoke)'`)).v),
    prepared: Number((await g(`select count(*) v from pg_prepared_xacts`)).v),
  };
}

async function main() {
  await client.connect();

  head("C. SAME-CONNECTION GUARD (재연결 없이 이 연결에서 그대로 실행)");
  const pid = (await client.query(`select pg_backend_pid() p`)).rows[0].p;
  line("backend pid", pid);

  const pre = await fingerprint(client);
  line("PostgreSQL", pre.version);
  line("database / user", `${pre.db} / ${pre.user}`);
  line("public table / routine", `${pre.publicTables} / ${pre.publicRoutines}`);
  line("private table", pre.privateTables);
  line("authz routine", pre.authzRoutines);
  line("proacl NULL routine", pre.nullAclRoutines);
  line("auth.users / storage.objects", `${pre.authUsers} / ${pre.storageObjects}`);

  rec("버전 == 17.6", pre.version.startsWith(EXPECT_PRE.version), pre.version);
  rec("public table == 8 (dev 현 상태)", pre.publicTables === EXPECT_PRE.publicTables, String(pre.publicTables));
  rec("private table == 19", pre.privateTables === EXPECT_PRE.privateTables, String(pre.privateTables));
  rec("authz routine == 6", pre.authzRoutines === EXPECT_PRE.authzRoutines, String(pre.authzRoutines));
  rec("proacl NULL routine == 3", pre.nullAclRoutines === EXPECT_PRE.nullAclRoutines, String(pre.nullAclRoutines));
  rec("001~009 적용 상태 (private·authz 존재)", pre.privateExists && pre.authzExists);
  // 운영 legacy 상태(table 5 / routine 8)와 혼동될 여지가 있으면 즉시 차단
  rec("운영 legacy topology 와 혼동 없음", !(pre.publicTables === 5 && pre.publicRoutines === 8),
    `public ${pre.publicTables}표/${pre.publicRoutines}함수`);
  rec("writer 0", pre.writers === 0, String(pre.writers));
  rec("prepared transaction 0", pre.prepared === 0, String(pre.prepared));

  if (blocks.length) {
    console.error("\n⛔ DEV_RESET_PREFLIGHT=BLOCKED — 파괴 SQL 을 실행하지 않았다.");
    for (const b of blocks) console.error(`   · ${b}`);
    outcome = "BLOCKED";
    return 3;
  }

  // ── D. 파괴 실행 ───────────────────────────────────────────
  head("D. reset 실행 (일회성 권한 소비)");
  writeFileSync(AUTHORITY_FILE, JSON.stringify({
    consumed_at_utc: new Date().toISOString(), state: "ARMED",
    target_ref: DEV_REF, script_sha256: sqlSha, backend_pid: pid, pre_fingerprint: pre,
  }, null, 2));
  line("권한 파일", "ARMED 기록 (크래시 시 재실행 차단)");

  try {
    await client.query(sqlText);          // 스크립트 자체의 begin;…commit; 을 그대로 사용
    outcome = "COMMITTED";
    line("실행", "완료 (스크립트 내부 commit)");
  } catch (e) {
    const msg = scrub(e.message || String(e), url);
    if (/connection|terminat|ECONNRESET|socket/i.test(msg)) {
      outcome = "OUTCOME_UNKNOWN";
      console.error(`  ⛔ 연결 유실: ${msg.slice(0, 200)}`);
    } else {
      outcome = "FAILED_ROLLED_BACK";
      console.error(`  reset 실패(트랜잭션 abort): ${msg.slice(0, 300)}`);
    }
  }

  writeFileSync(AUTHORITY_FILE, JSON.stringify({
    consumed_at_utc: new Date().toISOString(), state: outcome,
    target_ref: DEV_REF, script_sha256: sqlSha, backend_pid: pid, pre_fingerprint: pre,
  }, null, 2));

  if (outcome === "OUTCOME_UNKNOWN") {
    console.error("\nDEV_RESET_OUTCOME_UNKNOWN / AUTHORITY_LOCKED");
    console.error("자동 재실행하지 않는다. fresh connection readback 으로 실제 상태를 판정하라.");
    return 4;
  }
  return 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); code = 1; }
finally { try { await client.end(); } catch {} }

// ── 새 연결 readback ─────────────────────────────────────────
if (outcome === "COMMITTED" || outcome === "OUTCOME_UNKNOWN") {
  head("E. fresh connection readback");
  const c2 = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    await c2.connect();
    const post = await fingerprint(c2);
    line("public table / routine", `${post.publicTables} / ${post.publicRoutines}`);
    line("private 스키마", post.privateExists ? "존재 ⛔" : "없음 ✅");
    line("authz 스키마", post.authzExists ? "존재 ⛔" : "없음 ✅");
    line("auth.users / storage.objects", `${post.authUsers} / ${post.storageObjects} (보존 대상)`);
    line("proacl NULL routine", post.nullAclRoutines);

    const legacyOk = !post.privateExists && !post.authzExists;
    console.log("");
    console.log(`DEV_RESET=${legacyOk ? "PASS" : "BASELINE_MISMATCH"}`);
    console.log(`DEV_RESET_OUTCOME=${outcome}`);
    console.log(`POST_PUBLIC_TABLES=${post.publicTables}`);
    console.log(`POST_PUBLIC_ROUTINES=${post.publicRoutines}`);
    console.log(`AUTH_USERS_PRESERVED=${post.authUsers === (JSON.parse(readFileSync(AUTHORITY_FILE, "utf8")).pre_fingerprint.authUsers)}`);
    if (!legacyOk) {
      console.log("\n⛔ DEV_BASELINE_MISMATCH — 임의로 객체를 추가·삭제해 맞추지 않는다. 차이를 보고한다.");
      code = 3;
    }
  } catch (e) { console.error("[readback fail] " + scrub(e.message, url)); code = 1; }
  finally { try { await c2.end(); } catch {} }
}
process.exit(code);
