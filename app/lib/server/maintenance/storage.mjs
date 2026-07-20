// Storage 삭제 어댑터. GPT §C: 고정 버킷 'verification-docs'만, RPC가 준 path도 서버에서
// 상대경로 안전성 재검사, 삭제 성공 또는 already-missing일 때만 성공으로 본다.
//
// 반환: { ok:true } | { ok:false, code:<안전코드> }

// 객체 경로 안전성: 빈 값·상대경로(..)·선행 slash·널바이트·백슬래시 거부.
export function isSafeObjectPath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.includes("..") &&
    path[0] !== "/" &&
    !path.includes("\\") &&
    !path.includes("\0")
  );
}

export function makeStorageRemover(client, bucket) {
  return {
    async remove(path) {
      if (!isSafeObjectPath(path)) return { ok: false, code: "unsafe_path" };
      try {
        const { error } = await client.storage.from(bucket).remove([path]);
        // Supabase는 없는 파일 remove에 오류를 내지 않음 → 오류 없음 = 성공(이미 없음 포함 수렴)
        if (error) return { ok: false, code: "storage_error" };
        return { ok: true };
      } catch {
        return { ok: false, code: "storage_error" };
      }
    },
  };
}
