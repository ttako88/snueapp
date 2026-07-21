// ============================================================
// prod-bootstrap-owner.mjs — 최초 owner 부트스트랩 실행기
// ============================================================
// 왜 필요한가
//   글쓰기는 verification_status='verified' 를 요구하는데, 인증을 승인할
//   operator/owner 가 0명이라 아무도 승인해 줄 수 없다. bootstrap-owner.sql
//   이 그 최초 1명을 만드는 유일한 예외 경로다.
//
// 개인정보 취급
//   실명과 학번 HMAC 은 .env.prod.local 에서 읽어 SQL 에 넣기만 하고
//   화면·로그·파일 어디에도 출력하지 않는다. 길이와 형식만 검증해 보고한다.
//   동결된 bootstrap-owner.sql 은 수정하지 않는다 — 자리표시자만 치환한
//   사본을 메모리에서 만들어 실행하고, 그 사본은 저장하지 않는다.
//
// 실행: node scripts/manual/prod-bootstrap-owner.mjs --execute
// ============================================================
import pg from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readProdEnv, assertProdUrl, PROD_REF, scrub } from "./prod-url.mjs";

const SQL = join(process.cwd(), "scripts/manual/bootstrap-owner.sql");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(44)} ${v}`);
const fails = [];
const rec = (n, ok, d) => { if (!ok) fails.push(n); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

if (!process.argv.includes("--execute")) {
  console.error("[중단] 운영 쓰기다. --execute 를 명시하라.");
  process.exit(2);
}

const env = readProdEnv(["PROD_DB_URL", "OWNER_REAL_NAME", "OWNER_STUDENT_NO_HMAC", "OWNER_HMAC_KEY_VERSION"]);
const url = assertProdUrl(env.PROD_DB_URL, "PROD_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();
  const q = async (s, p = []) => (await c.query(s, p)).rows;

  head("0. 입력 검증 (값은 출력하지 않는다)");
  const name = (env.OWNER_REAL_NAME || "").trim();
  const hmac = (env.OWNER_STUDENT_NO_HMAC || "").trim();
  const ver = (env.OWNER_HMAC_KEY_VERSION || "").trim();
  rec("실명 존재", name.length > 0, `길이 ${name.length}`);
  rec("학번 HMAC 형식 (hex 64)", /^[0-9a-f]{64}$/i.test(hmac), `길이 ${hmac.length}`);
  rec("키 버전 숫자", /^\d+$/.test(ver), `값 ${ver}`);
  if (fails.length) { console.error("\n⛔ 입력 형식 불량 — 중단"); return 3; }

  head("1. 대상 계정 확인");
  const cands = await q(`select m.id, u.email, m.nickname is not null has_nick,
       m.verification_status, m.role
     from private.members m join auth.users u on u.id = m.id
     order by m.created_at`);
  for (const r of cands)
    line(`  ${r.email}`, `닉네임=${r.has_nick} 상태=${r.verification_status} role=${r.role}`);
  rec("계정이 정확히 1개", cands.length === 1, `${cands.length}개`);
  if (cands.length !== 1) { console.error("\n⛔ 대상이 모호하다 — 중단"); return 3; }
  const target = cands[0];
  rec("상태가 pending (스크립트 전제)", target.verification_status === "pending", target.verification_status);
  rec("닉네임 설정됨", target.has_nick);
  if (fails.length) { console.error("\n⛔ 전제 불충족 — 중단"); return 3; }

  head("2. 동결 스크립트 로드 + 자리표시자 치환");
  const raw = readFileSync(SQL, "utf8");
  line("bootstrap-owner.sql sha256", createHash("sha256").update(raw).digest("hex").slice(0, 32) + "…");
  // 치환은 메모리에서만. 치환본은 저장하지 않는다.
  //
  // replaceAll 을 쓴다. 자리표시자가 파일 상단 주석(사용법 설명)에 먼저
  // 나오고 실제 선언부에 다시 나오는데, replace 는 첫 번째만 바꾸므로
  // 정작 실행되는 코드가 치환되지 않은 채 남는다.
  const sql = raw
    .replaceAll("__TARGET_AUTH_UUID__", target.id)
    .replaceAll("__REAL_NAME__", name.replace(/'/g, "''"))
    .replaceAll("__STUDENT_NO_HMAC__", hmac)
    .replaceAll("__HMAC_KEY_VERSION__", ver);
  const leftovers = (sql.match(/__[A-Z_]+__/g) || []);
  rec("자리표시자 4개 모두 치환", leftovers.length === 0, leftovers.join(", ") || "0개 잔존");
  if (fails.length) { console.error("\n⛔ 치환 불완전 — 중단"); return 3; }

  head("3. 실행 (스크립트 자체 트랜잭션, 실패 시 자동 롤백)");
  try {
    await c.query(sql);
    line("실행", "완료");
  } catch (e) {
    console.error(`\n⛔ 부트스트랩 거부/실패: ${scrub(e.message || String(e), url, hmac, name).slice(0, 300)}`);
    console.error("   스크립트의 불변조건에 걸린 것이다. 운영은 롤백됐다.");
    return 3;
  }

  head("4. 사후 검증 (count 만 본다 — 실명·HMAC 재조회 금지)");
  const after = (await q(`select
      (select count(*) from private.members where role='owner') owners,
      (select count(*) from private.members where verification_status='verified') verified,
      (select count(*) from private.school_identities) identities,
      (select count(*) from private.audit_logs) audit`))[0];
  line("owner", after.owners);
  line("verified 회원", after.verified);
  line("school_identities", after.identities);
  line("audit_logs", after.audit);
  rec("owner 정확히 1명", Number(after.owners) === 1, String(after.owners));
  rec("대상이 verified 로 전이", Number(after.verified) >= 1, String(after.verified));
  rec("신원 행 1건 생성", Number(after.identities) === 1, String(after.identities));
  rec("감사 기록 남음", Number(after.audit) >= 1, String(after.audit));

  head("5. 쓰기 가능 여부 재확인");
  const w = (await q(`select m.nickname is not null n, m.verification_status v, m.sanction s
     from private.members m where m.id=$1`, [target.id]))[0];
  const writable = w.n && w.v === "verified" && w.s === "none";
  rec("is_writable_member 조건 충족", writable,
    `닉네임=${w.n} 상태=${w.v} 제재=${w.s}`);

  console.log(`\nBOOTSTRAP_OWNER=${fails.length ? "FAIL" : "PASS"}`);
  if (fails.length) for (const f of fails) console.log(`  · ${f}`);
  return fails.length ? 3 : 0;
}

let code = 1;
try { code = await main(); }
catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
process.exit(code);
