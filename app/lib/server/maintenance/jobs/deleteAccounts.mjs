// delete-accounts 잡 (§13). GPT 필수 순서:
//   1 claim → 2 UUID 검증 → 3 prepare(멱등) → 4 detach → 5 get_paths → 6 Storage 전부 삭제
//   → 7 성공 시 DB 메타 정리(request별 mark) → 8 Auth Admin deleteUser → 9 converged 확인 → 10 기록
// 안전 게이트: prepare/detach/get_paths/Storage/메타정리 중 하나라도 실패하면 Auth 호출 안 함.
//   Auth 호출은 성공/오류 무관하게 converged로 최종 판정(오류·user_not_found여도 실제 삭제됐을 수 있음).
//   대상 UUID는 claim RPC 반환값만 사용(HTTP 입력 아님).
import { callRpc, asRows } from "../rpc.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH_CAP = 200; // 회원당 경로 상한 — 초과 시 이번 실행은 건너뛰고 다음 실행에서 처리

export async function deleteAccounts(ctx) {
  const { client, storage, auth, budget, limit = 20 } = ctx;
  let processed = 0;
  let failed = 0;
  let hasMore = false;

  const rows = asRows(
    await callRpc(client, "claim_accounts_for_deletion", { p_limit: limit }, "claim"),
    "claim"
  );

  for (const row of rows) {
    // 새 계정 파이프라인 착수 전 예산 확인 (이미 시작한 계정은 안전 경계까지 진행)
    if (!budget.canStartMore()) {
      hasMore = true;
      break;
    }
    const memberId = row && row.member_id;
    if (typeof memberId !== "string" || !UUID_RE.test(memberId)) {
      failed++;
      continue;
    }

    try {
      // 3~4: 멱등 prepare(이미 deleting이면 no-op) → detach
      await callRpc(client, "prepare_account_deletion", { p_member_id: memberId }, "prepare");
      await callRpc(client, "detach_member_content", { p_member_id: memberId }, "detach");

      // 5: 남은 인증 원본 경로 (req_id + storage_path)
      const paths = asRows(
        await callRpc(client, "get_member_verification_paths", { p_member_id: memberId }, "get_paths"),
        "get_paths"
      );
      if (paths.length > PATH_CAP) {
        failed++; // 상한 초과 → 다음 실행에서 처리(Auth 미진행)
        continue;
      }

      // 6: Storage 전부 삭제 — 하나라도 실패면 메타정리·Auth 진행 안 함
      let allRemoved = true;
      for (const p of paths) {
        const res = await storage.remove(p && p.storage_path);
        if (!res.ok) {
          allRemoved = false;
          break;
        }
      }
      if (!allRemoved) {
        failed++;
        continue;
      }

      // 7: Storage 성공 후 DB 메타(경로·실명) 정리 — 회원 결속 RPC로 "이 회원 소유+deleting"일 때만.
      //    반환 boolean이 true(파기 확정)가 아니면 Auth 금지(ID 혼선으로 타 회원 메타 삭제 방지).
      let metaOk = true;
      for (const p of paths) {
        try {
          const purged = await callRpc(
            client,
            "mark_member_verification_doc_purged",
            { p_req_id: p && p.req_id, p_member_id: memberId },
            "mark"
          );
          if (purged !== true) {
            metaOk = false;
            break;
          }
        } catch {
          metaOk = false;
          break;
        }
      }
      if (!metaOk) {
        failed++;
        continue;
      }

      // 8: Auth Admin 삭제 (남은 경로 0건 확인 후) — 대상은 claim이 준 UUID만
      await auth.deleteUser(memberId);

      // 9: 실제 삭제 완료 여부는 converged로 판정(Auth 성공/오류/타임아웃 무관)
      const converged = await callRpc(
        client,
        "account_deletion_converged",
        { p_member_id: memberId },
        "converged"
      );
      if (converged === true) processed++;
      else failed++; // converged=false → 다음 실행 재시도
    } catch {
      // prepare/detach/get_paths/converged RPC 실패 등 → 이 계정만 실패, Auth 미호출(위 흐름상 도달 안 함)
      failed++;
    }
  }

  hasMore = hasMore || rows.length >= limit;
  return { processed, failed, hasMore };
}
