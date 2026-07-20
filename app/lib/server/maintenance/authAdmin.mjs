// Auth Admin 삭제 어댑터 (service_role). 실제 호출은 서버에서만.
// GPT: Auth 호출이 성공/오류/타임아웃/user_not_found 어느 쪽이든, 실제 삭제 완료 여부는
//   account_deletion_converged로 별도 확인한다(여기선 호출 시도만 하고 결과 해석은 호출측이 converged로).
export function makeAuthAdmin(client) {
  return {
    async deleteUser(userId) {
      try {
        const { error } = await client.auth.admin.deleteUser(userId);
        return { attempted: true, ok: !error };
      } catch {
        // 오류·타임아웃 — 실제 삭제됐을 수 있으므로 호출측이 converged로 최종 판정
        return { attempted: true, ok: false };
      }
    },
  };
}
