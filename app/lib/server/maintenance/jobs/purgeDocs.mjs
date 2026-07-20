// 공용 "파기 대상 claim → Storage 삭제 → 성공시 mark / 실패시 record_failure" 루프.
// expire-uploads 와 purge-verification-docs 가 claim RPC 이름만 달리해 공유(로직 분기 방지).
// GPT §C: 성공(또는 이미없음)일 때만 mark, 실패시 성공마킹 금지·record_failure. 행별 실패는 그 행만
//   failed 집계 후 계속(다음 실행 stale 재선별로 수렴). budget 소진 시 신규 claim 중단.
import { callRpc, asRows } from "../rpc.mjs";

export async function purgeClaimedDocs(ctx, claimRpc) {
  const { client, storage, budget, limit = 50 } = ctx;
  let processed = 0;
  let failed = 0;
  let hasMore = false;

  do {
    const rows = asRows(await callRpc(client, claimRpc, { p_limit: limit }, "claim"), "claim");
    for (const row of rows) {
      const id = row && row.req_id;
      const path = row && row.storage_path;
      try {
        const res = await storage.remove(path);
        if (res.ok) {
          await callRpc(client, "mark_verification_doc_purged", { p_req_id: id }, "mark");
          processed++;
        } else {
          await callRpc(
            client,
            "record_verification_purge_failure",
            { p_req_id: id, p_error_code: res.code || "storage_error" },
            "record_failure"
          );
          failed++;
        }
      } catch {
        failed++; // mark/record RPC 실패 등 → 이 행만 실패, 다음 행 계속
      }
    }
    hasMore = rows.length >= limit;
  } while (hasMore && budget.canStartMore());

  return { processed, failed, hasMore };
}
