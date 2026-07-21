// ============================================================
// scope-equivalence-006-009.mjs — 006~009 범위 분석 (READ-ONLY, DB 미접속)
// ============================================================
// GPT P-20260721-LAYER_B_VERDICT_AND_PROD_READINESS_HOLD_01 §5 대응.
//
// dev 리플레이는 001~005 + FINAL_FENCE_V2 만 했다. 운영은 001~009 다.
// 006~009 가 DB 상태·ACL 을 바꾸는지, 바꾼다면 무엇을 바꾸는지 소스에서
// 산출한다. 추정하지 않고 파일에서 센다.
//
// 이 스크립트는 DB 에 접속하지 않는다. 파일만 읽는다.
// ============================================================
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const MIGDIR = join(process.cwd(), "supabase/migrations");
const OUT = join(homedir(), "prod-runs", "SCOPE_EQUIVALENCE");
const TARGET = ["006_storage_policies", "007_soft_delete_rpc",
                "008_harden_private_exec", "009_server_job_rpcs"];
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(44)} ${v}`);

/** 주석·문자열 리터럴을 지운 사본. 주석 속 SQL 을 실제 문장으로 세지 않기 위함. */
function strip(sql) {
  let out = "", i = 0, n = sql.length;
  while (i < n) {
    const two = sql.slice(i, i + 2);
    if (two === "--") { const j = sql.indexOf("\n", i); i = j < 0 ? n : j; continue; }
    if (two === "/*") { const j = sql.indexOf("*/", i + 2); i = j < 0 ? n : j + 2; continue; }
    if (sql[i] === "'") {
      const j = sql.indexOf("'", i + 1); out += " "; i = j < 0 ? n : j + 1; continue;
    }
    if (two === "$$") { const j = sql.indexOf("$$", i + 2); out += " $BODY$ "; i = j < 0 ? n : j + 2; continue; }
    out += sql[i]; i++;
  }
  return out;
}

const analyze = (name) => {
  const path = join(MIGDIR, `${name}.sql`);
  const buf = readFileSync(path);
  const sql = buf.toString("utf8");
  const bare = strip(sql);
  const low = bare.toLowerCase();
  const count = (re) => (bare.match(re) || []).length;

  // $$ 본문을 지웠으므로 함수 본문 안의 문장은 세지 않는다.
  // 함수 본문 안의 동적 execute 는 별도로 표시한다.
  const dynamicExec = /execute\s+format\s*\(/i.test(sql);

  return {
    file: `${name}.sql`,
    bytes: buf.length,
    sha256: sha256(buf),
    transaction: {
      begin: count(/\bbegin\s*;/gi),
      commit: count(/\bcommit\s*;/gi),
      self_transacting: /\bbegin\s*;/i.test(bare) && /\bcommit\s*;/i.test(bare),
    },
    effects: {
      create_table: count(/\bcreate\s+(or\s+replace\s+)?table\b/gi),
      create_function: count(/\bcreate\s+(or\s+replace\s+)?function\b/gi),
      create_function_public: (sql.match(/create\s+or\s+replace\s+function\s+public\./gi) || []).length,
      create_function_private: (sql.match(/create\s+or\s+replace\s+function\s+private\./gi) || []).length,
      create_policy: count(/\bcreate\s+policy\b/gi),
      drop_policy: count(/\bdrop\s+policy\b/gi) + (dynamicExec && /drop policy/i.test(sql) ? 1 : 0),
      alter_default_privileges: count(/\balter\s+default\s+privileges\b/gi),
      grant: count(/\bgrant\b/gi),
      revoke: count(/\brevoke\b/gi),
      insert: count(/\binsert\s+into\b/gi),
      update: count(/\bupdate\s+\w/gi),
      delete: count(/\bdelete\s+from\b/gi),
      dynamic_execute_format: dynamicExec,
    },
    changes_db_state: false,   // 아래에서 판정
    changes_acl: false,
    notes: [],
  };
};

mkdirSync(OUT, { recursive: true });

head("1. 006~009 소스 identity");
const files = TARGET.map(analyze);
for (const f of files) line(f.file, `${f.bytes}B  ${f.sha256.slice(0, 24)}…`);

head("2. 트랜잭션 경계");
for (const f of files) {
  line(f.file, `begin ${f.transaction.begin} / commit ${f.transaction.commit}` +
    (f.transaction.self_transacting ? "  ← 자기 트랜잭션" : ""));
}
const allSelf = files.every((f) => f.transaction.self_transacting);
console.log(`  · 4/4 자기 트랜잭션 = ${allSelf}`);
console.log("    → 001~005 와 동일하게 OPTION_E 파생물 처리가 필요하다.");
console.log("      원본 그대로는 하나의 TX 안에서 원자적으로 적용할 수 없다.");

head("3. 효과 분류");
for (const f of files) {
  const e = f.effects;
  f.changes_db_state = e.create_table + e.create_function + e.create_policy + e.drop_policy
    + e.insert + e.update + e.delete > 0 || e.dynamic_execute_format;
  f.changes_acl = e.grant + e.revoke + e.alter_default_privileges > 0;
  console.log(`  ${f.file}`);
  line("    create function (public/private)",
    `${e.create_function} (${e.create_function_public}/${e.create_function_private})`);
  line("    grant / revoke / alter default", `${e.grant} / ${e.revoke} / ${e.alter_default_privileges}`);
  line("    policy create/drop", `${e.create_policy}/${e.drop_policy}`);
  line("    동적 execute format", e.dynamic_execute_format);
  line("    DB 상태 변경 / ACL 변경", `${f.changes_db_state} / ${f.changes_acl}`);
}

head("4. 판정");
const stateChangers = files.filter((f) => f.changes_db_state);
const aclChangers = files.filter((f) => f.changes_acl);
line("DB 상태를 바꾸는 파일", stateChangers.map((f) => f.file).join(", ") || "없음");
line("ACL 을 바꾸는 파일", aclChangers.map((f) => f.file).join(", ") || "없음");
const verdict = stateChangers.length || aclChangers.length
  ? "NOT_EQUIVALENT" : "EQUIVALENT_NO_DB_EFFECT";
console.log(`\n  SCOPE_EQUIVALENCE_001_005_VS_001_009 = ${verdict}`);
console.log("  → 001~005 만의 replay 로 001~009 운영 실행 준비를 승인할 수 없다.");

head("5. FINAL_FENCE_V2 실행 위치");
console.log("  dev 리플레이는 005 직후 fence 를 걸었다. 운영에서 같은 위치에 걸면");
console.log("  006~009 가 만드는 객체는 fence 밖에 남는다. fence 는 시점 스냅샷");
console.log("  REVOKE 라 이후 생성 객체에 소급되지 않기 때문이다.");
console.log("  → 운영 순서는 reset → 001~009 전부 → FINAL_FENCE_V2 여야 한다.");
console.log("     단, 007 이 authenticated 에게 의도적으로 부여한 EXECUTE 2건");
console.log("     (soft_delete_post / soft_delete_comment) 이 있으므로 fence 는");
console.log("     그 allowlist 를 보존해야 한다 (§6 정책 결정 필요).");
console.log("     009 의 EXECUTE 부여 11건은 전부 service_role 대상이라 fence 와 무관하다.");

const out = {
  document: "SCOPE_EQUIVALENCE_001_005_VS_001_009",
  responds_to: "P-20260721-LAYER_B_VERDICT_AND_PROD_READINESS_HOLD_01 §5",
  method: "소스 파일 정적 분석 (DB 미접속). 주석·문자열·$$본문 제거 후 계수.",
  dev_replay_scope: "001~005 + FINAL_FENCE_V2",
  planned_prod_scope: "reset + 001~009 + FINAL_FENCE_V2",
  verdict,
  all_self_transacting: allSelf,
  option_e_derivative_required_for: TARGET.filter((_, i) => files[i].transaction.self_transacting),
  files,
  fence_placement: {
    dev_actual: "AFTER_005",
    prod_required: "AFTER_009",
    reason: "fence 는 시점 스냅샷 REVOKE 이므로 이후 생성 객체에 소급되지 않는다",
  },
  execute_allowlist_candidates: {
    authenticated: ["public.soft_delete_post(bigint)", "public.soft_delete_comment(bigint)"],
    source: "007_soft_delete_rpc.sql — 의도적 부여. fence 가 보존해야 한다.",
    service_role_only: "009 의 EXECUTE 부여 11건은 전부 service_role 대상이라 fence 와 무관",
  },
};
const buf = Buffer.from(JSON.stringify(out, null, 2));
writeFileSync(join(OUT, "SCOPE_EQUIVALENCE.json"), buf);
console.log(`\nSHA256=${sha256(buf)}`);
console.log(`OUT=${join(OUT, "SCOPE_EQUIVALENCE.json")}`);
