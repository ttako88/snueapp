// ============================================================
// setup-wizard.mjs — 설정 한 번에 끝내기 (본인 터미널 전용)
// ============================================================
//   npm run setup
//
// 이 프로그램 하나로 앞으로 필요한 값을 전부 등록한다.
// 여러 번 실행해도 안전하다 — 이미 있는 값은 건드리지 않고 빠진 것만 묻는다.
// 모르는 항목은 엔터로 건너뛰고 나중에 다시 실행하면 된다.
//
// 설계 원칙
//   · 값은 **마스킹된 대화형 입력**으로만 받는다. 명령 인자·환경변수 접두사·
//     echo 파이프로 받지 않는다 — 셸 기록·프로세스 목록에 값이 남는다.
//   · 화면에 값을 찍지 않는다. 있음/없음과 길이만 보여준다.
//   · 학번은 받는 즉시 HMAC 으로 바꾸고 원문을 버린다.
//   · TTY 가 아니면 즉시 중단 — 파이프·CI·에이전트가 값을 가져갈 수 없다.
//   · 사용자 계정 비밀번호는 묻지 않는다. Supabase Auth 가 관리하며
//     이 프로젝트 어디에도 저장되지 않는다.
//
// 범위 결정 근거: docs/COLLAB_STATE.md "소유자 오버라이드 기록" 참조.
// GPT 는 토큰 일괄 수집을 BLOCKER 로 판정했으나 소유자가 위험을 인지하고
// 명시적으로 기각했다. 대신 Claude 가 프로젝트 고정 래퍼를 자체 부담한다.
// ============================================================
import { writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { stdin, stdout, exit } from "node:process";
import { randomBytes, createHmac } from "node:crypto";

const LOCAL = resolve(process.cwd(), ".env.local");
const PROD = resolve(process.cwd(), ".env.prod.local");
const VERCEL_OUT = resolve(process.cwd(), ".env.vercel.local");

if (!stdin.isTTY) {
  console.error("[중단] 실제 터미널에서만 실행할 수 있습니다 (파이프·리다이렉트 금지).");
  exit(1);
}

// ── 입력 헬퍼 ────────────────────────────────────────────────
const ETX = 3, BS = 8, LF = 10, CR = 13, DEL = 127;

function ask(label, { masked = true } = {}) {
  return new Promise((res) => {
    stdout.write(label);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    let buf = "";
    const onData = (ch) => {
      const code = ch[0];
      if (code === CR || code === LF) {
        stdin.removeListener("data", onData);
        stdin.setRawMode(Boolean(wasRaw));
        stdin.pause();
        stdout.write("\n");
        res(buf.trim());
      } else if (code === ETX) {
        stdout.write("\n중단했습니다. 지금까지 입력한 것은 저장되지 않았습니다.\n");
        exit(130);
      } else if (code === BS || code === DEL) {
        if (buf.length) { buf = buf.slice(0, -1); stdout.write("\b \b"); }
      } else {
        // 붙여넣기는 여러 글자가 **한 덩어리**로 들어온다. 예전에는 덩어리당
        // 별 하나만 찍어서 "한 글자만 들어갔나" 싶게 보였다. 글자 수만큼 찍는다.
        const s = ch.toString("utf8");
        const hasEnter = /[\r\n]/.test(s);
        const clean = s.replace(/[\r\n]/g, "");   // 붙여넣기에 섞인 줄바꿈 제거
        if (clean) {
          buf += clean;
          stdout.write(masked ? "*".repeat([...clean].length) : clean);
        }
        // 줄바꿈이 포함된 붙여넣기는 그대로 입력 완료로 처리한다
        if (hasEnter) {
          stdin.removeListener("data", onData);
          stdin.setRawMode(Boolean(wasRaw));
          stdin.pause();
          stdout.write("\n");
          res(buf.trim());
        }
      }
    };
    stdin.on("data", onData);
  });
}

function readEnv(file) {
  if (!existsSync(file)) return {};
  const map = {};
  for (const l of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return map;
}

function upsertEnv(file, pairs) {
  if (!Object.keys(pairs).length) return 0;
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(pairs)) {
    const i = lines.findIndex((l) => new RegExp(`^${k}=`).test(l.trim()));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  writeFileSync(file, lines.join("\n"), "utf8");
  try { chmodSync(file, 0o600); } catch { /* Windows 무시 */ }
  return Object.keys(pairs).length;
}

const gen = () => randomBytes(48).toString("base64url");
const mark = (v) => (v ? "✓" : "·");

// ── 시작 ─────────────────────────────────────────────────────
const local = readEnv(LOCAL);
const prod = readEnv(PROD);
const toLocal = {}, toProd = {}, vercel = {};

console.log(`
╔════════════════════════════════════════════════════════════╗
║  SNUE 설정 마법사                                          ║
║                                                            ║
║  · 값은 화면에 * 로만 보이고 저장 후에도 출력하지 않습니다     ║
║  · 모르는 항목은 그냥 엔터 → 건너뜁니다                      ║
║  · 나중에 다시 실행하면 빠진 것만 다시 묻습니다               ║
║  · Ctrl+C 로 언제든 중단 가능                               ║
╚════════════════════════════════════════════════════════════╝

현재 등록 상태
  ${mark(local.NEXT_PUBLIC_SUPABASE_URL)} Supabase 주소        ${mark(local.SUPABASE_SECRET_KEY)} Supabase 비밀키
  ${mark(prod.PROD_DB_URL)} 운영 DB 주소         ${mark(prod.SUPABASE_ACCESS_TOKEN)} Supabase 관리 토큰
  ${mark(prod.VERCEL_TOKEN)} Vercel 토큰          ${mark(prod.GITHUB_TOKEN)} GitHub 토큰
  ${mark(prod.KAKAO_REST_API_KEY)} 카카오 키            ${mark(prod.GOOGLE_CLIENT_ID)} 구글 키
  ${mark(local.GEMINI_API_KEY)} 제미나이 키          ${mark(prod.OWNER_REAL_NAME)} 실명
  ${mark(prod.OWNER_STUDENT_NO_HMAC)} 학번(암호화)
`);

// ── 공통: 값 하나 받기 ───────────────────────────────────────
// 한 항목만 고치려고 12번 엔터를 치게 만들면 안 쓴다.
//   npm run setup gemini   → GEMINI_API_KEY 만 묻는다
//   npm run setup vercel   → 이름에 VERCEL 이 든 항목만
const ONLY = (process.argv[2] ?? "").toUpperCase();
const skip = (key) => ONLY && !key.includes(ONLY);
const banner = (s) => { if (!ONLY) console.log(s); };

async function collect({ key, label, where, note, store, target, validate }) {
  if (skip(key)) return;
  const cur = store[key];
  console.log(`\n${label}${cur ? "   [이미 등록됨 — 엔터=유지]" : ""}`);
  if (where) console.log(`   받는 곳: ${where}`);
  if (note) console.log(`   ${note}`);
  const v = await ask("   > ");
  if (!v) return;
  if (validate) {
    const err = validate(v);
    if (err) { console.log(`   ⛔ ${err} — 이 항목은 건너뜁니다.`); return; }
  }
  target[key] = v;
  console.log(`   저장했습니다 (${v.length}자)`);
}

// ══ 1. Supabase ═════════════════════════════════════════════
banner(`
━━ 1 / 6  Supabase ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

await collect({
  key: "SUPABASE_SECRET_KEY", store: local, target: toLocal,
  label: "① Supabase 비밀키  (이게 없으면 학생 인증이 동작하지 않습니다)",
  where: "supabase.com → 프로젝트 → Settings → API Keys → secret / service_role",
  validate: (v) => /^sb_publishable_/.test(v) ? "공개키입니다. secret 키가 필요합니다"
    : (!/^sb_secret_/.test(v) && !/^ey/.test(v)) ? "secret 키 형식이 아닙니다" : null,
});

await collect({
  key: "SUPABASE_ACCESS_TOKEN", store: prod, target: toProd,
  label: "② Supabase 관리 토큰  (소셜 로그인·메일 설정을 제가 대신 처리)",
  where: "supabase.com/dashboard/account/tokens → Generate new token",
  note: "이 토큰은 계정 전체 권한입니다. 제 도구가 SNUE 프로젝트만 건드리도록\n   고정 래퍼를 씁니다. 폐기: 같은 화면에서 Revoke",
});

// ══ 2. Vercel ═══════════════════════════════════════════════
banner(`
━━ 2 / 6  Vercel  (배포·환경변수·롤백을 제가 처리하게 됩니다) ━━━`);

await collect({
  key: "VERCEL_TOKEN", store: prod, target: toProd,
  label: "③ Vercel 토큰",
  where: "vercel.com/account/tokens → Create Token",
  note: "Scope 를 SNUE 프로젝트로 좁혀주세요 (계정 전체보다 안전합니다)",
});
await collect({
  key: "VERCEL_PROJECT_ID", store: prod, target: toProd,
  label: "④ Vercel 프로젝트 ID  (비밀 아님)",
  where: "Vercel → 프로젝트 → Settings → General → Project ID",
});
await collect({
  key: "VERCEL_ORG_ID", store: prod, target: toProd,
  label: "⑤ Vercel 팀/계정 ID  (비밀 아님)",
  where: "Vercel → Settings → General → Team ID (개인 계정이면 Your ID)",
});

// ══ 3. GitHub ═══════════════════════════════════════════════
banner(`
━━ 3 / 6  GitHub  (푸시·PR) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

await collect({
  key: "GITHUB_TOKEN", store: prod, target: toProd,
  label: "⑥ GitHub 토큰 (Fine-grained)",
  where: "github.com/settings/personal-access-tokens/new",
  note: "Repository access = Only select repositories → ttako88/snueapp 하나만\n   Permissions = Contents(RW) · Pull requests(RW) · Metadata(R)\n   Classic 토큰 말고 Fine-grained 로 만들어 주세요",
});

// ══ 4. 소셜 로그인 ═══════════════════════════════════════════
banner(`
━━ 4 / 6  소셜 로그인  (지금 몰라도 됩니다 — 나중에 다시 실행) ━━`);

await collect({
  key: "KAKAO_REST_API_KEY", store: prod, target: toProd,
  label: "⑦ 카카오 REST API 키",
  where: "developers.kakao.com → 내 애플리케이션 → 앱 키 → REST API 키",
});
await collect({
  key: "KAKAO_CLIENT_SECRET", store: prod, target: toProd,
  label: "⑧ 카카오 Client Secret",
  where: "카카오 → 제품 설정 → 카카오 로그인 → 보안 → Client Secret 생성",
});
await collect({
  key: "GOOGLE_CLIENT_ID", store: prod, target: toProd,
  label: "⑨ 구글 OAuth Client ID",
  where: "console.cloud.google.com → API 및 서비스 → 사용자 인증 정보",
  note: "범위는 openid / email / profile 만. Gmail·Drive 권한은 넣지 마세요",
});
await collect({
  key: "GOOGLE_CLIENT_SECRET", store: prod, target: toProd,
  label: "⑩ 구글 Client Secret",
  where: "위와 같은 화면",
});

// ══ 5. AI ═══════════════════════════════════════════════════
// 이 항목은 처음에 빠져 있었다. 위저드가 12항목이라 다 넣은 줄 알았는데
// 정작 지도안 생성기가 쓰는 키가 없었다. 목록을 세지 말고 기능에서 역산할 것.
banner(`
━━ 5 / 6  AI  (수업지도안 생성기) ━━━━━━━━━━━━━━━━━━━━━━━━━━`);

await collect({
  key: "GEMINI_API_KEY", store: local, target: toLocal,
  label: "⑪ 제미나이 API 키  (이게 없으면 지도안 생성이 동작하지 않습니다)",
  where: "aistudio.google.com/apikey → API 키 만들기",
  note: "등록 후 `npm run lesson:samples` 를 돌리면 바탕화면\n   클로드/지도안_출력물/ 폴더에 샘플 지도안이 저장됩니다.\n   일일 비용 상한이 걸려 있습니다 (기본 5,000원)",
  // ⚠️ 접두사로 거르지 않는다. 처음에 `AIza` 만 통과시켰다가 소유자의 실제 키
  //   (`AQ.` 로 시작)를 거부했다. 구글이 키 형식을 바꿔도 이 파일은 모른다.
  //   형식 추측으로 정상 입력을 막느니, 길이만 보고 받은 뒤 **실제 호출로**
  //   맞는지 확인하는 편이 옳다 (저장 직후 검증이 돈다).
  validate: (v) => v.length < 20 ? "너무 짧습니다 — 키가 잘려서 붙여넣어진 것 같습니다"
    : /\s/.test(v) ? "공백이 섞여 있습니다" : null,
});

// ══ 6. 관리자 신원 ═══════════════════════════════════════════
// 이 둘은 collect() 를 안 쓰므로 필터를 직접 건다.
const askOwner = !skip("OWNER_REAL_NAME");
const askStudent = !skip("OWNER_STUDENT_NO_HMAC");
if (askOwner || askStudent) banner(`
━━ 6 / 6  관리자 계정 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

let realName = "";
if (askOwner) {
  console.log(`\n⑫ 실명  (운영에서 상호님 계정을 owner 로 올릴 때만 씁니다)${
    prod.OWNER_REAL_NAME ? "   [이미 등록됨 — 엔터=유지]" : ""}`);
  realName = await ask("   > ", { masked: false });
}
if (realName) toProd.OWNER_REAL_NAME = realName;

let studentNo = "";
if (askStudent) {
  console.log(`\n⑬ 학번 8자리${prod.OWNER_STUDENT_NO_HMAC ? "   [이미 등록됨 — 엔터=유지]" : ""}
   넣는 즉시 되돌릴 수 없는 값으로 바꾸고 원문은 버립니다`);
  studentNo = await ask("   > ");
}
if (studentNo) {
  const norm = studentNo.replace(/[\s-]/g, "");
  if (!/^\d{8}$/.test(norm)) {
    console.log("   ⛔ 학번은 숫자 8자리입니다 — 이 항목은 건너뜁니다.");
  } else {
    const hmacKey = prod.STUDENT_NO_HMAC_KEY_V1 || gen();
    toProd.STUDENT_NO_HMAC_KEY_V1 = hmacKey;
    toProd.STUDENT_NO_HMAC_CURRENT_VERSION = "1";
    toProd.OWNER_STUDENT_NO_HMAC = createHmac("sha256", hmacKey).update(norm, "utf8").digest("hex");
    toProd.OWNER_HMAC_KEY_VERSION = "1";
    console.log("   암호화해 저장했습니다. 원문은 저장하지 않았습니다.");
  }
}

// ══ 자동 생성 ════════════════════════════════════════════════
if (!local.VERIFY_HMAC_KEY_V1) {
  toLocal.VERIFY_HMAC_KEY_V1 = gen();
  toLocal.VERIFY_HMAC_CURRENT_VER = "1";
}
if (!local.CRON_SECRET) toLocal.CRON_SECRET = gen();

// ══ 저장 ═════════════════════════════════════════════════════
const nLocal = upsertEnv(LOCAL, toLocal);
const nProd = upsertEnv(PROD, toProd);

// ══ 비밀키 실동작 확인 ═══════════════════════════════════════
const secret = toLocal.SUPABASE_SECRET_KEY || local.SUPABASE_SECRET_KEY;
const url = local.SUPABASE_URL || local.NEXT_PUBLIC_SUPABASE_URL;
let canary = "확인 안 함";
if (secret && url) {
  stdout.write("\nSupabase 비밀키 실동작 확인 중… ");
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const svc = createClient(url, secret, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // ⚠ private 스키마로 확인하지 않는다. 그 스키마는 보안 설계상 PostgREST 에
    //   노출하지 않으므로(노출 스키마 = public, graphql_public) service_role 이라도
    //   406 PGRST106 이 난다. 키가 멀쩡해도 실패로 보인다 — 실제로 그렇게 오판했다.
    //   service_role 여부는 auth admin API 로 확인하는 것이 정확하다.
    const probe = await svc.auth.admin.listUsers({ page: 1, perPage: 1 });
    canary = probe.error ? `실패 — ${probe.error.message || probe.error.name}` : "정상";
  } catch (e) { canary = `확인 못 함 (${e.message})`; }
  console.log(canary);
}

// ══ 제미나이 키 실동작 확인 ══════════════════════════════════
// 접두사 검사를 없앤 대신 여기서 **실제로 호출해** 맞는지 본다.
// 형식 추측보다 이쪽이 정확하고, 틀린 키를 조용히 저장하는 일도 없다.
const gkey = toLocal.GEMINI_API_KEY || local.GEMINI_API_KEY;
if (gkey && !skip("GEMINI_API_KEY")) {
  stdout.write("\n제미나이 키 실동작 확인 중… ");
  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
      { method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": gkey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "안녕" }] }],
          generationConfig: { maxOutputTokens: 8 },
        }) });
    if (r.ok) {
      const j = await r.json();
      console.log(`정상 (응답 모델: ${j?.modelVersion ?? "미상"})`);
      console.log("   → `npm run lesson:samples` 로 지도안 샘플을 뽑을 수 있습니다.");
    } else {
      // 키를 지우지는 않는다. 소유자가 값을 다시 찾아오게 만드는 비용이 더 크다.
      const t = await r.text().catch(() => "");
      let m = ""; try { m = JSON.parse(t)?.error?.message ?? ""; } catch { m = t.slice(0, 120); }
      console.log(`실패 — ${r.status}${m ? `: ${m}` : ""}`);
      console.log("   저장은 해 뒀습니다. 키가 맞는지 확인 후 다시 실행해 주세요.");
    }
  } catch (e) { console.log(`확인 못 함 (${e.message}) — 네트워크 문제일 수 있습니다.`); }
}

// ══ Vercel 붙여넣기 파일 ═════════════════════════════════════
vercel.SUPABASE_SECRET_KEY = "(마법사에 넣은 것과 같은 값)";
vercel.VERIFY_HMAC_KEY_V1 = gen();
vercel.VERIFY_HMAC_CURRENT_VER = "1";
vercel.CRON_SECRET = gen();

writeFileSync(VERCEL_OUT, [
  "# Vercel 환경변수 — 복사해서 붙여넣은 뒤 이 파일을 지우세요.",
  "# Vercel → 프로젝트 → Settings → Environment Variables → Production",
  "#",
  "# ⚠ VERIFY_HMAC_KEY_V1 은 잃으면 복구할 수 없습니다.",
  "#   학번 원문을 저장하지 않으므로 다시 계산할 방법이 없습니다.",
  "",
  ...Object.entries(vercel).map(([k, v]) => `${k}=${v}`),
  "",
].join("\n"), "utf8");
try { chmodSync(VERCEL_OUT, 0o600); } catch {}

// ══ 마무리 ═══════════════════════════════════════════════════
console.log(`
╔════════════════════════════════════════════════════════════╗
║  저장 완료                                                 ║
╚════════════════════════════════════════════════════════════╝
  .env.local        ${nLocal}개
  .env.prod.local   ${nProd}개
  Supabase 비밀키   ${canary}
  (전부 git 에 올라가지 않습니다)

남은 것 — Vercel 환경변수
  .env.vercel.local 파일을 열어 값을 Vercel 에 붙여넣고,
  다 넣으신 뒤 그 파일은 지우세요.
  ※ Vercel 토큰을 넣으셨다면 이것도 제가 대신 하겠습니다.

건너뛴 항목이 있으면 언제든 다시:  npm run setup

확인:
  npm run verify:ready     설정 점검
  npm run verify:e2e       실제 동작 (dev 서버 필요)
`);
