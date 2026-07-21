// ============================================================
// diag-verification-ready.mjs — 인증 파이프라인이 실제로 동작하나 (READ-ONLY)
// ============================================================
// 코드를 다 붙여도 셋 중 하나라도 없으면 사용자에게는 그냥 고장이다.
//   1. 서버 시크릿 (SUPABASE_SECRET_KEY) — 없으면 라우트가 503
//   2. HMAC 키 (VERIFY_HMAC_KEY_V*, VERIFY_HMAC_CURRENT_VER) — 없으면 begin 이 503
//   3. 비공개 버킷 (verification-docs) — 없으면 업로드 URL 발급 실패
//
// 여기에 더해, 코드의 doc_type 목록이 DB CHECK 제약과 어긋나면 begin 이
// 알 수 없는 이유로 실패한다. 그 대조도 함께 한다.
//
// 시크릿 값은 출력하지 않는다. 있고 없음과 길이 범위만 본다. READ-ONLY.
// ============================================================
import pg from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readProdEnv, assertProdUrl, scrub } from "./prod-url.mjs";

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

// 코드가 허용하는 doc_type — app/lib/server/verification/hmac.mjs 와 같아야 한다.
const CODE_DOC_TYPES = ["student_card", "smart_id", "enrollment_cert", "leave_cert"];
const BUCKET = "verification-docs";

const line = (k, v) => console.log(`  ${String(k).padEnd(34)} ${v}`);
let blockers = [];

