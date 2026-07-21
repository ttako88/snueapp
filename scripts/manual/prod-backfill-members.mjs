// ============================================================
// prod-backfill-members.mjs — 회원 행 없는 기존 계정 백필
// ============================================================
// 왜 필요한가
//   reset 이 private.members 를 비웠고 가입 트리거는 auth.users INSERT
//   때만 발화한다. reset 이전부터 있던 계정은 회원 행이 없어 로그인은
//   되지만 닉네임을 만들 수 없다(set_initial_nickname 이 대상 행을 못 찾아
//   'nickname already set or no member' 로 거부). 서비스를 쓸 수 없는 상태다.
//
// 무엇을 하는가
//   트리거가 신규 가입에 하는 것과 똑같이 members 행만 만든다.
//   private.handle_new_auth_user() 가 `insert into private.members (id)` 인
//   것과 동일하다. 닉네임·인증상태는 건드리지 않는다 — 사용자가 온보딩에서
//   직접 정할 몫이다.
//
// 안전
//   · 단일 트랜잭션, 실패 시 전부 롤백
//   · on conflict do nothing — 이미 있는 행은 손대지 않는다
//   · 기본값 외의 컬럼을 세팅하지 않는다(인증상태를 임의로 올리지 않는다)
//   · 사전·사후 행수를 대조한다
//
// 실행: node scripts/manual/prod-backfill-members.mjs --execute
// ============================================================
import pg from "pg";
import { readProdEnv, assertProdUrl, PROD_REF, scrub } from "./prod-url.mjs";

const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(44)} ${v}`);

if (!process.argv.includes("--execute")) {
  console.error("[중단] 운영 쓰기다. --execute 를 명시하라.");
  process.exit(2);
}

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();
  const q = async (s, p = []) => (await c.query(s, p)).rows;

  head("0. 대상");
  line("ref", PROD_REF);
  const before = (await q(`select
      (select count(*) from auth.users) users,
      (select count(*) from private.members) members`))[0];
  line("사전", `auth.users=${before.users} members=${before.members}`);

  const orphans = await q(`select u.id, u.email from auth.users u
     left join private.members m on m.id = u.id where m.id is null order by u.created_at`);
  line("회원 행 없는 계정", orphans.length);
  for (const o of orphans) console.log(`    ${o.email}`);
  if (orphans.length === 0) { console.log("\n백필 대상 없음."); return 0; }

  head("1. 백필 (트리거와 동일하게 id 만 삽입)");
  await c.query("begin");
  try {
    const r = await c.query(
      `insert into private.members (id)
       select u.id from auth.users u
        left join private.members m on m.id = u.id
        where m.id is null
       on conflict (id) do nothing`);
    line("삽입", `${r.rowCount}행`);
    const left = Number((await q(`select count(*) v from auth.users u
       left join private.members m on m.id=u.id where m.id is null`))[0].v);
    if (left !== 0) throw new Error(`백필 후에도 ${left}건 남음 — 롤백`);
    await c.query("commit");
    line("COMMIT", "완료");
  } catch (e) {
    await c.query("rollback");
    console.error(`\n⛔ 실패(ROLLBACK): ${scrub(e.message || String(e), url).slice(0, 250)}`);
    return 3;
  }

  head("2. readback");
  const after = (await q(`select
      (select count(*) from auth.users) users,
      (select count(*) from private.members) members`))[0];
  line("사후", `auth.users=${after.users} members=${after.members}`);
  const rows = await q(`select u.email, m.nickname, m.verification_status
      from auth.users u join private.members m on m.id=u.id order by u.created_at`);
  for (const r of rows)
    console.log(`    ${r.email} → 닉네임=${r.nickname ?? "(미설정)"} 인증=${r.verification_status}`);

  const ok = Number(after.members) === Number(after.users);
  console.log(`\nBACKFILL=${ok ? "PASS" : "FAIL"}`);
  console.log(`모든 계정이 회원 행 보유=${ok}`);
  return ok ? 0 : 3;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
process.exit(code);
