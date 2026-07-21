// ============================================================
// ops-clients.mjs — 운영 토큰을 쓰는 **유일한 통로** (프로젝트 고정)
// ============================================================
// 왜 필요한가
//   소유자가 준 토큰들은 이 프로젝트보다 넓은 범위를 갖는다. 실측 결과
//   Supabase 관리 토큰은 프로젝트 2개를 조회한다. 즉 실수로 엉뚱한 프로젝트를
//   건드릴 수 있다.
//
//   COLLAB_PROTOCOL §7 의 위협 모델에서 1차 위협은 "악의적 에이전트" 가 아니라
//   **"실수하거나 권한을 오독하는 에이전트"** 다. 오늘 낸 사고 셋이 전부 그
//   유형이었다. 이 래퍼는 정확히 그 위협을 막는다 — 대상이 SNUE 가 아니면
//   요청을 보내기 전에 거부한다.
//
//   한계도 정직하게 적는다. 이건 `ENTRYPOINT_LOCAL_GUARD` 이지
//   `SYSTEM_ENFORCEMENT` 가 아니다. 같은 토큰을 이 래퍼 밖에서 fetch 로 직접
//   쓸 수 있기 때문이다. 그건 §3-1 우회 금지가 규범으로 막는다.
//   기계적 강제는 보호된 실행기가 완성돼야 성립한다.
// ============================================================
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { PROD_REF } from "./dev-url.mjs";

const GITHUB_REPO = "ttako88/snueapp";

function loadEnv() {
  const env = {};
  for (const f of [".env.local", ".env.prod.local"]) {
    const p = resolve(process.cwd(), f);
    if (!existsSync(p)) continue;
    for (const l of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

const env = loadEnv();

/** 토큰이 없으면 조용히 넘어가지 않는다 — 없는 채로 진행하면 원인 모를 실패가 된다. */
function need(key) {
  if (!env[key]) throw new Error(`${key} 없음 — npm run setup 으로 등록하세요`);
  return env[key];
}

// ── Supabase Management API ─────────────────────────────────
// 경로에 project ref 가 들어가면 SNUE 인지 확인한다. 다른 ref 면 요청하지 않는다.
export async function supabaseAdmin(path, init = {}) {
  const token = need("SUPABASE_ACCESS_TOKEN");
  const m = /\/v\d+\/projects\/([a-z0-9]{20})/i.exec(path);
  if (m && m[1] !== PROD_REF) {
    throw new Error(`대상 프로젝트가 SNUE 가 아닙니다 (요청 ref=${m[1]}) — 차단`);
  }
  const res = await fetch(`https://api.supabase.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) };
}

/** SNUE 프로젝트 경로를 만들어 준다 — ref 를 손으로 쓰지 않게 해서 오타를 막는다. */
export const snuePath = (suffix) => `/v1/projects/${PROD_REF}${suffix}`;

// ── Vercel API ──────────────────────────────────────────────
// projectId 를 호출부가 지정하지 못하게 한다. 항상 등록된 SNUE 프로젝트다.
export async function vercelApi(pathAfterProject, init = {}) {
  const token = need("VERCEL_TOKEN");
  const projectId = need("VERCEL_PROJECT_ID");
  const team = env.VERCEL_ORG_ID ? `teamId=${encodeURIComponent(env.VERCEL_ORG_ID)}` : "";
  const sep = pathAfterProject.includes("?") ? "&" : "?";
  const url = `https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}` +
    `${pathAfterProject}${team ? sep + team : ""}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) };
}

/** 배포·롤백은 프로젝트 스코프 밖의 엔드포인트를 쓰므로 별도. team 은 붙인다. */
export async function vercelRaw(path, init = {}) {
  const token = need("VERCEL_TOKEN");
  const team = env.VERCEL_ORG_ID ? `teamId=${encodeURIComponent(env.VERCEL_ORG_ID)}` : "";
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`https://api.vercel.com${path}${team ? sep + team : ""}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) };
}

// ── GitHub API ──────────────────────────────────────────────
// 저장소를 고정한다. 다른 저장소 경로는 만들 수 없다.
export async function githubApi(pathAfterRepo, init = {}) {
  const token = need("GITHUB_TOKEN");
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}${pathAfterRepo}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...(init.headers || {}),
    },
  });
  return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) };
}

export { env as opsEnv, PROD_REF, GITHUB_REPO };
