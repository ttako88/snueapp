// ============================================================
// setup-verify-secret.mjs — 인증 파이프라인 비밀값 등록 (본인 터미널 전용)
// ============================================================
// 이 스크립트 하나만 실행하면 인증 기능이 로컬에서 즉시 동작한다.
//   ① SUPABASE_SECRET_KEY 를 입력받아 .env.local 에 기록 (화면에 찍지 않음)
//   ② 그 키가 실제로 동작하는지 Supabase 에 물어 확인
//   ③ 로컬 HMAC 키가 없으면 생성
//   ④ 운영(Vercel)에 넣을 값을 한 번만 보여 준다
//
// 사용:
//   node scripts/manual/setup-verify-secret.mjs
//
// 안전장치
//   · TTY 가 아니면 즉시 중단 — 파이프·CI·에이전트가 값을 가져갈 수 없다.
//     그래서 이 스크립트는 Claude 가 대신 실행해 줄 수 없다. 의도된 설계다.
//   · 입력값은 화면에 표시하지 않고 마스킹만 보여 준다
//   · .env.local 의 다른 줄은 건드리지 않는다
//   · 파일 권한을 소유자 전용으로 제한 시도
// ============================================================
import { writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { stdin, stdout, exit } from "node:process";
import { randomBytes } from "node:crypto";

const FILE = resolve(process.cwd(), ".env.local");

if (!stdin.isTTY) {
  console.error("[중단] 실제 터미널에서만 실행할 수 있습니다 (파이프·리다이렉트 금지).");
  exit(1);
}

function askHidden(label) {
  return new Promise((res) => {
    stdout.write(label);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    let buf = "";
    // 제어문자는 코드포인트로 비교한다. 소스에 그대로 써 넣으면 편집기·도구를
    // 거치며 조용히 사라져 "Ctrl+C 가 안 먹는" 식으로 망가진다.
    const ETX = 3, BS = 8, LF = 10, CR = 13, DEL = 127;
    const onData = (ch) => {
      const code = ch[0];
      if (code === CR || code === LF) {
        stdin.removeListener("data", onData);
        stdin.setRawMode(Boolean(wasRaw));
        stdin.pause();
        stdout.write("\n");
        res(buf);
      } else if (code === ETX) {
        stdout.write("\n중단했습니다.\n");
        exit(130);
      } else if (code === BS || code === DEL) {
        if (buf.length) { buf = buf.slice(0, -1); stdout.write("\b \b"); }
      } else {
        buf += ch.toString("utf8");
        stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

/** .env.local 을 줄 단위로 읽어 지정한 키만 갈아끼운다. 다른 줄은 그대로 둔다. */
function upsertEnv(pairs) {
  const lines = existsSync(FILE) ? readFileSync(FILE, "utf8").split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(pairs)) {
    const i = lines.findIndex((l) => new RegExp(`^${k}=`).test(l.trim()));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  writeFileSync(FILE, lines.join("\n"), "utf8");
  try { chmodSync(FILE, 0o600); } catch { /* Windows 에서는 무시 */ }
}

function readEnv() {
  if (!existsSync(FILE)) return {};
  const map = {};
  for (const l of readFileSync(FILE, "utf8").split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return map;
}

const mask = (s) => `${s.slice(0, 3)}…${s.slice(-2)} (${s.length}자)`;

// ── 1. secret key 입력 ───────────────────────────────────────
console.log("=== 인증 파이프라인 비밀값 등록 ===\n");
console.log("Supabase 대시보드 → Project Settings → API Keys 에서");
console.log("  secret key (sb_secret_… 또는 service_role JWT) 를 복사해 붙여넣으세요.");
console.log("  붙여넣어도 화면에는 * 만 보입니다. 엔터만 치면 기존 값을 유지합니다.\n");

const env = readEnv();
if (env.SUPABASE_SECRET_KEY) console.log(`  현재 등록된 값: ${mask(env.SUPABASE_SECRET_KEY)}\n`);

const entered = (await askHidden("SUPABASE_SECRET_KEY: ")).trim();
const secret = entered || env.SUPABASE_SECRET_KEY;

if (!secret) {
  console.error("\n[중단] 키가 없으면 인증 라우트는 계속 503 입니다.");
  exit(1);
}

// publishable 키를 잘못 붙여넣는 사고가 흔하다. 모양으로 먼저 거른다.
if (/^sb_publishable_/.test(secret)) {
  console.error("\n[중단] publishable 키입니다. secret key 를 붙여넣으세요.");
  exit(1);
}
if (!/^sb_secret_/.test(secret) && !/^ey/.test(secret)) {
  console.error("\n[중단] secret key 형식이 아닙니다 (sb_secret_… 또는 JWT).");
  exit(1);
}

// ── 2. 정말 동작하는 키인지 확인 ──────────────────────────────
// 형식만 보고 넘어가면 "등록은 됐는데 여전히 503" 이 된다. 실제로 물어본다.
const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
if (!supabaseUrl) {
  console.error("\n[중단] NEXT_PUBLIC_SUPABASE_URL 이 .env.local 에 없습니다.");
  exit(1);
}

stdout.write("\n키 검증 중… ");
const { createClient } = await import("@supabase/supabase-js");
const svc = createClient(supabaseUrl, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});
// ⚠ private 스키마로 확인하지 않는다. PostgREST 노출 스키마는 public·graphql_public
//   뿐이라 service_role 이라도 406 PGRST106 이 난다 — 멀쩡한 키를 실패로 오판한다.
//   service_role 여부는 auth admin API 로 확인하는 것이 정확하다.
const probe = await svc.auth.admin.listUsers({ page: 1, perPage: 1 });
if (probe.error) {
  console.log("실패");
  console.error(`[중단] 이 키는 service_role 이 아닙니다: ${probe.error.message}`);
  console.error("       secret key 가 맞는지, 프로젝트가 맞는지 확인하세요.");
  exit(1);
}
console.log("성공 (service_role 확인)");

// ── 3. 로컬 HMAC 키 ──────────────────────────────────────────
const toWrite = { SUPABASE_SECRET_KEY: secret };
if (!env.VERIFY_HMAC_KEY_V1) {
  toWrite.VERIFY_HMAC_KEY_V1 = randomBytes(48).toString("base64url");
  toWrite.VERIFY_HMAC_CURRENT_VER = "1";
  console.log("로컬 HMAC 키 생성됨 (개발 전용).");
} else {
  console.log("로컬 HMAC 키 이미 있음 — 건드리지 않습니다.");
}
upsertEnv(toWrite);
console.log(".env.local 에 기록했습니다. (git 비추적)");

// ── 4. 운영(Vercel) 안내 ─────────────────────────────────────
// 운영 HMAC 키는 로컬과 다른 값이어야 한다. 여기서 새로 만들어 한 번만 보여 준다.
const prodHmac = randomBytes(48).toString("base64url");
console.log(`
────────────────────────────────────────────────────────
운영(Vercel) 환경변수 — Project Settings → Environment Variables

  SUPABASE_SECRET_KEY       방금 입력한 값과 동일
  VERIFY_HMAC_CURRENT_VER   1
  VERIFY_HMAC_KEY_V1        아래 값 (운영 전용으로 지금 생성했습니다)

${prodHmac}

  ⚠ 이 값은 다시 표시되지 않습니다. 지금 Vercel 에 붙여넣으세요.
  ⚠ HMAC 키는 잃으면 복구할 수 없습니다. 학번 원문을 저장하지 않으므로
     기존 해시를 새 키로 재계산할 방법이 없고, 그 버전의 중복가입 차단이
     영구히 사라집니다. 비밀번호 관리자에 함께 보관하세요.
────────────────────────────────────────────────────────

다음 확인:
  node scripts/manual/diag-verification-ready.mjs    준비 상태 (PASS 떠야 함)
  node scripts/manual/verify-e2e-smoke.mjs           실제 제출 흐름 (dev 서버 필요)
`);
