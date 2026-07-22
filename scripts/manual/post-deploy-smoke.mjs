// ============================================================
// post-deploy-smoke.mjs — Vercel 배포 후 라이브 스모크 (읽기 전용, HTTP만)
// ============================================================
// 소유자가 Vercel 배포를 살린 뒤 한 방에 검증한다. 아무것도 바꾸지 않는다.
//   · 새 커밋이 실제로 라이브인지 (신규 라우트 /admin, /api/track 존재)
//   · 기존 핵심 라우트가 여전히 사는지 (회귀)
//   · flag 휴면 확인 (/api/track 이 disabled 응답 = productAnalytics OFF)
//
// 실행: node scripts/manual/post-deploy-smoke.mjs [https://snueapp.vercel.app]
// ============================================================
const BASE = (process.argv[2] || "https://snueapp.vercel.app").replace(/\/$/, "");
const fails = [];
const rec = (n, ok, d) => { if (!ok) fails.push(n); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

async function code(path, opts) {
  try { const r = await fetch(BASE + path, opts); return { status: r.status, r }; }
  catch (e) { return { status: 0, err: String(e) }; }
}

async function main() {
  console.log(`\n=== ${BASE} — 배포 후 스모크 ===`);

  // 1) 새 배포가 라이브인가 — 신규 라우트가 200 이어야(구 빌드엔 없어 404).
  console.log("\n[1] 신규 커밋 반영 확인");
  rec("/admin (신규 허브) 200", (await code("/admin")).status === 200);
  // /api/track 은 GET 을 안 받지만 라우트가 존재하면 405/400, 없으면 404.
  const track = await code("/api/track", { method: "GET" });
  rec("/api/track 라우트 존재(≠404)", track.status !== 404 && track.status !== 0, `status=${track.status}`);

  // 2) 기존 핵심 경로 회귀 — 여전히 살아야 한다.
  console.log("\n[2] 기존 경로 회귀");
  for (const p of ["/", "/login", "/board", "/courses", "/practicum/lesson-plan"]) {
    rec(`${p} 200`, (await code(p)).status === 200);
  }

  // 3) 휴면 확인 — 비로그인 /api/track POST 는 401(requireUser) 또는
  //    flag OFF 면 200 disabled. 어느 쪽이든 원시 수집은 안 일어난다.
  console.log("\n[3] 휴면 상태(대략)");
  const t = await code("/api/track", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "screen_view", target: "home" }),
  });
  rec("/api/track POST 비인증 차단/휴면", [200, 401, 403].includes(t.status), `status=${t.status}`);

  console.log(`\nSMOKE=${fails.length ? "FAIL" : "PASS"}`);
  if (fails.length) { for (const f of fails) console.log(`  · ${f}`); }
  console.log("\n참고: 지도안 owner 게이트는 로그인 세션이 있어야 확인 가능(수동). 비-owner 로그인 →");
  console.log("      /practicum/lesson-plan 에서 '준비 중' 표시 + 생성 시 403 not_available_yet 이어야 함.");
  return fails.length ? 1 : 0;
}

let c = 1;
try { c = await main(); } catch (e) { console.error("[fail] " + String(e)); }
process.exit(c);
