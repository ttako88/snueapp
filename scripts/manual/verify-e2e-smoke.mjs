// ============================================================
// verify-e2e-smoke.mjs — 인증 제출 흐름 실동작 검증
// ============================================================
// 비밀값을 넣은 뒤 "정말 되는가" 를 한 번에 확인한다. 정상 경로만이 아니라
// GPT 검수 §5 가 요구한 거부 경로까지 함께 본다 — 되는 것만 확인하면
// 막혀야 할 것이 안 막힌 상태를 못 잡는다.
//
// 준비
//   1) node scripts/manual/setup-verify-secret.mjs   (비밀값 등록)
//   2) npm run dev                                    (다른 터미널에서)
//   3) node scripts/manual/verify-e2e-smoke.mjs
//
// 무엇을 건드리는가
//   · 테스트 전용 auth 계정 2개를 만들고 끝나면 지운다 (계정 삭제 시
//     members·verification_requests 는 FK cascade 로 함께 정리된다)
//   · Storage 에 작은 PNG 를 올리고 지운다
//   · 기존 사용자 데이터는 읽지도 쓰지도 않는다
//
// 출력에 학번 원문·토큰·signed URL·계정 UUID 를 찍지 않는다.
// ============================================================
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

const BASE = process.env.SMOKE_BASE || "http://localhost:3000";
const FILE = resolve(process.cwd(), ".env.local");

function readEnv() {
  if (!existsSync(FILE)) return {};
  const map = {};
  for (const l of readFileSync(FILE, "utf8").split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return map;
}

const env = { ...readEnv(), ...process.env };
const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
const secret = env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  console.error("[중단] SUPABASE_SECRET_KEY 가 없습니다. setup-verify-secret.mjs 를 먼저 실행하세요.");
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");
const svc = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = "") {
  if (ok) pass++; else fail++;
  results.push(`  ${ok ? "✔" : "✖"} ${name}${detail ? `  — ${detail}` : ""}`);
}

// 1x1 PNG. magic bytes 검사를 통과하는 가장 작은 실제 이미지.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

const made = [];   // 정리 대상 계정
async function makeUser(tag) {
  const email = `smoke-${tag}-${randomBytes(6).toString("hex")}@snue.ac.kr`;
  const password = randomBytes(24).toString("base64url");
  const { data, error } = await svc.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (error) throw new Error(`테스트 계정 생성 실패: ${error.message}`);
  made.push(data.user.id);

  // 사용자 토큰을 얻는다 — 라우트는 Authorization 헤더의 토큰만 신뢰한다.
  const pub = createClient(url, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: sess, error: sErr } = await pub.auth.signInWithPassword({ email, password });
  if (sErr) throw new Error(`테스트 로그인 실패: ${sErr.message}`);
  return { id: data.user.id, token: sess.session.access_token, pub };
}

const post = (path, token, body) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

// 학번은 실재하지 않을 조합을 쓴다. 8자리 규칙은 지켜야 정규화를 통과한다.
const testStudentNo = () => `2026${String(Math.floor(Math.random() * 9000) + 1000)}`;

