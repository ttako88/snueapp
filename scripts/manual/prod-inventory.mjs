// Phase 1 — 운영 DB 읽기 전용 인벤토리
//
// 쓰기·DDL을 일절 하지 않는다. 트랜잭션도 read only로 연다.
// 목적: 파괴적 작업 전에 "지금 운영에 뭐가 들어 있는지"를 사실로 확정한다.
//   · 접속 가능 여부 / 대상이 정말 운영인지
//   · 스키마·테이블 목록
//   · 회원·글·댓글 등 실데이터 규모
//   · 확장·Cron 잡 유무
// 개인정보(닉네임·이메일·본문)는 출력하지 않고 **개수만** 센다.
import pg from "pg";
import { readProdEnv, assertProdUrl, PROD_REF, refOf, scrub } from "./prod-url.mjs";

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
if (!url) { console.error("[중단] PROD_DB_URL 없음"); process.exit(1); }
assertProdUrl(url, "PROD_DB_URL");

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

const line = (k, v) => console.log(`  ${String(k).padEnd(34)} ${v}`);

async function main() {
  await client.connect();
  // 읽기 전용 트랜잭션 — 실수로도 쓰지 못하게 DB가 막는다
  await client.query("begin transaction read only");

  try {
    console.log("=== 접속 대상 확인 ===");
    const { rows: [who] } = await client.query(
      `select current_database() db, current_user usr, version() ver`);
    line("database", who.db);
    line("user", who.usr);
    line("postgres", who.ver.split(" ").slice(0, 2).join(" "));
    line("project ref (URL 기준)", refOf(url) === PROD_REF ? `${PROD_REF} ✅ 운영` : "불일치");

    console.log("\n=== 스키마 ===");
    const { rows: schemas } = await client.query(
      `select nspname from pg_namespace
        where nspname not like 'pg_%' and nspname <> 'information_schema'
        order by nspname`);
    line("스키마 목록", schemas.map((s) => s.nspname).join(", "));

    console.log("\n=== public 테이블 ===");
    const { rows: tables } = await client.query(
      `select c.relname, c.relrowsecurity rls,
              coalesce(s.n_live_tup, 0) est
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_stat_user_tables s on s.relid = c.oid
        where n.nspname = 'public' and c.relkind = 'r'
        order by c.relname`);
    if (!tables.length) line("(없음)", "");
    for (const t of tables) line(t.relname, `RLS ${t.rls ? "ON " : "OFF"} · 약 ${t.est}행`);

    console.log("\n=== private 스키마 테이블 (001~009 적용 여부 판단) ===");
    const { rows: priv } = await client.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'private' and c.relkind = 'r' order by c.relname`);
    line("private 테이블 수", priv.length);
    if (priv.length) line("목록", priv.map((p) => p.relname).join(", "));

    console.log("\n=== 실데이터 규모 (개인정보 미출력, 개수만) ===");
    const counts = [
      ["auth.users", "select count(*)::int n from auth.users"],
      ["public.profiles", "select count(*)::int n from public.profiles"],
      ["public.posts", "select count(*)::int n from public.posts"],
      ["public.comments", "select count(*)::int n from public.comments"],
      ["private.members", "select count(*)::int n from private.members"],
    ];
    for (const [name, sql] of counts) {
      try {
        const { rows: [r] } = await client.query(sql);
        line(name, `${r.n}행`);
      } catch {
        line(name, "(테이블 없음)");
      }
    }

    console.log("\n=== 확장·Cron ===");
    const { rows: ext } = await client.query(
      `select extname from pg_extension order by extname`);
    line("확장", ext.map((e) => e.extname).join(", "));
    try {
      const { rows: [j] } = await client.query(`select count(*)::int n from cron.job`);
      line("cron.job", `${j.n}건`);
    } catch {
      line("cron.job", "(pg_cron 미설치 또는 접근 불가)");
    }

    console.log("\n=== Storage 버킷 ===");
    try {
      const { rows: b } = await client.query(`select id, public from storage.buckets order by id`);
      line("버킷 수", b.length);
      for (const x of b) line(`  ${x.id}`, x.public ? "public ⚠️" : "private");
    } catch {
      line("storage.buckets", "(접근 불가)");
    }

    console.log("\n읽기 전용 트랜잭션으로 실행했습니다. 아무것도 변경하지 않았습니다.");
  } finally {
    await client.query("rollback");
    await client.end();
  }
}

main().catch((e) => { console.error("[fail] " + scrub(e.message || String(e), url)); process.exit(1); });
