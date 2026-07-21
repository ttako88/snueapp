// ============================================================
// routine-security-audit.mjs — 001~009 routine 보안 감사 (READ-ONLY, DB 미접속)
// ============================================================
// GPT P-20260721 §5·§6 대응.
//   - SECURITY DEFINER 함수 전수와 그 위험 표면
//   - 고정 search_path 여부
//   - PUBLIC/anon/authenticated/service_role EXECUTE 최종 상태
//   - 쓰기 수행 여부
//   - 최종 allowlist 산출
//
// 소스에서 산출한다. dev 에는 001~005 만 적용돼 있어 006~009 함수가 없고,
// 운영에는 아직 아무것도 없기 때문이다. 소스가 유일한 전수 근거다.
//
// 한계를 먼저 적는다 — 소스 파싱은 실제 카탈로그 상태가 아니다.
// 배포 후에는 반드시 DB 실측으로 재확인해야 한다.
// ============================================================
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const MIGDIR = join(process.cwd(), "supabase/migrations");
const OUT = join(homedir(), "prod-runs", "ROUTINE_SECURITY_AUDIT");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(46)} ${v}`);

const files = readdirSync(MIGDIR).filter((f) => /^00\d_.*\.sql$/.test(f)).sort();

// ── 1. 함수 정의 수집 ────────────────────────────────────────
const routines = [];
for (const f of files) {
  const sql = readFileSync(join(MIGDIR, f), "utf8");
  // create [or replace] function <schema>.<name>(<args>) ... as $$ ... $$
  const re = /create\s+(?:or\s+replace\s+)?function\s+([a-z_]+)\.([a-z0-9_]+)\s*\(([^)]*)\)([\s\S]{0,400}?)\bas\s+\$/gi;
  for (const m of sql.matchAll(re)) {
    const [, schema, name, args, opts] = m;
    // 본문 추출 — $$ ... $$ 또는 $tag$ ... $tag$
    const bodyStart = sql.indexOf("$", m.index + m[0].length - 1);
    const tagM = /^\$[A-Za-z_]*\$/.exec(sql.slice(bodyStart));
    let body = "";
    if (tagM) {
      const tag = tagM[0];
      const end = sql.indexOf(tag, bodyStart + tag.length);
      body = end < 0 ? "" : sql.slice(bodyStart + tag.length, end);
    }
    routines.push({
      file: f, schema, name,
      args: args.replace(/\s+/g, " ").trim(),
      signature: `${schema}.${name}(${args.replace(/\s+/g, " ").trim()})`,
      security_definer: /security\s+definer/i.test(opts),
      search_path_set: /set\s+search_path\s*=/i.test(opts),
      search_path_value: (/set\s+search_path\s*=\s*('[^']*'|\S+)/i.exec(opts) || [])[1] ?? null,
      volatility: (/\b(immutable|stable|volatile)\b/i.exec(opts) || [])[1]?.toLowerCase() ?? "volatile(기본)",
      performs_write: /\b(insert\s+into|update\s+\w|delete\s+from|truncate)\b/i.test(body),
      uses_auth_uid: /auth\.uid\s*\(\s*\)/i.test(body),
      dynamic_sql: /\bexecute\s+(format\s*\(|'|\w)/i.test(body),
      body_bytes: body.length,
    });
  }
}

// ── 2. EXECUTE 권한 최종 상태 산출 ───────────────────────────
// 파일 순서대로 revoke/grant 를 적용해 최종 상태를 만든다.
// NULL proacl 의 암묵 PUBLIC EXECUTE 가 출발점이다.
const exec = new Map();   // signature-ish key → Set(role)
const keyOf = (schema, name) => `${schema}.${name}`;
for (const r of routines) if (!exec.has(keyOf(r.schema, r.name))) exec.set(keyOf(r.schema, r.name), new Set(["PUBLIC"]));

const applyAcl = (verb, target, roles) => {
  const t = target.toLowerCase().replace(/^function\s+/, "").replace(/\s*\(.*\)$/, "").trim();
  for (const [k, set] of exec) {
    const matchExact = k.toLowerCase() === t;
    const matchAll = /^all\s+functions\s+in\s+schema\s+([a-z_]+)/.exec(t);
    const matchSchema = matchAll && k.toLowerCase().startsWith(matchAll[1] + ".");
    if (!matchExact && !matchSchema) continue;
    for (const role of roles) {
      if (verb === "revoke") set.delete(role);
      else set.add(role);
    }
  }
};
for (const f of files) {
  const sql = readFileSync(join(MIGDIR, f), "utf8");
  for (const m of sql.matchAll(
    /\b(revoke|grant)\s+execute\s+on\s+function\s+([\s\S]{1,160}?)\s+(?:from|to)\s+([a-z_,\s]+?)\s*;/gi)) {
    const roles = m[3].split(",").map((s) => s.trim().toLowerCase())
      .map((s) => s === "public" ? "PUBLIC" : s);
    applyAcl(m[1].toLowerCase(), m[2], roles);
  }
  // 008·009 의 동적 루프 — private 함수 전체 대상
  if (/revoke execute on function private\.%I/i.test(sql))
    for (const [k, set] of exec)
      if (k.startsWith("private.")) { set.delete("PUBLIC"); set.delete("anon"); set.delete("authenticated"); }
  if (/from public, anon, authenticated, service_role/i.test(sql) && /n\.nspname\s*=\s*'private'/i.test(sql))
    for (const [k, set] of exec) if (k.startsWith("private.")) set.delete("service_role");
}

head("1. routine 전수");
line("정의된 함수(중복 이름 포함)", routines.length);
line("고유 이름", exec.size);
const definers = routines.filter((r) => r.security_definer);
line("SECURITY DEFINER", definers.length);
line("  그중 search_path 고정", definers.filter((r) => r.search_path_set).length);
line("  그중 쓰기 수행", definers.filter((r) => r.performs_write).length);
line("  그중 auth.uid() 사용", definers.filter((r) => r.uses_auth_uid).length);
line("  그중 동적 SQL", definers.filter((r) => r.dynamic_sql).length);

head("2. SECURITY DEFINER 중 search_path 미고정 (위험)");
const unsafe = definers.filter((r) => !r.search_path_set);
if (unsafe.length === 0) console.log("  없음 — DEFINER 전부 search_path 고정");
for (const r of unsafe) console.log(`  ⛔ ${r.signature}  (${r.file})`);

head("3. 최종 EXECUTE 상태 (소스 순서 적용 결과)");
const exposed = { PUBLIC: [], anon: [], authenticated: [], service_role: [] };
for (const [k, set] of [...exec].sort())
  for (const role of set) if (exposed[role]) exposed[role].push(k);
for (const role of ["PUBLIC", "anon", "authenticated", "service_role"])
  line(`${role} EXECUTE`, exposed[role].length);

head("4. anon·authenticated·PUBLIC 노출 상세");
for (const role of ["PUBLIC", "anon", "authenticated"]) {
  if (!exposed[role].length) { console.log(`  ${role}: 없음`); continue; }
  console.log(`  ${role}: ${exposed[role].length}건`);
  for (const s of exposed[role].slice(0, 20)) console.log(`    · ${s}`);
}

head("5. 최종 allowlist 제안");
const allowAuth = ["public.soft_delete_post(bigint)", "public.soft_delete_comment(bigint)"];
console.log("  AUTHENTICATED_EXECUTE_ALLOWLIST:");
for (const a of allowAuth) console.log(`    · ${a}`);
console.log("  ANON_EXECUTE_ALLOWLIST   = EMPTY");
console.log("  PUBLIC_EXECUTE_ALLOWLIST = EMPTY");
const svcRoutines = routines.filter((r) =>
  r.schema === "public" && exec.get(keyOf(r.schema, r.name))?.has("service_role"));
console.log(`  SERVICE_ROLE_EXECUTE_ALLOWLIST: ${svcRoutines.length}건 (009 의도 + 앱 서버 의존)`);
for (const r of svcRoutines.slice(0, 20)) console.log(`    · ${r.signature}`);

head("6. 한계");
const limits = [
  "소스 파싱 결과이지 카탈로그 실측이 아니다. 배포 후 DB 실측으로 재확인해야 한다.",
  "동적 루프(008·009)의 대상은 패턴으로 근사했다. 실제 대상 집합은 실행 시점 카탈로그가 정한다.",
  "default privilege 로 생성 시 부여되는 EXECUTE 는 여기 반영되지 않는다 — public 스키마 함수는 생성 직후 PUBLIC·anon·authenticated EXECUTE 를 갖는다(별도 실측 확인됨).",
  "오버로드가 있는 이름은 signature 단위가 아니라 이름 단위로 집계했다.",
];
for (const l of limits) console.log("  · " + l);

const out = {
  document: "ROUTINE_SECURITY_AUDIT",
  method: "001~009 소스 정적 분석 (DB 미접속)",
  routine_count: routines.length,
  distinct_names: exec.size,
  security_definer_count: definers.length,
  security_definer_without_fixed_search_path: unsafe.map((r) => r.signature),
  final_execute_state: exposed,
  proposed_allowlist: {
    authenticated: allowAuth,
    anon: [], PUBLIC: [],
    service_role: svcRoutines.map((r) => r.signature),
  },
  routines,
  limitations: limits,
};
mkdirSync(OUT, { recursive: true });
const buf = Buffer.from(JSON.stringify(out, null, 2));
writeFileSync(join(OUT, "ROUTINE_SECURITY_AUDIT.json"), buf);

head("판정");
console.log(`\nSECURITY_DEFINER=${definers.length} / SEARCH_PATH_UNFIXED=${unsafe.length}`);
console.log(`FINAL_PUBLIC_EXECUTE=${exposed.PUBLIC.length} ANON=${exposed.anon.length} AUTHENTICATED=${exposed.authenticated.length}`);
console.log(`SHA256=${createHash("sha256").update(buf).digest("hex")}`);
console.log(`OUT=${join(OUT, "ROUTINE_SECURITY_AUDIT.json")}`);
