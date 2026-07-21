// ============================================================
// diag-email-guard.mjs — 이메일 도메인 서버측 잠금장치 존재 확인 (READ-ONLY)
// ============================================================
// 로그인 페이지 주석이 명시한다 — "여기 정규식만 믿으면 API를 직접 호출해
// 우회할 수 있으므로 반드시 서버(DB)에서도 막아야 함". 그 서버 잠금은
// 구 스키마의 enforce_snue_email 트리거였다. reset 이 지웠고 신 스키마가
// 다시 만들었는지 확인해야 한다. 없으면 누구나 API 직접 호출로 가입할 수 있다.
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

  console.log("=== auth.users 위 트리거 ===");
  const trg = await q(`select t.tgname, t.tgenabled, p.proname, n.nspname
      from pg_trigger t join pg_proc p on p.oid=t.tgfoid
      join pg_namespace n on n.oid=p.pronamespace
     where t.tgrelid='auth.users'::regclass and not t.tgisinternal order by 1`);
  for (const r of trg) console.log(`  ${r.tgname} → ${r.nspname}.${r.proname} (enabled=${r.tgenabled})`);
  if (!trg.length) console.log("  (없음)");

  console.log("\n=== auth.users 제약 (CHECK) ===");
  const chk = await q(`select conname, pg_get_constraintdef(oid) def
      from pg_constraint where conrelid='auth.users'::regclass and contype='c'`);
  for (const r of chk) console.log(`  ${r.conname}: ${r.def.slice(0, 120)}`);
  if (!chk.length) console.log("  (없음)");

  console.log("\n=== 이메일 도메인을 언급하는 함수 ===");
  const fns = await q(`select n.nspname||'.'||p.proname nm
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname in ('public','private','authz','auth')
       and p.prosrc ilike '%snue.ac.kr%'`);
  for (const r of fns) console.log(`  ${r.nm}`);
  if (!fns.length) console.log("  (없음)");

  const guarded = trg.some((t) => /email/i.test(t.tgname) || /email/i.test(t.proname))
    || chk.some((r) => /snue/i.test(r.def)) || fns.length > 0;
  console.log(`\nSERVER_SIDE_EMAIL_GUARD=${guarded ? "있음" : "★ 없음"}`);
  if (!guarded) {
    console.log("  → 클라이언트 정규식만 남았다. Auth API 를 직접 호출하면");
    console.log("    아무 도메인으로나 가입할 수 있다. 코드 주석이 경고한 그 상태다.");
  }

  await c.query("rollback");
}

try { await main(); }
catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
