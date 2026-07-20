// expire-uploads 잡. claim_expired_uploads(uploading+24h → upload_expired 전이 + 정리대상 반환)
// 후 공용 파기 루프로 Storage 삭제·완료/실패 표시. (전이·재선별은 009 claim RPC 내부에서 처리)
import { purgeClaimedDocs } from "./purgeDocs.mjs";

export async function expireUploads(ctx) {
  return purgeClaimedDocs(ctx, "claim_expired_uploads");
}