try {
  console.log(`=== 인증 E2E (${BASE}) ===\n`);

  // 서버가 살아 있고 비밀값을 들고 있는지 먼저 본다
  const ping = await fetch(`${BASE}/api/verification/begin`, { method: "POST", body: "{}" });
  if (ping.status === 503) {
    console.error("[중단] 라우트가 503 입니다 — dev 서버가 새 .env.local 을 못 읽었습니다.");
    console.error("       npm run dev 를 재시작한 뒤 다시 실행하세요.");
    process.exit(1);
  }

  const alice = await makeUser("a");
  const bob = await makeUser("b");

  // ── 정상 경로 ──────────────────────────────────────────────
  const begun = await post("/api/verification/begin", alice.token, {
    realName: "홍길동", studentNo: testStudentNo(), docType: "student_card",
  });
  check("begin 200", begun.status === 200, `status=${begun.status} ${begun.body?.error ?? ""}`);
  const { requestId, bucket, path, token } = begun.body ?? {};
  check("staging 경로로 발급", typeof path === "string" && path.startsWith("staging/"));
  check("응답에 hmac·실명 미포함",
    !JSON.stringify(begun.body ?? {}).match(/hmac|real_name|홍길동/i));

  if (requestId) {
    // 같은 사용자가 두 번 begin → 1건 제한
    const again = await post("/api/verification/begin", alice.token, {
      realName: "홍길동", studentNo: testStudentNo(), docType: "student_card",
    });
    check("동시 begin 차단 (1건 제한)", again.status === 409,
      `status=${again.status} ${again.body?.error ?? ""}`);

    // 남의 requestId 로 finalize
    const stolen = await post("/api/verification/finalize", bob.token, { requestId });
    check("남의 requestId finalize 거부", stolen.status === 404 || stolen.status === 409,
      `status=${stolen.status}`);

    // 업로드 전 finalize → 파일 없음
    const early = await post("/api/verification/finalize", alice.token, { requestId });
    check("업로드 전 finalize 거부", early.status === 409, `status=${early.status}`);

    // 실제 업로드
    const up = await alice.pub.storage.from(bucket).uploadToSignedUrl(path, token, PNG, {
      contentType: "image/png",
    });
    check("staging 업로드 성공", !up.error, up.error?.message ?? "");

    // finalize
    const fin = await post("/api/verification/finalize", alice.token, { requestId });
    check("finalize 200", fin.status === 200, `status=${fin.status} ${fin.body?.error ?? ""}`);
    check("서버가 형식을 image/png 로 판정", fin.body?.detectedType === "image/png");

    // DB 상태
    // private 스키마는 PostgREST 에 노출되지 않는다 — RPC 로 읽는다 (017)
    const { data: row } = await svc.rpc("svc_get_own_verification_request", {
      p_request_id: requestId, p_member_id: alice.id });
    check("status = submitted", row?.status === "submitted", `status=${row?.status}`);
    check("storage_path 가 verified/ 로 확정",
      typeof row?.storage_path === "string" && row.storage_path.startsWith("verified/"));

    // TOCTOU — 사용자가 받은 staging 토큰으로 verified 를 덮어쓸 수 있나
    if (row?.storage_path) {
      const evil = await alice.pub.storage.from(bucket)
        .uploadToSignedUrl(row.storage_path, token, Buffer.from("<script>evil</script>"));
      check("staging 토큰으로 verified 덮어쓰기 불가", Boolean(evil.error),
        evil.error ? "" : "⚠ 덮어써졌다");
    }

    // staging 객체가 정리됐나
    // ⚠ download() 는 없는 객체에도 오류 Blob 을 돌려줄 수 있어 `!data` 로
    //   판정하면 안 된다(실제로 오판했다). 목록 조회로 존재 여부를 직접 본다.
    const prefix = path.slice(0, path.lastIndexOf("/"));
    const leaf = path.slice(path.lastIndexOf("/") + 1);
    const { data: listed } = await svc.storage.from(bucket).list(prefix, { limit: 100 });
    const stillThere = (listed ?? []).some((o) => o.name === leaf);
    check("staging 객체 정리됨", !stillThere,
      stillThere ? "staging 파일이 남아 있다" : "");

    // finalize 재실행 — idempotent 하거나 안전하게 거부
    const redo = await post("/api/verification/finalize", alice.token, { requestId });
    check("finalize 재실행 안전", redo.status === 409 || redo.status === 200,
      `status=${redo.status}`);

    // 일반 사용자가 심사 문서 열람
    const peek = await post("/api/verification/document", bob.token, { requestId });
    check("일반 사용자 document 거부", peek.status === 403, `status=${peek.status}`);
    const selfPeek = await post("/api/verification/document", alice.token, { requestId });
    check("본인도 document 거부 (심사자 전용)", selfPeek.status === 403,
      `status=${selfPeek.status}`);
  }

  // 인증 없는 호출
  const noAuth = await fetch(`${BASE}/api/verification/begin`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  check("토큰 없는 begin 401", noAuth.status === 401, `status=${noAuth.status}`);

  // 잘못된 학번
  const badNo = await post("/api/verification/begin", bob.token, {
    realName: "홍길동", studentNo: "12345", docType: "student_card",
  });
  check("잘못된 학번 거부", badNo.status === 400 && badNo.body?.code === "student_no_format",
    `${badNo.status} ${badNo.body?.code ?? ""}`);

  // 허용 목록 밖 doc_type
  const badDoc = await post("/api/verification/begin", bob.token, {
    realName: "홍길동", studentNo: testStudentNo(), docType: "passport",
  });
  check("허용 밖 doc_type 거부", badDoc.status === 400, `status=${badDoc.status}`);

} catch (e) {
  check("예외 없이 완주", false, e.message);
} finally {
  // 테스트 계정 정리. 계정을 지우면 members·verification_requests 도 함께 간다.
  for (const id of made) {
    try { await svc.auth.admin.deleteUser(id); } catch { /* 아래에서 보고 */ }
  }
  // members 총계도 private 이라 못 읽는다. auth admin 으로 대신 센다.
  const { data: uAll } = await svc.auth.admin.listUsers({ page: 1, perPage: 1 });
  const count = uAll?.total ?? uAll?.users?.length ?? null;
  console.log(results.join("\n"));
  console.log(`\n정리: 테스트 계정 ${made.length}개 삭제 시도 · 남은 members ${count ?? "?"}행`);
  console.log(`\nVERIFY_E2E=${fail === 0 ? "PASS" : "FAIL"}  (통과 ${pass} / 실패 ${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}
