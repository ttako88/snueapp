// 프로덕션 배포 트리거 (Vercel Deploy Hook POST).
// 훅 URL은 .env.prod.local 의 VERCEL_DEPLOY_HOOK_URL 에서만 읽고 **절대 출력하지 않는다**.
// (훅 URL = 인증 없는 배포 트리거 열쇠라 로그/화면에 남기면 안 됨.)
// 사용: node scripts/manual/deploy.mjs
import { readProdEnv } from "./prod-url.mjs";

let url;
try {
  ({ VERCEL_DEPLOY_HOOK_URL: url } = readProdEnv(["VERCEL_DEPLOY_HOOK_URL"]));
} catch (e) {
  console.error("[중단] " + e.message);
  process.exit(1);
}
if (!url || !/^https:\/\/api\.vercel\.com\/.+\/deploy\//.test(url)) {
  console.error("[중단] .env.prod.local 에 VERCEL_DEPLOY_HOOK_URL 이 없거나 형식이 아님.");
  console.error("        Vercel > 프로젝트 > Settings > Git > Deploy Hooks 에서 만든 URL을 넣어주세요.");
  process.exit(1);
}

const res = await fetch(url, { method: "POST" });
let job = null;
try { const j = await res.json(); job = j?.job ?? null; } catch { /* ignore */ }
console.log(`배포 트리거: HTTP ${res.status}${res.ok ? " (요청됨)" : " (실패)"}`);
if (job) console.log(`  job=${job.id} state=${job.state}`);
console.log("  → Vercel Deployments 에서 Ready 되는지 확인하세요.");
