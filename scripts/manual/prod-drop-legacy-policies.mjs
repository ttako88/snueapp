// ============================================================
// prod-drop-legacy-policies.mjs — 레거시 public 정책 제거 (reset 선행 단계)
// ============================================================
// 왜 필요한가
//   prod-reset-community.sql 의 드롭 루프는 `drop table public.%I` 를
//   FK 기준 drop_ord(자식→부모)로 돈다. CASCADE 가 없다.
//   그런데 운영 레거시 스키마에는 정책 의존이 FK 와 **반대 방향**으로 있다 —
//   comments 의 정책 "댓글 수정·삭제: 작성자 본인만" 이 comment_owners 를
//   참조하므로(pg_depend deptype=n), comment_owners 를 먼저 드롭하려 하면
//   "cannot drop table comment_owners because other objects depend on it" 로
//   막힌다. 실제로 그렇게 막혀서 reset 이 스스로 롤백했다.
//
// 무엇을 하는가
//   동결된 reset 스크립트(해시 승인본)는 건드리지 않는다. 대신 그 스크립트가
//   어차피 테이블과 함께 파괴할 레거시 public 정책만 먼저 제거한다.
//   정책이 사라지면 드롭 순서와 무관하게 테이블이 떨어진다.
//
// 안전
//   · 단일 트랜잭션. 실패 시 전부 롤백.
//   · public 스키마 정책만. auth·storage 등 관리 스키마는 손대지 않는다.
//   · 노출 창 없음 — 앱은 503 이고 anon·authenticated 는 ACL fence 로 이미 차단.
//   · 삭제 전 정의를 전부 파일로 남긴다(복원용).
//
// 실행: node scripts/manual/prod-drop-legacy-policies.mjs --execute
// ============================================================
import pg from "pg";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readProdEnv, assertProdUrl, PROD_REF, scrub } from "./prod-url.mjs";

const OUT = join(homedir(), "prod-runs", "PROD_LEGACY_POLICIES");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(46)} ${v}`);

if (!process.argv.includes("--execute")) {
  console.error("[중단] 운영 DDL 이다. --execute 를 명시하라.");
  process.exit(2);
}

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();
  mkdirSync(OUT, { recursive: true });
  const q = async (s, p = []) => (await c.query(s, p)).rows;

  head("0. 대상 확인");
  line("target ref", PROD_REF);
  const before = await q(`select schemaname, tablename, policyname, permissive, roles::text roles,
      cmd, coalesce(qual,'') qual, coalesce(with_check,'') with_check
    from pg_policies where schemaname='public' order by tablename, policyname`);
  line("public 정책", before.length);
  for (const p of before) console.log(`    ${p.tablename}.${p.policyname} [${p.cmd}]`);

  // 복원 자료를 먼저 남긴다. 지우고 나서 "어떤 정책이었더라" 가 되면 안 된다.
  const snapshot = { captured_at_utc: new Date().toISOString(), ref: PROD_REF, policies: before };
  const snapBuf = Buffer.from(JSON.stringify(snapshot, null, 2));
  writeFileSync(join(OUT, "LEGACY_POLICIES_BEFORE.json"), snapBuf);
  line("정의 스냅샷 저장", `${before.length}건 / sha256 ${createHash("sha256").update(snapBuf).digest("hex").slice(0, 16)}…`);

  if (before.length === 0) { console.log("\n제거할 정책이 없다. 종료."); return 0; }

  head("1. 단일 트랜잭션에서 제거");
  await c.query("begin");
  await c.query(`set local lock_timeout='10s'`);
  try {
    for (const p of before) {
      // 정책명에 한글·공백·콜론이 있으므로 반드시 식별자 인용을 거친다.
      // format 파라미터에는 명시 캐스트가 필요하다 — 없으면 Postgres 가
      // 타입을 추론하지 못해 "could not determine data type of parameter" 로 죽는다.
      const ddl = (await q(`select format('drop policy %I on public.%I', $1::text, $2::text) s`,
        [p.policyname, p.tablename]))[0].s;
      await c.query(ddl);
      console.log(`  제거  ${p.tablename}.${p.policyname}`);
    }
    const left = Number((await q(`select count(*) v from pg_policies where schemaname='public'`))[0].v);
    if (left !== 0) throw new Error(`정책 ${left}건 잔존 — 롤백`);
    await c.query("commit");
    line("COMMIT", "완료");
  } catch (e) {
    try { await c.query("rollback"); } catch {}
    console.error(`\n⛔ 실패(ROLLBACK): ${scrub(e.message || String(e), url).slice(0, 300)}`);
    return 3;
  }

  head("2. readback");
  const after = Number((await q(`select count(*) v from pg_policies where schemaname='public'`))[0].v);
  const tables = Number((await q(`select count(*) v from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p')`))[0].v);
  const authUsers = Number((await q(`select count(*) v from auth.users`))[0].v);
  line("public 정책", after);
  line("public 테이블 (아직 그대로)", tables);
  line("auth.users (무관, 확인용)", authUsers);
  console.log(`\nLEGACY_POLICIES_DROPPED=${before.length}`);
  console.log(`REMAINING=${after}`);
  console.log(`SNAPSHOT=${join(OUT, "LEGACY_POLICIES_BEFORE.json")}`);
  return after === 0 ? 0 : 3;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
process.exit(code);
