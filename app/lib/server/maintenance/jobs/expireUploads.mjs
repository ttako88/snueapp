// expire-uploads 잡. claim_expired_uploads(전이+정리대상 반환) → Storage 삭제 → 성공/실패 표시.
// GPT §C: 성공 또는 already-missing일 때만 mark, 실패 시 성공마킹 금지·record_failure. 시간예산 이후
// 신규 claim 중단. 한 행의 RPC/Storage 실패는 그 행만 failed로 집계하고 계속 → 다음 실행에서 수렴.
import { callRpc, asRows } from "../rpc.mjs";

export async function expireUploads(ctx) {
  const { client, storage, budget, limit = 50 } = ctx;
  let processed = 0;
  let failed = 0;
  let hasMore = false;

  do {
    const rows = asRows(
      await callRpc(client, "claim_expired_uploads", { p_limit: limit }, "claim"),
      "claim"
    );
    for (const row of rows) {
      const id = row && row.req_id;
      const path = row && row.storage_path;
      try {
        const res = await storage.remove(path);
        if (res.ok) {
          // Storage 삭제 성공(또는 이미 없음) → 파기 완료 표시
          await callRpc(client, "mark_verification_doc_purged", { p_req_id: id }, "mark");
          processed++;
        } else {
          // 삭제 실패 → 성공마킹 금지, 안전 내부코드로 실패 기록(민감참조 유지 → 다음 실행 재시도)
          await callRpc(
            client,
            "record_verification_purge_failure",
            { p_req_id: id, p_error_code: res.code || "storage_error" },
            "record_failure"
          );
          failed++;
        }
      } catch {
        // mark/record RPC 실패 등 → 이 행만 실패 집계, 다음 행 계속. 다음 Cron이 stale 재선별로 수렴.
        failed++;
      }
    }
    hasMore = rows.length >= limit;
  } while (hasMore && budget.canStartMore());

  return { processed, failed, hasMore };
}
