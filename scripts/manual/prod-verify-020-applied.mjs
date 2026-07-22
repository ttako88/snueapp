// ============================================================
// prod-verify-020-applied.mjs — 배포 게이트: 020 함수 존재 확인
// ============================================================
// GPT 020 MUST: "배포 파이프라인이 020 함수의 존재·시그니처를 카탈로그에서
// 확인한 뒤에만 새 라우트를 배포한다." finalize 라우트는 아래 3개 RPC 에
// 의존하므로, 운영 DB 에 없으면 배포가 인증 제출을 전부 깨뜨린다.
//
// 이 스크립트는 **읽기 전용**이다(begin read only). 3개 함수가 정확한
// 시그니처로 존재하면 exit 0, 하나라도 없으면 exit 3. 배포 절차가 이걸
// 통과(exit 0)해야만 push 로 넘어간다.
//
// 실행: node scripts/manual/prod-verify-020-applied.mjs
// 종료: 0 = 전부 존재(배포 가능) / 3 = 누락(배포 금지) / 2 = 접속·인자 오류
// ============================================================
import pg from "pg";
import { readProdEnv, assertProdUrl, PROD_REF } from "./prod-url.mjs";

const REQUIRED = [
  "public.svc_claim_verification_finalize(bigint, uuid)",
  "public.svc_finalize_verified(bigint, uuid, uuid)",
  "public.svc_release_verification_finalize(bigint, uuid, uuid)",
];

const line = (k, v) => console.log(`  ${String(k).padEnd(56)} ${v}`);

async function main() {
  const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
  assertProdUrl(url, "PROD_DB_URL");
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query("begin transaction read only");
    console.log(`\n=== 020 배포 게이트 (ref ${PROD_REF}) ===`);
    const missing = [];
    for (const sig of REQUIRED) {
      // to_regprocedure 는 존재하지 않으면 NULL 을 준다(예외 없음). OID 로 확인한다.
      const { rows } = await c.query("select to_regprocedure($1) is not null as ok", [sig]);
      const ok = rows[0]?.ok === true;
      line(sig, ok ? "PRESENT ✅" : "MISSING ❌");
      if (!ok) missing.push(sig);
    }
    await c.query("rollback");
    if (missing.length) {
      console.log(`\nDEPLOY_GATE_020=BLOCKED — 누락 ${missing.length}건. 020 을 먼저 적용하라.`);
      console.log("배포하면 finalize 가 없는 RPC 를 불러 인증 제출이 전부 실패한다.");
      process.exit(3);
    }
    console.log("\nDEPLOY_GATE_020=PASS — 3개 함수 전부 존재. 라우트 배포 가능.");
    process.exit(0);
  } catch (e) {
    try { await c.query("rollback"); } catch { /* already closed */ }
    console.error("[오류]", e.message);
    process.exit(2);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
