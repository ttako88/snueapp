// ============================================================
// prod-verify-analytics.mjs — 024~027 적용 결과 읽기전용 심층 검증
// ============================================================
// 적용 도구(prod-apply-migration)의 일반 사후검증을 넘어, 분석·수익화 스키마가
// 설계대로 앉았는지 구체적으로 확인한다. **읽기 전용**(begin read only)이라
// 어떤 것도 바꾸지 않는다. 활성화 전 근거 + 배포 후 회귀 확인용.
//
// 실행: node scripts/manual/prod-verify-analytics.mjs
// ============================================================
import pg from "pg";
import { readProdEnv, assertProdUrl, PROD_REF, scrub } from "./prod-url.mjs";

const fails = [];
const rec = (n, ok, d) => { if (!ok) fails.push(n); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

const NEW_TABLES = [
  "member_academic", "member_consents", "analytics_subjects",
  "usage_event_registry", "usage_events", "usage_counters", "usage_rate",
  "analytics_week_snapshots", "sponsors", "sponsor_stats", "ad_deliveries", "app_flags",
];
// public 함수 → authenticated EXECUTE 여야(본인/운영자용). anon/PUBLIC 은 0.
const PUBLIC_FN_AUTHED = [
  "get_my_academic", "set_my_academic_confirmation", "set_my_consent", "get_my_consents",
  "analytics_overview", "analytics_event_segments", "analytics_daily",
  "get_sponsor_for_slot", "sponsor_report",
];
// service_role 전용(authenticated/anon 은 0).
const SVC_FN = ["svc_set_member_academic", "svc_track_event", "svc_prune_usage_rate",
  "svc_ad_event", "svc_prune_ad_deliveries"];

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();
  await c.query("begin read only");   // 어떤 쓰기도 불가
  const q = async (s, p = []) => (await c.query(s, p)).rows;

  console.log(`\n=== ref ${PROD_REF} — 분석·수익화 스키마 검증(읽기전용) ===`);

  console.log("\n[1] 새 테이블 존재 + RLS ON");
  for (const t of NEW_TABLES) {
    const r = await q(`select c.relrowsecurity rls from pg_class c
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='private' and c.relname=$1`, [t]);
    rec(`private.${t}`, r.length === 1 && r[0].rls === true, r.length ? `RLS=${r[0].rls}` : "없음");
  }

  console.log("\n[2] public 함수 — authenticated EXECUTE=true, anon=false");
  for (const fn of PUBLIC_FN_AUTHED) {
    const r = await q(`select p.oid,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') a,
        has_function_privilege('anon', p.oid, 'EXECUTE') an
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=$1`, [fn]);
    rec(`public.${fn}`, r.length >= 1 && r[0].a === true && r[0].an === false,
      r.length ? `auth=${r[0].a} anon=${r[0].an}` : "없음");
  }

  console.log("\n[3] service_role 함수 — authenticated/anon EXECUTE=false");
  for (const fn of SVC_FN) {
    const r = await q(`select p.oid,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') a,
        has_function_privilege('anon', p.oid, 'EXECUTE') an
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='private' and p.proname=$1`, [fn]);
    rec(`private.${fn}`, r.length >= 1 && r[0].a === false && r[0].an === false,
      r.length ? `auth=${r[0].a} anon=${r[0].an}` : "없음");
  }

  console.log("\n[4] 광고 DB fence — app_flags.targeted_ads=false (휴면)");
  const flag = await q(`select enabled from private.app_flags where key='targeted_ads'`);
  rec("targeted_ads fence OFF", flag.length === 1 && flag[0].enabled === false,
    flag.length ? `enabled=${flag[0].enabled}` : "행 없음");

  console.log("\n[5] k_suppress 동작 — 1개 숨김 시 최소셀 추가 숨김(complementary)");
  // 공개셀 [10, 6], 숨김 1개(3) → 숨김이 정확히 1개이므로 최소 공개셀(6)도 숨겨 [10]만.
  const ks = await q(`select private.k_suppress(
    '[{"d":"a","n":10},{"d":"b","n":6},{"d":"c","n":3}]'::jsonb, 5) v`);
  const arr = ks[0].v;
  rec("complementary suppression", Array.isArray(arr) && arr.length === 1 && Number(arr[0].n) === 10,
    JSON.stringify(arr));

  console.log("\n[6] usage_events → analytics_subjects ON DELETE CASCADE (철회 즉시 파기)");
  const fk = await q(`select confdeltype from pg_constraint
    where conrelid='private.usage_events'::regclass and contype='f'
      and confrelid='private.analytics_subjects'::regclass`);
  rec("usage_events FK CASCADE", fk.length >= 1 && fk[0].confdeltype === 'c',
    fk.length ? `deltype=${fk[0].confdeltype}` : "FK 없음");

  await c.query("rollback");
  console.log(`\nVERIFY_ANALYTICS=${fails.length ? "FAIL" : "PASS"}`);
  if (fails.length) for (const f of fails) console.log(`  · ${f}`);
  return fails.length ? 3 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
process.exit(code);
