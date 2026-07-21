// ============================================================
// prod-dryrun-pending.mjs — 대기 마이그레이션 예행 적용 (ROLLBACK 종료)
// ============================================================
// 왜 운영에서 하는가
//   dev 는 001~005 상태이고 폐기된 V2 fence 까지 걸려 있다. 운영은
//   001~010 이다. 서로 다른 스키마에서 검증하면 오늘 아침처럼 "형상이
//   안 맞아" 배포 직후 터진다. PostgreSQL 은 DDL 도 트랜잭션이므로
//   운영 스키마 그대로 적용해 보고 ROLLBACK 하면 잔여물이 0 이다.
//
// 무엇을 보는가
//   · 각 파일이 오류 없이 적용되는가 (구문·참조·의존)
//   · 무엇을 만드는가 (테이블·함수·트리거·정책 증가분)
//   · 순서 의존이 있는가 (누적 적용으로 확인)
//   · 적용 후에도 기존 사용자 경로가 사는가 (핵심 RPC 존재·권한)
//
// 파일은 각각 자체 begin/commit 을 가질 수 있으므로 wrapper 를 벗겨
// 하나의 외부 트랜잭션에서 순서대로 돌린다. 그래야 전체를 한 번에
// 되돌릴 수 있고 순서 의존도 드러난다.
//
// 실행: node scripts/manual/prod-dryrun-pending.mjs
// ============================================================
import pg from "pg";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readProdEnv, assertProdUrl, PROD_REF, scrub } from "./prod-url.mjs";

const DIR = join(process.cwd(), "supabase/migrations/pending");
const OUT = join(homedir(), "prod-runs", "PENDING_DRYRUN");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(44)} ${v}`);

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

/** 파일 맨 앞 begin; 과 맨 뒤 commit; 만 벗긴다. 그 밖의 내용은 손대지 않는다. */
function stripWrapper(sql) {
  let s = sql;
  const b = /^\s*begin\s*;/im.exec(s);
  if (b && s.slice(0, b.index).replace(/--[^\n]*|\s/g, "") === "")
    s = s.slice(0, b.index) + " ".repeat(b[0].length) + s.slice(b.index + b[0].length);
  const matches = [...s.matchAll(/^\s*commit\s*;/gim)];
  if (matches.length) {
    const m = matches[matches.length - 1];
    s = s.slice(0, m.index) + " ".repeat(m[0].length) + s.slice(m.index + m[0].length);
  }
  return s;
}

async function snapshot(q) {
  return (await q(`select
      (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname in ('public','private','authz') and c.relkind in ('r','p')) tables,
      (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname in ('public','private','authz')) funcs,
      (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
        join pg_namespace n on n.oid=c.relnamespace
        where n.nspname in ('public','private','authz') and not t.tgisinternal) triggers,
      (select count(*) from pg_policies where schemaname in ('public','private','authz')) policies`))[0];
}

async function main() {
  await c.connect();
  mkdirSync(OUT, { recursive: true });
  const q = async (s, p = []) => (await c.query(s, p)).rows;

  head("0. 대상");
  line("ref", PROD_REF);
  const files = readdirSync(DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  for (const f of files) line(`  ${f}`, `${readFileSync(join(DIR, f)).length}B`);

  const before = await snapshot(q);
  line("현재 (테이블/함수/트리거/정책)",
    `${before.tables}/${before.funcs}/${before.triggers}/${before.policies}`);

  head("1. 누적 예행 적용 (전부 ROLLBACK)");
  const results = [];
  await c.query("begin");
  await c.query(`set local lock_timeout='15s'`);
  await c.query(`set local statement_timeout='300s'`);
  let spn = 0;
  try {
    for (const f of files) {
      const sql = stripWrapper(readFileSync(join(DIR, f), "utf8"));
      const sp = `p${++spn}`;
      await c.query(`savepoint ${sp}`);
      const t0 = Date.now();
      try {
        await c.query(sql);
        await c.query(`release savepoint ${sp}`);
        const s = await snapshot(q);
        const delta = {
          tables: s.tables - before.tables, funcs: s.funcs - before.funcs,
          triggers: s.triggers - before.triggers, policies: s.policies - before.policies,
        };
        results.push({ file: f, ok: true, ms: Date.now() - t0, cumulative: s });
        console.log(`  PASS  ${f}  (${Date.now() - t0}ms)`);
        console.log(`        누적 증가 — 테이블 +${delta.tables} 함수 +${delta.funcs} 트리거 +${delta.triggers} 정책 +${delta.policies}`);
      } catch (e) {
        await c.query(`rollback to savepoint ${sp}`);
        await c.query(`release savepoint ${sp}`);
        results.push({ file: f, ok: false, code: e.code, message: (e.message || "").slice(0, 220),
          position: e.position, ms: Date.now() - t0 });
        console.log(`  FAIL  ${f}`);
        console.log(`        ${e.code} ${(e.message || "").slice(0, 200)}`);
        if (e.detail) console.log(`        detail: ${String(e.detail).slice(0, 160)}`);
        if (e.hint) console.log(`        hint: ${String(e.hint).slice(0, 160)}`);
      }
    }

    head("2. 적용 후 기존 사용자 경로가 사는가");
    // 오늘 아침 교훈 — 새 SQL 이 기존 계약을 깨는지 반드시 본다
    const keep = ["get_my_member", "set_initial_nickname", "soft_delete_post",
                  "soft_delete_comment", "list_verification_requests", "review_verification"];
    for (const fn of keep) {
      const r = await q(`select p.oid::regprocedure::text sig,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') auth
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname=$1::text`, [fn]);
      const ok = r.length > 0;
      console.log(`  ${ok ? "OK  " : "FAIL"}  ${fn}${ok ? ` — authenticated EXECUTE=${r[0].auth}` : " — 사라짐"}`);
      if (!ok) results.push({ file: "(사후검사)", ok: false, message: `${fn} 소실` });
    }
    const boards = Number((await q(`select count(*) v from public.boards`))[0].v);
    console.log(`  ${boards === 9 ? "OK  " : "FAIL"}  boards ${boards}건`);
  } finally {
    await c.query("rollback");
    line("종료", "ROLLBACK — 운영 잔여물 0");
  }

  head("3. 롤백 확인");
  const after = await snapshot(q);
  const same = JSON.stringify(before) === JSON.stringify(after);
  line("사후 (테이블/함수/트리거/정책)",
    `${after.tables}/${after.funcs}/${after.triggers}/${after.policies}`);
  console.log(`  ${same ? "PASS" : "FAIL"}  적용 전과 동일`);

  const failed = results.filter((r) => !r.ok);
  const out = { document: "PENDING_MIGRATION_DRYRUN", ref: PROD_REF,
    method: "운영 스키마에 누적 적용 후 ROLLBACK. wrapper begin/commit 만 제거.",
    before, after, rollback_clean: same, results };
  const buf = Buffer.from(JSON.stringify(out, null, 2));
  writeFileSync(join(OUT, "PENDING_DRYRUN.json"), buf);

  head("판정");
  console.log(`\nPENDING_DRYRUN=${failed.length ? "FAIL" : "PASS"}`);
  console.log(`통과 ${results.length - failed.length}/${results.length}`);
  console.log(`SHA256=${createHash("sha256").update(buf).digest("hex")}`);
  if (failed.length) for (const f of failed) console.log(`  · ${f.file}: ${f.message ?? ""}`);
  return failed.length ? 3 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
process.exit(code);
