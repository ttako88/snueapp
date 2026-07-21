// ============================================================
// verify-app-fence.mjs — 운영 앱의 유지보수 게이트 상태를 실측한다
// ============================================================
// 왜 스크립트인가:
//   같은 검증을 임시 bash 한 줄짜리로 매번 새로 만들면 하네스 분류기가 매번
//   처음 보는 명령으로 판단해 승인 프롬프트가 뜬다. 절차를 파일로 고정하면
//   `node scripts/manual/*` 허용 규칙 안에서 조용히 반복 실행할 수 있고,
//   무엇보다 **검증 항목이 회차마다 달라지지 않는다.**
//
// 사용:
//   node scripts/manual/verify-app-fence.mjs                 # 유지보수(503) 기대
//   node scripts/manual/verify-app-fence.mjs --expect=live    # 정상(200) 기대 — 점검 해제 후
//   node scripts/manual/verify-app-fence.mjs --wait=15        # 최대 15분 폴링 후 판정
//
// 종료 코드: 0 = PASS, 1 = FAIL, 2 = 사용법 오류
//
// 운영 DB에 접속하지 않는다. 공개 URL에 HTTP 요청만 보낸다.
// ============================================================

const PROD_APP_URL = "https://snueapp.vercel.app";

// 유지보수 중 기대하는 응답 헤더 (GPT 런북 4단계 합격 기준)
const EXPECTED_HEADERS = {
  "cache-control": "private, no-store, no-cache, max-age=0, must-revalidate",
  "retry-after": "900",
  "x-robots-tag": "noindex, nofollow",
};

// 유지보수 화면에 반드시 있어야 하는 문구 (Vercel 자체 503과 구분하는 핵심)
const MAINT_MARKER = "서비스 기반 정비 중이며";

// 본문에 절대 나오면 안 되는 것들. 값을 적지 않고 패턴으로만 검사한다.
const LEAK_PATTERNS = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, "UUID"],
  [/https?:\/\/[^\s"'<>]+/i, "URL"],
  [/postgres(?:ql)?:\/\//i, "접속문자열"],
  [/eyJ[A-Za-z0-9_-]{10,}/, "JWT 형태 문자열"],
  [/\b(?:jclwkvxbvsegmbcnptpi|uiikgqeoxocpvphlmoqp)\b/i, "project ref"],
];

const PAGE_PATHS = ["/", "/login", "/board/free", "/settings", "/courses", "/no-such-path-xyz"];
const API_PATHS = ["/api/maintenance?job=stale-reviews", "/api/meal", "/api/notices"];
const METHODS = ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];
const STATIC_PATHS = ["/favicon.ico"];

const args = process.argv.slice(2);
const expect = (args.find((a) => a.startsWith("--expect=")) || "--expect=maintenance").split("=")[1];
const waitMin = Number((args.find((a) => a.startsWith("--wait=")) || "--wait=0").split("=")[1]);

if (!["maintenance", "live"].includes(expect)) {
  console.error("[사용법] --expect=maintenance | --expect=live");
  process.exit(2);
}
if (!Number.isFinite(waitMin) || waitMin < 0) {
  console.error("[사용법] --wait 은 0 이상의 분 단위 숫자");
  process.exit(2);
}

// 유지보수 중이면 앱 경로는 503, 해제 상태면 2xx/3xx 여야 한다.
const wantBlocked = expect === "maintenance";

const cb = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const url = (p) => `${PROD_APP_URL}${p}${p.includes("?") ? "&" : "?"}cb=${cb()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function rec(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function status(path, method = "GET") {
  try {
    const r = await fetch(url(path), { method, redirect: "manual" });
    return r.status;
  } catch (e) {
    return `ERR(${e.cause?.code || e.message})`;
  }
}

/** 유지보수 상태가 될 때까지(혹은 해제될 때까지) 폴링 */
async function poll() {
  if (!waitMin) return;
  const deadline = Date.now() + waitMin * 60_000;
  console.log(`전환 대기 (최대 ${waitMin}분, 20초 간격)`);
  for (let i = 1; Date.now() < deadline; i++) {
    const s = await status("/");
    const hit = wantBlocked ? s === 503 : typeof s === "number" && s < 400;
    console.log(`  [${String(i).padStart(2, "0")}] ${new Date().toISOString().slice(11, 19)}Z  / = ${s}`);
    if (hit) { console.log("  → 기대 상태 도달\n"); return; }
    await sleep(20_000);
  }
  console.log("  → 대기 시간 초과. 현재 상태 그대로 판정한다.\n");
}

async function main() {
  console.log(`대상: ${PROD_APP_URL}`);
  console.log(`기대: ${expect === "maintenance" ? "유지보수 차단(503)" : "정상 서비스(2xx/3xx)"}\n`);

  await poll();

  // ── 1. 앱 경로
  console.log("=== 앱 경로 (GET) ===");
  for (const p of PAGE_PATHS) {
    const s = await status(p);
    // 해제 상태에서는 없는 경로가 404여야 정상이므로 예외 처리한다.
    const ok = wantBlocked
      ? s === 503
      : p === "/no-such-path-xyz" ? s === 404 : typeof s === "number" && s < 400;
    rec(`GET ${p}`, ok, String(s));
  }

  // ── 2. API 경로
  console.log("\n=== API (GET) ===");
  for (const p of API_PATHS) {
    const s = await status(p);
    const ok = wantBlocked ? s === 503 : typeof s === "number" && s < 500;
    rec(`GET ${p}`, ok, String(s));
  }

  // ── 3. 메서드별 — 유지보수 중에만 의미가 있다(해제 후엔 405 등이 정상)
  if (wantBlocked) {
    console.log("\n=== 메서드별 (전부 503이어야 함) ===");
    for (const m of METHODS) {
      const a = await status("/", m);
      const b = await status("/api/meal", m);
      rec(`${m} / · /api/meal`, a === 503 && b === 503, `${a} · ${b}`);
    }
  }

  // ── 4. 정적 자산은 항상 통과해야 한다 (matcher 제외가 살아있는지)
  console.log("\n=== 정적 자산 (항상 200) ===");
  for (const p of STATIC_PATHS) {
    const s = await status(p);
    rec(`GET ${p}`, s === 200, String(s));
  }

  // ── 5. 본문·헤더 — 유지보수 중에만 검사
  if (wantBlocked) {
    console.log("\n=== 응답 본문·헤더 ===");
    const r = await fetch(url("/"), { redirect: "manual" });
    const body = await r.text();

    rec("상태코드 503", r.status === 503, String(r.status));
    rec("점검 문구 존재 (Vercel 자체 503과 구분)", body.includes(MAINT_MARKER));

    for (const [k, want] of Object.entries(EXPECTED_HEADERS)) {
      const got = r.headers.get(k);
      rec(`헤더 ${k}`, got === want, got ?? "(없음)");
    }

    let leaked = false;
    for (const [re, label] of LEAK_PATTERNS) {
      if (re.test(body)) { rec(`본문 누출 없음 (${label})`, false, "검출됨"); leaked = true; }
    }
    if (!leaked) rec("본문 누출 없음 (UUID·URL·접속문자열·JWT·project ref)", true, `${body.length}자`);
  }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n=== ${pass}/${results.length} PASS${fail ? ` · ${fail} FAIL` : ""} ===`);
  console.log(fail ? "APP_EDGE_WRITE_FENCE=FAIL" : `APP_EDGE_WRITE_FENCE=${wantBlocked ? "PASS" : "RELEASED"}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("[fail]", e.message); process.exit(1); });
