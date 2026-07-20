// RPC 호출·응답 검증 헬퍼. GPT §A: 반환 타입·필수필드·범위를 검증하고 예상 못한 응답은 fail-closed.
// 오류는 비식별 failedStep만 실어 던진다(원문·UUID·경로 미포함).
export async function callRpc(client, name, args, failedStep) {
  const { data, error } = await client.rpc(name, args);
  if (error) {
    const e = new Error(`${name} rpc error`);
    e.failedStep = failedStep;
    throw e;
  }
  return data;
}

// 카운트 RPC(정수·0 이상) 검증 — 아니면 fail-closed
export function asCount(v, failedStep) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || Math.floor(v) !== v) {
    const e = new Error("unexpected rpc count shape");
    e.failedStep = failedStep;
    throw e;
  }
  return v;
}

// 행 배열 RPC 검증 — 아니면 fail-closed
export function asRows(v, failedStep) {
  if (!Array.isArray(v)) {
    const e = new Error("unexpected rpc rows shape");
    e.failedStep = failedStep;
    throw e;
  }
  return v;
}
