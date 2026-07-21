// ============================================================
// prod-conn-diag.mjs — 운영 DB 접속 경로 진단 (접속 문자열 비출력)
// ============================================================
// 왜 필요한가:
//   Supabase 직결 호스트(db.<ref>.supabase.co)는 IPv6 전용인 경우가 많다.
//   IPv6가 없는 회선에서는 ETIMEDOUT 이 나는데, 이게 "자격증명 문제"인지
//   "네트워크 경로 문제"인지 구분하지 못하면 엉뚱한 곳을 고치게 된다.
//
// 하는 일:
//   · 호스트명만 뽑아 DNS A/AAAA 레코드를 각각 조회
//   · 각 주소로 TCP 연결만 시도 (인증·쿼리 없음)
//   · 결과로 "IPv6만 있음 / IPv4 가능 / DNS 실패" 를 판정하고 대안을 제시
//
// 비밀값은 출력하지 않는다. 호스트명과 포트만 보여준다.
// (호스트명에는 project ref가 들어있지만 이미 런북 전반에 공개된 식별자다.)
// ============================================================
// resolve4/resolve6 은 설정된 DNS 서버에 **직접 질의**하는데, 이 샌드박스에서는
// 그 경로가 막혀 ECONNREFUSED 가 난다(호스트가 없는 게 아니다).
// lookup 은 OS 리졸버(getaddrinfo)를 쓰므로 실제 앱과 같은 경로를 본다.
import { lookup } from "node:dns/promises";
import net from "node:net";
import { readProdEnv, assertProdUrl } from "./prod-url.mjs";

const { PROD_DB_URL: url } = readProdEnv(["PROD_DB_URL"]);
if (!url) { console.error("[중단] PROD_DB_URL 없음"); process.exit(1); }
assertProdUrl(url, "PROD_DB_URL");

const u = new URL(url);
const host = u.hostname;
const port = Number(u.port || 5432);

console.log("운영 DB 접속 경로 진단 (비밀값 미출력)\n");
console.log(`  host  ${host}`);
console.log(`  port  ${port}`);
console.log(`  user  ${u.username ? "설정됨" : "없음"} / password ${u.password ? "설정됨" : "없음"}\n`);

async function rec(kind) {
  const family = kind === "A" ? 4 : 6;
  try {
    const all = await lookup(host, { family, all: true });
    return all.length ? all.map((x) => x.address) : { err: "NO_RECORD" };
  } catch (e) { return { err: e.code }; }
}

/** TCP 연결만 시도. 성공하면 즉시 끊는다. */
function probe(addr, family) {
  return new Promise((res) => {
    const s = new net.Socket();
    const t = setTimeout(() => { s.destroy(); res("TIMEOUT"); }, 8000);
    s.once("connect", () => { clearTimeout(t); s.destroy(); res("OPEN"); });
    s.once("error", (e) => { clearTimeout(t); res(e.code || "ERR"); });
    s.connect({ host: addr, port, family });
  });
}

const a = await rec("A");
const aaaa = await rec("AAAA");

console.log("=== DNS ===");
console.log(`  A    (IPv4)  ${Array.isArray(a) ? a.join(", ") : `없음 (${a.err})`}`);
console.log(`  AAAA (IPv6)  ${Array.isArray(aaaa) ? aaaa.join(", ") : `없음 (${aaaa.err})`}`);

console.log("\n=== TCP 연결 시도 ===");
let v4ok = false, v6ok = false;
if (Array.isArray(a)) for (const ip of a.slice(0, 2)) {
  const r = await probe(ip, 4); console.log(`  IPv4 ${ip}:${port} → ${r}`); if (r === "OPEN") v4ok = true;
}
if (Array.isArray(aaaa)) for (const ip of aaaa.slice(0, 2)) {
  const r = await probe(ip, 6); console.log(`  IPv6 ${ip}:${port} → ${r}`); if (r === "OPEN") v6ok = true;
}

console.log("\n=== 판정 ===");
if (v4ok || v6ok) {
  console.log(`  ✅ 접속 경로 있음 (${v4ok ? "IPv4" : ""}${v4ok && v6ok ? " · " : ""}${v6ok ? "IPv6" : ""})`);
  console.log("  → 그래도 실패한다면 자격증명·SSL 문제이지 네트워크 경로 문제가 아니다.");
  process.exit(0);
}
console.log("  ⛔ 어느 경로로도 TCP 연결이 되지 않는다.");
if (!Array.isArray(a) && Array.isArray(aaaa)) {
  console.log("  원인: 이 호스트는 **IPv6 전용**인데 이 회선에 IPv6 경로가 없다.");
  console.log("  대안: Supabase 대시보드 > Project Settings > Database > Connection string 에서");
  console.log("        **Connection pooling(Session mode, IPv4 지원)** 문자열을 받아");
  console.log("        setup-prod-secret.mjs 로 PROD_DB_URL 을 교체한다.");
  console.log("        형태: aws-0-<region>.pooler.supabase.com:5432 (Session) / :6543 (Transaction)");
  console.log("        인벤토리는 SAVEPOINT·SET LOCAL 을 쓰므로 **Session mode(5432)** 가 필요하다.");
}
process.exit(3);
