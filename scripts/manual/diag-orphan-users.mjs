// ============================================================
// diag-orphan-users.mjs — 회원 행 없는 기존 계정 확인 (READ-ONLY)
// ============================================================
// reset 이 private.members 를 비웠고, 가입 트리거는 auth.users INSERT 때만
// 발화한다. 그러므로 reset 이전부터 있던 계정은 회원 행이 없다.
//
// 그 상태가 왜 문제인가
//   set_initial_nickname 은 `update private.members ... where id=auth.uid()
//   and nickname is null` 후 `if not found then raise exception` 이다.
//   회원 행이 없으면 닉네임을 만들 수 없고, 온보딩에서 막혀 서비스를
//   쓸 수 없다. 로그인은 되는데 그다음이 없는 상태다.
//
// READ-ONLY.
// ============================================================
import pg from "pg";
import { readProdEnv, assertProdUrl, scrub } from "./prod-url.mjs";

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();
  await c.query("begin read only");
  const q = async (s, p = []) => (await c.query(s, p)).rows;

  const rows = await q(`
    select u.id, u.email, u.created_at,
           (m.id is not null) has_member, m.nickname, m.verification_status
      from auth.users u
      left join private.members m on m.id = u.id
     order by u.created_at`);

  console.log("=== auth.users ↔ private.members ===");
  for (const r of rows) {
    const mark = r.email.startsWith("zz-smoke-") ? "[테스트]" : "[실사용자]";
    console.log(`  ${mark} ${r.email}`);
    console.log(`      회원행=${r.has_member ? "있음" : "★ 없음"}  닉네임=${r.nickname ?? "-"}  인증=${r.verification_status ?? "-"}`);
  }

  const orphans = rows.filter((r) => !r.has_member);
  const realOrphans = orphans.filter((r) => !r.email.startsWith("zz-smoke-"));
  console.log(`\n회원 행 없는 계정: ${orphans.length} (그중 실사용자 ${realOrphans.length})`);
  if (realOrphans.length) {
    console.log("\n  ⛔ 이 계정들은 로그인은 되지만 닉네임을 만들 수 없다.");
    console.log("     set_initial_nickname 이 'nickname already set or no member' 로 거부한다.");
    console.log("     503 을 내리기 전에 회원 행을 백필해야 한다.");
  }

  await c.query("rollback");
  return realOrphans.length;
}

let n = -1;
try { n = await main(); }
catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
console.log(`\nORPHAN_REAL_USERS=${n}`);
