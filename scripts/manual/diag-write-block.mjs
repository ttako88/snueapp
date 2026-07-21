// ============================================================
// diag-write-block.mjs — 글쓰기 RLS 차단 원인 특정 (READ-ONLY)
// ============================================================
// posts_insert 정책은 authz.is_writable_member() 와 authz.board_access_ok()
// 를 함께 본다. 둘 중 무엇이 false 인지 갈라야 조치가 달라진다.
//
// is_writable_member 는 nickname not null / verification_status='verified' /
// sanction='none' 셋을 모두 요구한다. 어느 조건에서 걸리는지 개별로 본다.
//
// 개인정보는 출력하지 않는다 — 이름·학번 해시는 조회하지 않고, 상태 플래그만 본다.
// READ-ONLY.
// ============================================================
import pg from "pg";
import { readProdEnv, assertProdUrl, scrub } from "./prod-url.mjs";

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const line = (k, v) => console.log(`  ${String(k).padEnd(40)} ${v}`);

async function main() {
  await c.connect();
  await c.query("begin read only");
  const q = async (s, p = []) => (await c.query(s, p)).rows;

  console.log("=== 회원 상태 (플래그만) ===");
  const ms = await q(`select m.id, m.nickname is not null has_nick,
       m.verification_status, m.sanction, m.role
     from private.members m order by m.created_at`);
  for (const m of ms) {
    line("member", String(m.id).slice(0, 8) + "…");
    line("  닉네임 설정", m.has_nick);
    line("  verification_status", m.verification_status);
    line("  sanction", m.sanction);
    line("  role", m.role);
  }

  console.log("\n=== is_writable_member 조건 분해 ===");
  for (const m of ms) {
    const ok = m.has_nick && m.verification_status === "verified" && m.sanction === "none";
    console.log(`  ${String(m.id).slice(0, 8)}… → 쓰기가능=${ok}`);
    if (!ok) {
      if (!m.has_nick) console.log("      · 닉네임 미설정");
      if (m.verification_status !== "verified")
        console.log(`      · verification_status 가 '${m.verification_status}' — 'verified' 여야 한다`);
      if (m.sanction !== "none") console.log(`      · sanction 이 '${m.sanction}'`);
    }
  }

  console.log("\n=== board_access_ok 관련 — 게시판 access 등급 ===");
  for (const b of await q(`select id, slug, access from public.boards order by sort`))
    line(`  ${b.slug}`, b.access);

  console.log("\n=== 인증 심사 대기열 ===");
  const vr = await q(`select status, count(*) v from private.verification_requests group by 1`);
  if (!vr.length) console.log("  (제출된 인증 요청 없음)");
  for (const r of vr) line(`  ${r.status}`, r.v);

  console.log("\n=== owner 존재 여부 ===");
  const owners = Number((await q(`select count(*) v from private.members where role='owner'`))[0].v);
  line("owner 수", owners);
  if (owners === 0) {
    console.log("  → owner 가 없으면 인증 심사를 승인할 사람도 없다.");
    console.log("    bootstrap-owner.sql 이 그 최초 1명을 만드는 유일한 경로다.");
  }

  await c.query("rollback");
}

try { await main(); }
catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
