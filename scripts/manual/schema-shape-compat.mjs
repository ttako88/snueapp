// ============================================================
// schema-shape-compat.mjs — 클라이언트 접근 ↔ 실제 스키마 형상 대조 (READ-ONLY)
// ============================================================
// 왜 이게 따로 필요한가
//   10번 보고서의 호환성 감사는 "회수된 권한 vs 클라이언트 사용" 만 봤다.
//   그래서 F-1(deleted_at 컬럼 권한 회수)은 잡았지만, 훨씬 단순하고
//   훨씬 치명적인 "그 테이블이 아직 존재하는가" 는 묻지 않았다.
//   실제로 public.profiles 는 새 스키마에 없고 posts.board 는 board_id 가
//   됐는데 클라이언트는 옛 이름을 그대로 쓴다. 권한을 아무리 정밀하게 봐도
//   형상이 어긋나면 앱은 죽는다.
//
// 무엇을 하는가
//   클라이언트 소스에서 .from("t") / .rpc("f") / 선택·기록 컬럼을 뽑고,
//   실제 DB 카탈로그와 대조해 없는 것을 전부 나열한다.
//
// READ-ONLY. begin read only 로 DB 가 강제한다.
// 대상 선택: --prod (기본) / --dev
// ============================================================
import pg from "pg";
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const USE_DEV = process.argv.includes("--dev");
const { readProdEnv, assertProdUrl } = await import("./prod-url.mjs");
const { readDevEnv, assertDevUrl } = await import("./dev-url.mjs");
const url = USE_DEV
  ? assertDevUrl(readDevEnv(["DEV_DB_URL"]).DEV_DB_URL, "DEV_DB_URL")
  : assertProdUrl(readProdEnv(["PROD_DB_URL"]).PROD_DB_URL, "PROD_DB_URL");

