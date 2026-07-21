// bigint 식별자 취급 (커뮤니티 도메인 공용).
//
// posts.id / comments.id 는 PostgreSQL bigint 다. JavaScript 의 Number 는
// 2^53-1 까지만 정수를 정확히 표현하므로, 라우트에서 받은 id 를 Number 로
// 바꾸면 그 범위를 넘는 순간 값이 조용히 뭉개진다. 지금 당장은 id 가 작아도
// 코드에 그런 경로를 심어두면 나중에 데이터가 어긋난 뒤에야 발견된다.
//
// 그래서 문자열을 문자열 그대로 넘긴다. PostgREST 는 bigint 파라미터를
// 십진 문자열로 받는다. BigInt 객체는 JSON 직렬화가 안 되므로 쓰지 않는다.

/**
 * RPC 의 bigint 파라미터로 쓸 수 있게 정규화한다.
 * 십진 양의 정수만 통과시킨다. 잘못된 값을 0 이나 NaN 으로 바꿔 보내면
 * 엉뚱한 행을 건드릴 수 있으므로 통과시키지 않는다.
 *
 * 형식이 틀리면 null 을 돌려준다. 던지지 않는 이유는 호출부가
 * `const { error } = await ...` 계약에 맞춰져 있어서, 예외를 던지면
 * 처리되지 않은 rejection 이 되어 사용자에게 아무 안내도 못 하기 때문이다.
 */
export function asBigintParam(id) {
  const s = typeof id === "string" ? id.trim() : String(id ?? "");
  return /^[1-9][0-9]*$/.test(s) ? s : null;
}

/** supabase 와 같은 모양의 오류 응답 — 호출부 분기를 그대로 쓰게 한다 */
export function invalidIdResult() {
  return { data: null, error: { message: "invalid id" } };
}
