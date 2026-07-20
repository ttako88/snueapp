// purge-verification-docs 잡. purge_after 경과 인증 원본을 Storage에서 삭제하고 성공 시 메타 정리.
// 공용 파기 루프 사용(claim RPC만 다름).
import { purgeClaimedDocs } from "./purgeDocs.mjs";

export async function purgeVerificationDocs(ctx) {
  return purgeClaimedDocs(ctx, "claim_verification_docs_to_purge");
}
