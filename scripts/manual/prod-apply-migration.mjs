// ============================================================
// prod-apply-migration.mjs — 마이그레이션 1개 적용 + 사후검증
// ============================================================
// 예행(prod-dryrun-pending)에서 4/4 통과한 것을 실제로 적용한다.
// 한 번에 하나씩만 적용한다 — 여러 개를 한꺼번에 올리면 문제가 생겼을 때
// 어느 것 때문인지 가려내기 어렵다.
//
// 사후검증에 "기존 사용자 경로가 사는가" 를 반드시 넣는다. 오늘 아침에
// 새 스키마가 기존 클라이언트 계약을 깨뜨려 배포 직후 앱이 죽을 뻔했다.
// 객체가 늘었는지만 보고 넘어가면 같은 일이 반복된다.
//
// 실행: node scripts/manual/prod-apply-migration.mjs <파일명> --execute
// ============================================================
import pg from "pg";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readProdEnv, assertProdUrl, PROD_REF, scrub } from "./prod-url.mjs";

const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(46)} ${v}`);
const fails = [];
const rec = (n, ok, d) => { if (!ok) fails.push(n); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

const name = process.argv[2];
if (!name || !process.argv.includes("--execute")) {
  console.error("[중단] 사용법: prod-apply-migration.mjs <파일명> --execute");
  process.exit(2);
}
const path = join(process.cwd(), "supabase/migrations", name);
if (!existsSync(path)) { console.error(`[중단] 없음: ${path}`); process.exit(2); }

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

const KEEP = ["get_my_member", "set_initial_nickname", "soft_delete_post", "soft_delete_comment",
              "list_verification_requests", "review_verification", "change_nickname", "block_author"];

async function snapshot(q) {
  // count(*) 는 bigint 라 node-pg 가 문자열로 준다. 그대로 비교하면
  // "101" > "93" 이 거짓이 된다(문자열 사전순). 반드시 수로 바꾼다.
  const toNum = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v)]));
  return toNum((await q(`select
      (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname in ('public','private','authz') and c.relkind in ('r','p')) tables,
      (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname in ('public','private','authz')) funcs,
      (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
        join pg_namespace n on n.oid=c.relnamespace
        where n.nspname in ('public','private','authz') and not t.tgisinternal) triggers,
      (select count(*) from pg_policies where schemaname in ('public','private','authz')) policies,
      (select count(*) from public.posts) posts,
      (select count(*) from public.comments) comments,
      (select count(*) from auth.users) users,
      (select count(*) from private.members) members`))[0]);
}

async function main() {
  await c.connect();
  const q = async (s, p = []) => (await c.query(s, p)).rows;

  head("0. 대상");
  const buf = readFileSync(path);
  line("ref", PROD_REF);
  line("파일", `${name} (${buf.length}B)`);
  line("sha256", createHash("sha256").update(buf).digest("hex"));

  const before = await snapshot(q);
  line("적용 전", `테이블 ${before.tables} 함수 ${before.funcs} 트리거 ${before.triggers} 정책 ${before.policies}`);
  line("데이터", `글 ${before.posts} 댓글 ${before.comments} 계정 ${before.users} 회원 ${before.members}`);

  head("1. 적용");
  try {
    await c.query(buf.toString("utf8"));
    line("실행", "완료");
  } catch (e) {
    console.error(`\n⛔ 실패: ${scrub(e.message || String(e), url).slice(0, 400)}`);
    console.error("   파일이 자체 트랜잭션이면 이미 롤백됐다. 운영 상태를 확인하라.");
    return 3;
  }

  head("2. 사후검증 — 무엇이 생겼나");
  const after = await snapshot(q);
  line("적용 후", `테이블 ${after.tables} 함수 ${after.funcs} 트리거 ${after.triggers} 정책 ${after.policies}`);
  line("증가", `테이블 +${after.tables - before.tables} 함수 +${after.funcs - before.funcs} ` +
    `트리거 +${after.triggers - before.triggers} 정책 +${after.policies - before.policies}`);
  rec("객체가 실제로 늘었다", after.funcs > before.funcs || after.tables > before.tables);

  head("3. 사후검증 — 기존 것이 살아있나");
  rec("기존 데이터 불변", before.posts === after.posts && before.comments === after.comments
    && before.users === after.users && before.members === after.members,
    `글 ${after.posts} 댓글 ${after.comments} 계정 ${after.users} 회원 ${after.members}`);
  for (const fn of KEEP) {
    const r = await q(`select p.oid::regprocedure::text sig,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') auth
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=$1::text`, [fn]);
    rec(`${fn} 생존·권한`, r.length > 0 && r[0].auth === true,
      r.length ? `EXECUTE=${r[0].auth}` : "사라짐");
  }
  const boards = Number((await q(`select count(*) v from public.boards`))[0].v);
  rec("boards 9건", boards === 9, String(boards));

  head("4. 사후검증 — 새 객체가 anon 에게 열리지 않았나");
  // 새 테이블이 RLS 없이 만들어지거나 anon 에게 권한이 새면 즉시 사고다
  const rlsOff = (await q(`select n.nspname||'.'||c.relname t
     from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private') and c.relkind in ('r','p') and not c.relrowsecurity`))
    .map((r) => r.t);
  rec("RLS 꺼진 테이블 0", rlsOff.length === 0, rlsOff.join(", ") || "0");
  const anonExec = Number((await q(`select count(*) v from pg_proc p
     join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private','authz')
      and has_function_privilege('anon', p.oid, 'EXECUTE')`))[0].v);
  rec("anon EXECUTE 0", anonExec === 0, String(anonExec));

  console.log(`\nAPPLY_${name}=${fails.length ? "FAIL" : "PASS"}`);
  if (fails.length) for (const f of fails) console.log(`  · ${f}`);
  return fails.length ? 3 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
process.exit(code);