/** 값은 반환만 하고 절대 출력하지 않는다. 파일이 없으면 빈 객체. */
function readEnvFile(name) {
  let raw;
  try { raw = readFileSync(resolve(process.cwd(), name), "utf8"); } catch { return {}; }
  const map = {};
  for (const l of raw.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return map;
}

async function main() {
  await c.connect();
  await c.query("begin read only");
  const q = async (s, p = []) => (await c.query(s, p)).rows;

  // --- 1. env ------------------------------------------------------------
  // 여기서 보는 것은 "로컬 개발 환경" 이다. 운영은 Vercel 프로젝트 환경변수를
  // 쓰므로, 이 검사가 PASS 라고 운영이 준비된 것은 아니다. 같은 이름의 값을
  // Vercel 에도 넣어야 한다 — 아래 안내에 함께 적는다.
  console.log("=== 서버 환경변수 · 로컬 (.env.local + 셸, 값은 출력하지 않음) ===");
  const env = { ...readEnvFile(".env.local"), ...process.env };
  const hasSecret = Boolean(env.SUPABASE_SECRET_KEY);
  line("SUPABASE_SECRET_KEY", hasSecret ? "있음" : "⛔ 없음");
  if (!hasSecret) blockers.push("SUPABASE_SECRET_KEY (Vercel 서버 전용 env)");

  const hasUrl = Boolean(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL);
  line("SUPABASE_URL", hasUrl ? "있음" : "⛔ 없음");
  if (!hasUrl) blockers.push("SUPABASE_URL 또는 NEXT_PUBLIC_SUPABASE_URL");

  const curVer = Number(env.VERIFY_HMAC_CURRENT_VER);
  const keyVers = [];
  for (let v = 1; v <= 32; v++) {
    const k = env[`VERIFY_HMAC_KEY_V${v}`];
    if (k) keyVers.push({ v, short: k.length < 32 });
  }
  line("VERIFY_HMAC_CURRENT_VER", Number.isInteger(curVer) && curVer >= 1 ? `v${curVer}` : "⛔ 없음/무효");
  line("VERIFY_HMAC_KEY_V*", keyVers.length ? keyVers.map((k) => `v${k.v}${k.short ? "(짧음)" : ""}`).join(", ") : "⛔ 없음");
  if (!keyVers.length) blockers.push("VERIFY_HMAC_KEY_V1 (32자 이상 무작위 문자열)");
  else if (keyVers.some((k) => k.short)) blockers.push("VERIFY_HMAC_KEY_V* 중 32자 미만인 키");
  if (!Number.isInteger(curVer) || !keyVers.some((k) => k.v === curVer))
    blockers.push("VERIFY_HMAC_CURRENT_VER 가 실제 존재하는 키 버전을 가리켜야 함");

  // --- 2. 버킷 -----------------------------------------------------------
  console.log("\n=== Storage 버킷 ===");
  const buckets = await q(`select id, public, file_size_limit, allowed_mime_types
                             from storage.buckets order by id`);
  if (!buckets.length) line("(버킷 없음)", "⛔");
  for (const b of buckets) line(b.id, `${b.public ? "⛔ 공개" : "비공개"} / limit ${b.file_size_limit ?? "없음"}`);
  const vb = buckets.find((b) => b.id === BUCKET);
  if (!vb) blockers.push(`Storage 비공개 버킷 '${BUCKET}' 생성`);
  else if (vb.public) blockers.push(`버킷 '${BUCKET}' 를 비공개로 전환`);

  // anon/authenticated 정책이 0개여야 한다 (006 의 확정 기본안)
  const pols = await q(`select policyname, roles::text from pg_policies
                         where schemaname='storage' and tablename='objects'`);
  line("storage.objects 정책", pols.length === 0 ? "0개 (설계대로)" : `${pols.length}개 — 확인 필요`);
  for (const p of pols) line(`  ${p.policyname}`, p.roles);

  // --- 3. RPC 존재 -------------------------------------------------------
  console.log("\n=== 필요한 RPC ===");
  const needed = ["begin_verification", "finalize_verification",
                  "get_my_verification_requests", "withdraw_verification",
                  "list_verification_requests", "review_verification"];
  for (const fn of needed) {
    const n = Number((await q(
      `select count(*) v from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
        where ns.nspname='public' and p.proname=$1::text`, [fn]))[0].v);
    line(fn, n > 0 ? "있음" : "⛔ 없음");
    if (n === 0) blockers.push(`RPC public.${fn}`);
  }

  // --- 4. doc_type 코드 ↔ DB 제약 대조 -----------------------------------
  console.log("\n=== doc_type 목록 대조 ===");
  const [{ def }] = await q(
    `select pg_get_constraintdef(oid) def from pg_constraint
      where conrelid = 'private.verification_requests'::regclass
        and contype = 'c' and pg_get_constraintdef(oid) like '%doc_type%'
      limit 1`);
  // 제약식에서 따옴표로 감싼 값만 뽑는다.
  const dbTypes = [...String(def).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const onlyCode = CODE_DOC_TYPES.filter((t) => !dbTypes.includes(t));
  const onlyDb = dbTypes.filter((t) => !CODE_DOC_TYPES.includes(t));
  line("DB 제약", dbTypes.join(", "));
  line("코드", CODE_DOC_TYPES.join(", "));
  if (onlyCode.length) { line("⛔ 코드에만 있음", onlyCode.join(", ")); blockers.push(`doc_type 불일치: ${onlyCode.join(",")}`); }
  if (onlyDb.length) line("(DB 에만 있음 — 화면 미노출)", onlyDb.join(", "));
  if (!onlyCode.length && !onlyDb.length) line("판정", "일치");

  // --- 5. 현재 신청 현황 -------------------------------------------------
  console.log("\n=== 현재 신청 현황 ===");
  for (const r of await q(`select status, count(*) n from private.verification_requests
                            group by status order by status`))
    line(r.status, `${r.n}건`);

  await c.query("rollback");
}

try {
  await main();
  console.log(`\nVERIFICATION_READY=${blockers.length ? "BLOCKED" : "PASS"}`);
  if (blockers.length) {
    console.log("준비해야 할 것:");
    for (const b of blockers) console.log(`  · ${b}`);
  }
} catch (e) {
  console.error("[fail] " + scrub(e.message || String(e), url));
} finally {
  try { await c.end(); } catch {}
}
process.exit(blockers.length ? 3 : 0);
