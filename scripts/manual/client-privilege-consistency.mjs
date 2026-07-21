// ============================================================
// client-privilege-consistency.mjs — 클라이언트 접근 ↔ 마이그레이션 권한 정합성
// ============================================================
// 007 이 회수하는 posts.deleted_at / comments.deleted_at 컬럼 UPDATE 를
// 클라이언트가 그대로 직접 UPDATE 하고 있었다. 배포하면 사용자가 자기 글을
// 지울 수 없다. 같은 종류가 더 있는지 전수로 본다.
//
// 방법
//   1. 001~009 에서 anon·authenticated 대상 REVOKE 를 전부 뽑는다
//      (테이블 단위 / 컬럼 단위 / 함수 단위)
//   2. 브라우저 클라이언트가 실제로 접근하는 테이블·연산·컬럼을 뽑는다
//      (.from("t").select/insert/update/delete, .rpc("f"))
//   3. 교차 대조해 "회수됐는데 클라이언트가 쓰는" 것을 찾는다
//
// READ-ONLY. DB 에 접속하지 않는다. 파일만 읽는다.
//
// 한계를 먼저 적는다 — 정적 분석이라 동적으로 조립되는 테이블명이나
// 서버 액션 경유 접근은 놓칠 수 있다. 놓친 것을 0 이라고 주장하지 않는다.
// ============================================================
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const ROOT = process.cwd();
const MIGDIR = join(ROOT, "supabase/migrations");
const OUT = join(homedir(), "prod-runs", "CLIENT_PRIVILEGE_CONSISTENCY");
// 브라우저(=anon/authenticated 키)로 도는 코드만 본다.
// app/lib/server/** 는 service_role 이므로 fence 대상이 아니다.
const CLIENT_ROOTS = ["app"];
const SERVER_ONLY = /[\\/]lib[\\/]server[\\/]/;
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(44)} ${v}`);

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|jsx|ts|tsx|mjs)$/.test(e)) out.push(p);
  }
  return out;
};

// ── 1. 마이그레이션의 anon·authenticated REVOKE ─────────────
head("1. 001~009 의 anon·authenticated 대상 REVOKE");
const revokes = [];
for (const f of readdirSync(MIGDIR).filter((x) => /^\d{3}_.*\.sql$/.test(x)).sort()) {
  const sql = readFileSync(join(MIGDIR, f), "utf8");
  for (const m of sql.matchAll(
    /revoke\s+([\s\S]{1,200}?)\s+on\s+([\s\S]{1,160}?)\s+from\s+([a-z_,\s]+?)\s*;/gi)) {
    const grantees = m[3].split(",").map((s) => s.trim().toLowerCase());
    if (!grantees.some((g) => ["anon", "authenticated", "public"].includes(g))) continue;
    const priv = m[1].replace(/\s+/g, " ").trim();
    const target = m[2].replace(/\s+/g, " ").trim();
    // 컬럼 단위인가: `update (deleted_at)` 형태
    const colM = /^(\w+)\s*\(([^)]+)\)$/.exec(priv);
    revokes.push({
      file: f, privilege: priv, target, grantees,
      scope: /^function\b/i.test(target) ? "FUNCTION" : colM ? "COLUMN" : "TABLE_OR_OTHER",
      operation: colM ? colM[1].toLowerCase() : priv.toLowerCase(),
      columns: colM ? colM[2].split(",").map((s) => s.trim()) : null,
    });
  }
}
const colRevokes = revokes.filter((r) => r.scope === "COLUMN");
const tableRevokes = revokes.filter((r) => r.scope === "TABLE_OR_OTHER");
line("전체 REVOKE (anon/auth/public 대상)", revokes.length);
line("  컬럼 단위", colRevokes.length);
line("  테이블·스키마 등", tableRevokes.length);
line("  함수 단위", revokes.length - colRevokes.length - tableRevokes.length);
for (const r of colRevokes)
  console.log(`    [컬럼] ${r.file}: ${r.operation.toUpperCase()} (${r.columns.join(",")}) on ${r.target} from ${r.grantees.join(",")}`);

// ── 2. 클라이언트 접근 ──────────────────────────────────────
head("2. 브라우저 클라이언트의 테이블 접근");
const files = CLIENT_ROOTS.flatMap((r) => walk(join(ROOT, r)))
  .filter((p) => !SERVER_ONLY.test(p));
const access = [];
for (const p of files) {
  const src = readFileSync(p, "utf8");
  if (!/supabase/.test(src)) continue;
  // .from("t") ... .op({...}) 형태를 순차 스캔한다.
  //
  // 주의 — 뒤따르는 문맥을 정규식으로 함께 소비하면 안 된다. matchAll 은
  // 매치가 겹치지 않으므로, 소비한 창(窓) 안에 있는 다음 .from() 호출이
  // 통째로 건너뛰어진다. 실제로 그렇게 짰다가 같은 파일의 posts.update 를
  // 놓쳤다. 위치만 찾고 문맥은 slice 로 따로 읽는다.
  for (const m of src.matchAll(/\.from\(\s*["'`](\w+)["'`]\s*\)/g)) {
    const table = m[1];
    const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 300);
    const opM = /\.\s*(select|insert|update|upsert|delete)\s*\(/.exec(tail);
    if (!opM) continue;
    const op = opM[1];
    // update/insert 는 객체 리터럴의 키가 곧 컬럼이다
    let cols = null;
    if (["update", "insert", "upsert"].includes(op)) {
      const objM = /\.\s*(?:update|insert|upsert)\s*\(\s*\{([^}]{0,300})\}/.exec(tail);
      if (objM) cols = [...objM[1].matchAll(/(\w+)\s*:/g)].map((x) => x[1]);
    }
    access.push({ file: relative(ROOT, p), table, operation: op, columns: cols });
  }
  for (const m of src.matchAll(/\.rpc\(\s*["'`](\w+)["'`]/g))
    access.push({ file: relative(ROOT, p), rpc: m[1], operation: "execute" });
}
const byTable = {};
for (const a of access) {
  if (!a.table) continue;
  const k = `${a.table}.${a.operation}`;
  (byTable[k] ??= new Set());
  for (const c of a.columns ?? []) byTable[k].add(c);
}
line("클라이언트 파일 (server 제외)", files.length);
line("테이블 접근 지점", access.filter((a) => a.table).length);
line("클라이언트 RPC 호출", access.filter((a) => a.rpc).length);
for (const [k, v] of Object.entries(byTable).sort())
  console.log(`    ${k.padEnd(28)} ${v.size ? [...v].join(", ") : "(컬럼 미지정)"}`);

// ── 3. 교차 대조 ────────────────────────────────────────────
head("3. 교차 대조 — 회수됐는데 클라이언트가 쓰는 것");
const conflicts = [];
for (const r of colRevokes) {
  const tbl = r.target.replace(/^public\./, "");
  for (const [k, cols] of Object.entries(byTable)) {
    const [t, op] = k.split(".");
    if (t !== tbl && `public.${t}` !== r.target) continue;
    if (op !== r.operation && !(op === "upsert" && r.operation === "update")) continue;
    const hit = r.columns.filter((c) => cols.has(c));
    if (hit.length) conflicts.push({
      severity: "BREAKS_CLIENT", revoke: `${r.file}: ${r.privilege} on ${r.target} from ${r.grantees.join(",")}`,
      client: `${t}.${op}({${[...cols].join(", ")}})`, conflicting_columns: hit,
    });
  }
}
if (conflicts.length === 0) console.log("  충돌 없음");
for (const c of conflicts) {
  console.log(`  ⛔ ${c.severity}`);
  console.log(`     회수: ${c.revoke}`);
  console.log(`     사용: ${c.client}`);
  console.log(`     충돌 컬럼: ${c.conflicting_columns.join(", ")}`);
}

head("4. 정적 분석의 한계 (0 이라고 주장하지 않는 것)");
const limits = [
  "테이블명이 변수로 조립되면 탐지하지 못한다",
  "서버 액션·라우트 핸들러 경유 접근은 service_role 일 수도 anon 일 수도 있어 별도 확인이 필요하다",
  "update({...spread}) 처럼 컬럼이 동적으로 들어가면 컬럼 목록이 불완전하다",
  "RLS 정책 위반은 권한과 별개 경로라 여기서 판정하지 않는다",
];
for (const l of limits) console.log("  · " + l);

const out = {
  document: "CLIENT_PRIVILEGE_CONSISTENCY",
  method: "정적 분석 (DB 미접속). 마이그레이션 REVOKE ↔ 브라우저 클라이언트 접근 대조.",
  scope: "app/** 중 lib/server/** 제외 (server 는 service_role 이라 fence 대상 아님)",
  revokes_against_anon_auth_public: revokes,
  client_access: access,
  client_rpc_calls: access.filter((a) => a.rpc).map((a) => a.rpc),
  conflicts,
  conflict_count: conflicts.length,
  analysis_limitations: limits,
};
mkdirSync(OUT, { recursive: true });
const buf = Buffer.from(JSON.stringify(out, null, 2));
writeFileSync(join(OUT, "CLIENT_PRIVILEGE_CONSISTENCY.json"), buf);

head("판정");
console.log(`\nCLIENT_PRIVILEGE_CONSISTENCY=${conflicts.length ? "CONFLICT_FOUND" : "NO_CONFLICT_DETECTED"}`);
console.log(`CONFLICT_COUNT=${conflicts.length}`);
console.log(`CLIENT_RPC_CALLS=${access.filter((a) => a.rpc).length}`);
console.log(`SHA256=${createHash("sha256").update(buf).digest("hex")}`);
console.log(`OUT=${join(OUT, "CLIENT_PRIVILEGE_CONSISTENCY.json")}`);