// 배포 대상 트리를 본다. ops 워크트리가 아니라 실제 릴리스본이어야 한다.
const APP_ROOT = process.env.APP_ROOT || join(homedir(), "Desktop", "클로드", "snue-release");
const OUT = join(homedir(), "prod-runs", "SCHEMA_SHAPE_COMPAT");
const SERVER_ONLY = /[\\/]lib[\\/]server[\\/]/;   // service_role 경로는 별도 축
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(46)} ${v}`);

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|jsx|ts|tsx|mjs)$/.test(e)) out.push(p);
  }
  return out;
};

/** 소스에서 테이블·RPC·컬럼 사용을 뽑는다 */
function scanClient(root) {
  const uses = [];
  for (const p of walk(join(root, "app")).filter((f) => !SERVER_ONLY.test(f))) {
    const src = readFileSync(p, "utf8");
    if (!/supabase/.test(src)) continue;
    const rel = relative(root, p);

    // .from("t") — 위치만 찾고 문맥은 slice 로 따로 읽는다.
    // 문맥을 정규식으로 함께 소비하면 같은 파일의 다음 .from() 이 통째로 건너뛰어진다.
    for (const m of src.matchAll(/\.from\(\s*["'`](\w+)["'`]\s*\)/g)) {
      const from = m.index + m[0].length;
      // 창을 고정 길이로 두면 다음 체인의 컬럼이 이 테이블에 잘못 붙는다
      // (comment_owners 에 post_id 가 붙는 식). 다음 .from( 또는 .rpc( 에서 끊는다.
      const nextChain = src.slice(from).search(/\.(?:from|rpc)\(/);
      const end = from + (nextChain === -1 ? 400 : Math.min(nextChain, 400));
      const tail = src.slice(from, end);
      const cols = new Set();
      // .select("a, b, c")
      const sel = /\.\s*select\s*\(\s*["'`]([^"'`]*)["'`]/.exec(tail);
      if (sel) for (const cRaw of sel[1].split(",")) {
        const cn = cRaw.trim().split(/[\s(]/)[0];
        if (cn && cn !== "*") cols.add(cn);
      }
      // .insert({a, b}) / .update({a})
      const obj = /\.\s*(?:insert|update|upsert)\s*\(\s*\{([^}]{0,400})\}/.exec(tail);
      if (obj) for (const mm of obj[1].matchAll(/(\w+)\s*:/g)) cols.add(mm[1]);
      // .eq("col", ...) / .is("col", ...) / .order("col")
      for (const mm of tail.matchAll(/\.\s*(?:eq|is|neq|gt|lt|gte|lte|in|order|like|ilike)\s*\(\s*["'`](\w+)["'`]/g))
        cols.add(mm[1]);
      uses.push({ kind: "table", name: m[1], columns: [...cols], file: rel });
    }
    // .rpc("f", { p_x: ... }) — 인자 이름까지 뽑는다. 이름이 틀리면
    // PostgREST 가 함수를 못 찾아 런타임에서만 터진다.
    for (const m of src.matchAll(/\.rpc\(\s*["'`](\w+)["'`]\s*(?:,\s*\{([^}]{0,300})\})?/g)) {
      const args = m[2] ? [...m[2].matchAll(/(\w+)\s*:/g)].map((x) => x[1]) : [];
      uses.push({ kind: "rpc", name: m[1], args, file: rel });
    }
  }
  return uses;
}

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();
  mkdirSync(OUT, { recursive: true });
  await c.query("begin read only");
  const q = async (s, p = []) => (await c.query(s, p)).rows;

  head("0. 대상");
  const info = (await q(`select current_database() db`))[0];
  line("환경", USE_DEV ? "DEV" : "PROD");
  line("database", info.db);
  line("클라이언트 트리", APP_ROOT);

  head("1. 클라이언트 사용 수집 (server 경로 제외)");
  const uses = scanClient(APP_ROOT);
  const tables = [...new Set(uses.filter((u) => u.kind === "table").map((u) => u.name))].sort();
  const rpcs = [...new Set(uses.filter((u) => u.kind === "rpc").map((u) => u.name))].sort();
  line("접근 지점", uses.length);
  line("테이블", `${tables.length} — ${tables.join(", ")}`);
  line("RPC", rpcs.length ? `${rpcs.length} — ${rpcs.join(", ")}` : "0");

  head("2. 테이블·컬럼 존재 대조");
  const findings = [];
  for (const t of tables) {
    const exists = (await q(`select to_regclass('public.'||$1::text) is not null e`, [t]))[0].e;
    if (!exists) {
      findings.push({ severity: "MISSING_TABLE", target: `public.${t}`,
        files: [...new Set(uses.filter((u) => u.name === t).map((u) => u.file))] });
      console.log(`  ⛔ MISSING_TABLE   public.${t}`);
      continue;
    }
    const actual = new Set((await q(`select a.attname from pg_attribute a
      where a.attrelid=('public.'||$1::text)::regclass and a.attnum>0 and not a.attisdropped`, [t]))
      .map((r) => r.attname));
    const wanted = [...new Set(uses.filter((u) => u.name === t).flatMap((u) => u.columns ?? []))];
    const missing = wanted.filter((w) => !actual.has(w));
    if (missing.length) {
      findings.push({ severity: "MISSING_COLUMN", target: `public.${t}`, columns: missing,
        files: [...new Set(uses.filter((u) => u.name === t).map((u) => u.file))] });
      console.log(`  ⛔ MISSING_COLUMN  public.${t} → ${missing.join(", ")}`);
    } else {
      console.log(`  OK                public.${t} (컬럼 ${wanted.length}개 확인)`);
    }
  }

  head("3. RPC 대조 — 존재 · 인자 이름 · 호출 role 권한");
  // 존재만 보면 부족하다. PostgREST 는 인자 이름으로 함수를 고르므로
  // 이름이 어긋나면 "함수를 찾을 수 없음" 으로 런타임에서만 터진다.
  // 권한도 본다 — 존재해도 EXECUTE 가 없으면 호출이 막힌다.
  for (const f of rpcs) {
    const rows = await q(`select p.oid::regprocedure::text sig,
        coalesce(p.proargnames, '{}') argnames,
        pg_get_function_identity_arguments(p.oid) idargs,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_exec,
        has_function_privilege('anon', p.oid, 'EXECUTE') anon_exec
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname=$1::text`, [f]);
    if (rows.length === 0) {
      findings.push({ severity: "MISSING_RPC", target: `public.${f}`,
        files: [...new Set(uses.filter((u) => u.name === f).map((u) => u.file))] });
      console.log(`  ⛔ MISSING_RPC     public.${f}`);
      continue;
    }
    const wanted = [...new Set(uses.filter((u) => u.name === f).flatMap((u) => u.args ?? []))];
    // 오버로드 중 하나라도 클라이언트 인자 집합을 받아들이면 통과
    const match = rows.find((r) => wanted.every((w) => (r.argnames || []).includes(w)));
    if (!match) {
      findings.push({ severity: "RPC_ARG_MISMATCH", target: `public.${f}`,
        client_args: wanted, db_args: rows.map((r) => r.argnames),
        files: [...new Set(uses.filter((u) => u.name === f).map((u) => u.file))] });
      console.log(`  ⛔ RPC_ARG_MISMATCH public.${f} — 클라이언트 [${wanted.join(", ")}] vs DB [${rows.map((r) => (r.argnames || []).join(",")).join(" | ")}]`);
      continue;
    }
    if (!match.auth_exec) {
      findings.push({ severity: "RPC_NO_EXECUTE", target: match.sig, role: "authenticated",
        files: [...new Set(uses.filter((u) => u.name === f).map((u) => u.file))] });
      console.log(`  ⛔ RPC_NO_EXECUTE  ${match.sig} — authenticated 에게 EXECUTE 없음`);
      continue;
    }
    console.log(`  OK                ${match.sig}`);
    console.log(`      인자 [${wanted.join(", ") || "없음"}]  authenticated=${match.auth_exec}  anon=${match.anon_exec}`);
  }

  await c.query("rollback");

  head("판정");
  const out = {
    document: "SCHEMA_SHAPE_COMPAT",
    environment: USE_DEV ? "DEV" : "PROD",
    app_root: APP_ROOT,
    scanned_access_points: uses.length,
    tables, rpcs, findings,
    finding_count: findings.length,
    note: "권한이 아니라 형상만 본다. 존재하더라도 권한이 없으면 별도 게이트에서 걸린다.",
  };
  const buf = Buffer.from(JSON.stringify(out, null, 2));
  writeFileSync(join(OUT, `SCHEMA_SHAPE_COMPAT_${USE_DEV ? "DEV" : "PROD"}.json`), buf);
  console.log(`\nSCHEMA_SHAPE_COMPAT=${findings.length ? "FAIL" : "PASS"}`);
  console.log(`FINDINGS=${findings.length}`);
  console.log(`SHA256=${createHash("sha256").update(buf).digest("hex")}`);
  return findings.length ? 3 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + (e.message || String(e))); }
finally { try { await c.end(); } catch {} }
process.exit(code);
