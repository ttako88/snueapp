// ============================================================
// prod-provision-verify-bucket.mjs — 인증 서류 비공개 버킷 생성
// ============================================================
// 006_storage_policies.sql 은 "버킷이 이미 있다" 를 전제로 정책만 다룬다.
// 버킷 자체를 만드는 것이 이 스크립트다.
//
// 왜 SQL 로 만드는가: 버킷 생성 API 는 service_role 키를 요구하는데 그 키가
// 아직 등록돼 있지 않다. storage.buckets 는 평범한 테이블이고, 여기 한 행을
// 넣는 것이 API 가 하는 일과 같다.
//
// 안전장치
//   · 기본은 DRY-RUN. 실제 적용은 --apply 를 붙여야 한다
//   · 이미 있으면 아무것도 하지 않는다 (설정이 다르면 보고만 하고 중단)
//   · public=false 고정. 공개 버킷은 만들지 않는다
//   · storage.objects 는 건드리지 않는다 (006 §7)
// ============================================================
import pg from "pg";
import { readProdEnv, assertProdUrl, scrub } from "./prod-url.mjs";

const APPLY = process.argv.includes("--apply");
const BUCKET = "verification-docs";
const MAX_BYTES = 10 * 1024 * 1024;
// 서버가 magic bytes 로 다시 검증하지만, 버킷 레벨에서도 좁혀 둔다 — 심층 방어.
const MIME = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

const line = (k, v) => console.log(`  ${String(k).padEnd(24)} ${v}`);

async function main() {
  await c.connect();
  const q = async (s, p = []) => (await c.query(s, p)).rows;

  const [existing] = await q(
    `select id, public, file_size_limit, allowed_mime_types
       from storage.buckets where id = $1::text`, [BUCKET]);

  console.log(`=== 대상 버킷: ${BUCKET} ===`);
  if (existing) {
    line("상태", "이미 있음");
    line("public", existing.public);
    line("size limit", existing.file_size_limit);
    line("mime", (existing.allowed_mime_types ?? []).join(", ") || "(제한 없음)");
    if (existing.public) {
      console.log("\n⛔ 공개 버킷이다. 인증 서류가 URL 만 알면 열린다.");
      console.log("   이 스크립트는 기존 버킷을 바꾸지 않는다 — 수동 확인 후 조치할 것.");
      return 3;
    }
    console.log("\nBUCKET_PROVISION=ALREADY_OK");
    return 0;
  }

  line("상태", "없음 — 생성 필요");
  line("public", "false");
  line("size limit", `${MAX_BYTES} (10MB)`);
  line("mime", MIME.join(", "));

  if (!APPLY) {
    console.log("\n(DRY-RUN) 실제로 만들려면 --apply 를 붙여 다시 실행.");
    console.log("BUCKET_PROVISION=DRYRUN");
    return 0;
  }

  // owner 는 넣지 않는다 — service_role 로 만든 버킷의 소유자를 특정 사용자로
  // 묶으면 그 계정이 사라질 때 곤란해진다.
  await c.query("begin");
  try {
    await c.query(
      `insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
       values ($1::text, $1::text, false, $2::bigint, $3::text[])`,
      [BUCKET, MAX_BYTES, MIME]);
    // 방금 만든 것이 정말 비공개인지 같은 트랜잭션에서 확인하고 커밋한다.
    const [chk] = (await c.query(
      `select public from storage.buckets where id = $1::text`, [BUCKET])).rows;
    if (!chk || chk.public !== false) throw new Error("생성 직후 검증 실패 — 롤백");
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  }

  console.log("\nBUCKET_PROVISION=CREATED");
  return 0;
}

let code = 1;
try { code = await main(); }
catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); code = 1; }
finally { try { await c.end(); } catch {} }
process.exit(code);
