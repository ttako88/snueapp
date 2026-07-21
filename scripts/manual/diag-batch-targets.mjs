// ============================================================
// diag-batch-targets.mjs — 배치가 건드릴 대상을 미리 센다 (READ-ONLY)
// ============================================================
// GPT 검수 6B: "dry-run 결과와 실제 mutation 경로를 분리하라. Cron 활성화와
// 실제 삭제는 하지 마라." 이 파일이 그 dry-run 쪽이다. 아무것도 바꾸지 않고
// 각 배치가 지금 실행되면 무엇을 집을지만 보여 준다.
//
// 배치가 실제로 무엇을 집는지는 009 의 claim_* RPC 가 정한다. 여기서 그
// 조건을 다시 쓰면 두 벌이 되어 어긋나므로, RPC 와 같은 조건을 **읽기로만**
// 재현하고 어긋나면 드러나도록 총계를 함께 낸다.
//
// 실제 실행은 /api/maintenance?job=... (CRON_SECRET 필요). 이 스크립트는
// 그 경로를 부르지 않는다.
// ============================================================
import pg from "pg";
import { readProdEnv, assertProdUrl, scrub } from "./prod-url.mjs";

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
assertProdUrl(url, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

const line = (k, v) => console.log(`  ${String(k).padEnd(40)} ${v}`);

try {
  await c.connect();
  // begin read only — 이 스크립트가 실수로 쓰기를 하면 DB 가 거부한다.
  await c.query("begin read only");
  const q = async (s, p = []) => (await c.query(s, p)).rows;
  const n = async (s, p = []) => Number((await q(s, p))[0].v);

  console.log("=== 1. expire-uploads — uploading 24시간 초과 ===");
  line("uploading 전체", await n(
    `select count(*) v from private.verification_requests where status='uploading'`));
  line("그중 24시간 초과 (전이 대상)", await n(
    `select count(*) v from private.verification_requests
      where status='uploading' and created_at < now() - interval '24 hours'`));
  line("경로가 비어 정리할 객체 없음", await n(
    `select count(*) v from private.verification_requests
      where status='uploading' and created_at < now() - interval '24 hours'
        and storage_path is null`));

  console.log("\n=== 2. stale-reviews — 심사 지연 ===");
  line("submitted 전체", await n(
    `select count(*) v from private.verification_requests where status='submitted'`));
  for (const d of [3, 7]) {
    line(`${d}일 이상 미심사`, await n(
      `select count(*) v from private.verification_requests
        where status='submitted' and submitted_at < now() - ($1 || ' days')::interval`, [d]));
    line(`  그중 알림 미발송`, await n(
      `select count(*) v from private.verification_requests
        where status='submitted' and submitted_at < now() - ($1 || ' days')::interval
          and ${d === 3 ? "owner_warned_3_at" : "owner_warned_7_at"} is null`, [d]));
  }

  console.log("\n=== 3. purge-verification-docs — 파기 대상 ===");
  line("purge_after 설정됨", await n(
    `select count(*) v from private.verification_requests where purge_after is not null`));
  line("purge_after 도달 · 미파기", await n(
    `select count(*) v from private.verification_requests
      where purge_after is not null and purge_after <= now() and purged_at is null`));
  line("파기 시도 실패 이력 있음", await n(
    `select count(*) v from private.verification_requests where purge_attempts > 0`));
  line("이미 파기 완료", await n(
    `select count(*) v from private.verification_requests where purged_at is not null`));

  console.log("\n=== 4. delete-accounts — 삭제 대기 ===");
  line("verification_status='deleting'", await n(
    `select count(*) v from private.members where verification_status='deleting'`));
  line("인증 기한 초과 (pending & 기한지남)", await n(
    `select count(*) v from private.members
      where verification_status='pending' and verification_deadline < now()`));

  console.log("\n=== 5. 고아 객체 — DB 가 모르는 Storage 객체 ===");
  // 배치가 지우는 것은 DB 가 아는 경로뿐이다. DB 어디에도 없는 객체는
  // 아무도 치우지 않으므로 따로 세어 둔다.
  const objs = await q(
    `select o.name from storage.objects o
      join storage.buckets b on b.id = o.bucket_id
     where b.id = 'verification-docs'`);
  const known = new Set((await q(
    `select storage_path p from private.verification_requests
      where storage_path is not null`)).map((r) => r.p));
  const orphan = objs.filter((o) => !known.has(o.name));
  line("버킷 객체 총수", objs.length);
  line("DB 가 아는 경로", known.size);
  line("고아 (DB 에 없음)", orphan.length);
  // 경로에는 회원 uuid 가 들어간다. 개수만 보고하고 경로는 찍지 않는다.
  const staging = orphan.filter((o) => o.name.startsWith("staging/")).length;
  line("  그중 staging/", staging);
  line("  그중 verified/", orphan.filter((o) => o.name.startsWith("verified/")).length);

  console.log("\n=== 6. 배치 실행 이력 ===");
  // batch_runs 는 실행 로그가 아니라 잡별 **최신 상태 1행**이다
  // (job_name 이 기본키). 이력을 기대하고 created_at 으로 정렬하면 없는
  // 컬럼이라 터진다 — 실제로 한 번 그렇게 틀렸다.
  const runs = await q(
    `select job_name, last_run_at, last_success_at, last_processed, fail_streak, last_error
       from private.batch_runs order by job_name`);
  if (!runs.length) line("(실행 이력 없음)", "Cron 미활성 상태와 일치");
  for (const r of runs)
    line(r.job_name, `마지막 ${r.last_run_at ? r.last_run_at.toISOString().slice(0, 16) : "-"}` +
      ` processed=${r.last_processed ?? "-"}` +
      (r.fail_streak > 0 ? `  ⚠ 연속실패 ${r.fail_streak}` : "") +
      (r.last_error ? `  (${String(r.last_error).slice(0, 40)})` : ""));

  console.log("\nBATCH_DRYRUN=READ_ONLY (아무것도 바꾸지 않았다)");
  await c.query("rollback");
} catch (e) {
  console.error("[fail] " + scrub(e.message || String(e), url));
} finally {
  try { await c.end(); } catch {}
}
