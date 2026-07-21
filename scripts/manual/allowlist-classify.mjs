// ============================================================
// allowlist-classify.mjs — authenticated EXECUTE 후보 분류 (READ-ONLY)
// ============================================================
// GPT P-20260721 §8: authenticated 21건을 검증 전에 FINAL 로 표시하지 않는다.
// 다음 상태로 구별한다.
//   REQUIRED_AND_VERIFIED / REQUIRED_BUT_TEST_PENDING /
//   INTENTIONALLY_DENIED / SECURITY_REPAIR_REQUIRED / UNUSED_OR_UNRESOLVED
//
// 분류 근거는 소스에서 산출한다.
//   · exact signature (인자 이름·타입 포함)
//   · 내부 권한검사 유무와 그 종류
//   · auth.uid() 기반 행위자 판정 여부 (인자로 행위자를 받으면 우회 가능)
//   · 쓰기 여부
//   · 앱에서 실제 호출되는지
//
// DB 에 접속하지 않는다. dev 에는 001~005 만 있어 007·009 함수가 없다.
// ============================================================
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const MIGDIR = join(process.cwd(), "supabase/migrations");
const OUT = join(homedir(), "prod-runs", "ALLOWLIST_CLASSIFICATION");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(52)} ${v}`);

// routine-security-audit 이 뽑은 최종 authenticated 노출 21건
const AUTH21 = ["admin_reveal_author", "apply_sanction", "block_author", "change_nickname",
  "close_case", "get_case", "get_my_member", "get_my_verification_requests", "grant_role",
  "list_my_blocks", "list_verification_requests", "mark_message_read", "moderate_content",
  "record_member_view", "review_verification", "set_initial_nickname", "soft_delete_comment",
  "soft_delete_post", "submit_report", "unblock_author", "withdraw_verification"];

// 앱이 실제로 호출하는 RPC (브라우저 0건, 서버 service_role 10종)
const APP_SERVER_RPC = new Set(["acquire_maintenance_lease", "release_maintenance_lease",
  "record_maintenance_run", "claim_accounts_for_deletion", "prepare_account_deletion",
  "detach_member_content", "get_member_verification_paths", "run_stale_review_notifications",
  "expire_unreviewed_submissions", "mark_verification_doc_purged"]);

// 소스 전체를 한 덩어리로 읽어 함수 정의 블록을 찾는다
const sources = readdirSync(MIGDIR).filter((f) => /^00\d_.*\.sql$/.test(f)).sort()
  .map((f) => ({ file: f, sql: readFileSync(join(MIGDIR, f), "utf8") }));

// 인자 목록은 괄호 균형으로 잘라야 한다. 비탐욕 정규식으로 `)` 까지
// 긁으면 `returns table (...)` 에서 폭주해 시그니처가 통째로 망가진다.
function argSpan(sql, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") { depth--; if (depth === 0) return [openIdx + 1, i]; }
  }
  return null;
}

function findRoutine(name) {
  for (const { file, sql } of sources) {
    const re = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\(`, "i");
    const m = re.exec(sql);
    if (!m) continue;
    const open = m.index + m[0].length - 1;
    const span = argSpan(sql, open);
    if (!span) continue;
    const args = sql.slice(span[0], span[1]);
    // 인자 닫는 괄호 뒤부터 본문 시작 태그까지가 옵션 절이다
    const after = sql.slice(span[1] + 1);
    const tagM = /\bas\s+(\$[A-Za-z_]*\$)/i.exec(after);
    if (!tagM) continue;
    const opts = after.slice(0, tagM.index);
    const tag = tagM[1];
    const bodyStart = span[1] + 1 + tagM.index + tagM[0].length;
    const bodyEnd = sql.indexOf(tag, bodyStart);
    const body = bodyEnd < 0 ? "" : sql.slice(bodyStart, bodyEnd);
    const retM = /returns\s+([\s\S]*?)\s+language\b/i.exec(opts);
    return {
      file, args: args.replace(/\s+/g, " ").trim(),
      returns: (retM ? retM[1] : "").replace(/\s+/g, " ").trim(),
      body, opts,
    };
  }
  return null;
}

/**
 * 이 함수가 호출자를 제한하는가.
 *
 * 처음엔 actor_role_check / is_writable_member / is_active_member 세 가지만
 * 봤는데, 그러면 record_member_view·submit_report·unblock_author 가
 * "가드 없이 쓰기"로 잘못 잡힌다. 실제로는 각각 가시성 술어, members
 * 테이블 인라인 검사, WHERE 의 auth.uid() 범위 한정으로 막고 있다.
 * 근거 없이 SECURITY_REPAIR_REQUIRED 를 붙이면 안 되므로 형태를 넓힌다.
 */
function guardsOf(body, args) {
  const g = [];
  const rc = /private\.actor_role_check\s*\(\s*'(\w+)'/.exec(body);
  if (rc) g.push({ kind: "ROLE_CHECK", detail: `actor_role_check('${rc[1]}')` });
  if (/authz\.is_writable_member\s*\(/.test(body)) g.push({ kind: "MEMBER_STATE", detail: "is_writable_member()" });
  if (/authz\.is_active_member\s*\(/.test(body)) g.push({ kind: "MEMBER_STATE", detail: "is_active_member()" });
  for (const m of body.matchAll(/authz\.(post_visible_to_me|board_access_ok|is_blocked_author)\s*\(/g))
    g.push({ kind: "VISIBILITY", detail: `${m[1]}()` });
  // members 테이블 인라인 검사 + 예외
  if (/private\.members[\s\S]{0,200}auth\.uid\s*\(\s*\)/.test(body) && /raise\s+exception/i.test(body))
    g.push({ kind: "INLINE_MEMBER_CHECK", detail: "private.members + auth.uid() + raise exception" });
  // 쓰기 문장이 auth.uid() 로 범위 한정되는가
  const writeStmts = [...body.matchAll(/\b(insert\s+into|update|delete\s+from)\b[\s\S]{0,400}?(?=;|$)/gi)]
    .map((x) => x[0]);
  const scoped = writeStmts.filter((s) => /auth\.uid\s*\(\s*\)/.test(s));
  if (writeStmts.length && scoped.length === writeStmts.length)
    g.push({ kind: "OWNERSHIP_SCOPED_WRITE", detail: `쓰기 ${writeStmts.length}개 전부 auth.uid() 로 한정` });
  // 읽기 전용 함수는 조회 자체가 auth.uid() 로 한정되는 것이 가드다.
  // (get_my_member, get_my_verification_requests, list_my_blocks 류)
  if (writeStmts.length === 0 && /\bwhere[\s\S]{0,160}auth\.uid\s*\(\s*\)/i.test(body))
    g.push({ kind: "SELF_SCOPED_READ", detail: "조회가 auth.uid() 로 한정" });
  return { guards: g, writeStmts: writeStmts.length, scopedWrites: scoped.length };
}

head("1. 21건 exact signature + 내부 검사");
const rows = [];
for (const name of AUTH21) {
  const r = findRoutine(name);
  if (!r) { rows.push({ name, status: "UNUSED_OR_UNRESOLVED", reason: "소스에서 정의를 찾지 못함" }); continue; }

  const { guards, writeStmts, scopedWrites } = guardsOf(r.body, r.args);
  const usesAuthUid = /auth\.uid\s*\(\s*\)/.test(r.body);
  // 행위자 id 를 인자로 받는가 — 받으면 타인 사칭 가능성을 개별 확인해야 한다.
  // 단 관리 RPC 는 "대상" id 를 받는 게 정상이므로 ROLE_CHECK 가 있으면 예외로 본다.
  const actorArg = /\bp_(actor|caller)\w*/.test(r.args);
  const hasRoleCheck = guards.some((g) => g.kind === "ROLE_CHECK");

  let status, reason;
  if (actorArg && !hasRoleCheck) {
    status = "SECURITY_REPAIR_REQUIRED";
    reason = "행위자를 인자로 받는데 역할검사가 없다 — 사칭 가능성";
  } else if (writeStmts > 0 && guards.length === 0) {
    status = "SECURITY_REPAIR_REQUIRED";
    reason = "어떤 형태의 호출자 제한도 없이 쓰기 수행";
  } else if (writeStmts > 0 && scopedWrites < writeStmts && !hasRoleCheck
             // 가시성 가드도 호출자 제한이다. record_member_view 는 상단에서
             // post_visible_to_me() 로 막고, 소유권과 무관한 view_count 증가는
             // 그 뒤 if found 안에서만 실행된다. 이걸 빼면 오탐이 난다.
             && !guards.some((g) => ["INLINE_MEMBER_CHECK", "MEMBER_STATE", "VISIBILITY"].includes(g.kind))) {
    status = "SECURITY_REPAIR_REQUIRED";
    reason = `쓰기 ${writeStmts}개 중 ${scopedWrites}개만 auth.uid() 로 한정되고 역할·회원 검사도 없다`;
  } else if (guards.length === 0) {
    status = "REQUIRED_BUT_TEST_PENDING";
    reason = "읽기 전용이나 호출자 제한이 확인되지 않음 — 실행 경로 테스트 필요";
  } else {
    status = "REQUIRED_BUT_TEST_PENDING";
    reason = guards.map((g) => g.detail).join(" + ") + " — 실행 경로 테스트 대기";
  }

  rows.push({
    name, file: r.file,
    signature: `public.${name}(${r.args})`,
    returns: r.returns,
    guards, guard_summary: guards.map((g) => g.detail).join(" + ") || "없음",
    uses_auth_uid: usesAuthUid,
    actor_passed_as_arg: actorArg,
    write_statements: writeStmts,
    ownership_scoped_writes: scopedWrites,
    called_by_app: APP_SERVER_RPC.has(name),
    status, reason,
  });
}

for (const r of rows)
  console.log(`  ${(r.status ?? "?").padEnd(26)} ${r.signature ?? r.name}\n` +
    `      guard=${r.guard_summary ?? "-"}\n` +
    `      쓰기 ${r.write_statements ?? "-"} (auth.uid() 한정 ${r.ownership_scoped_writes ?? "-"})`);

head("2. 상태 집계");
const tally = {};
for (const r of rows) tally[r.status] = (tally[r.status] || 0) + 1;
for (const [k, v] of Object.entries(tally).sort()) line(k, v);

head("3. 앱 호출 여부");
line("21건 중 앱이 실제 호출", rows.filter((r) => r.called_by_app).length);
console.log("  · 브라우저 클라이언트는 RPC 를 호출하지 않는다(실측 0건).");
console.log("  · 서버 maintenance 10종은 service_role 이므로 이 21건과 별개다.");
console.log("  → 따라서 '앱이 안 쓰니 회수해도 된다'는 논증은 성립하지 않는다.");
console.log("    이 21건은 아직 배선되지 않은 기능의 계약이거나 관리 도구다.");

const out = {
  document: "AUTHENTICATED_EXECUTE_ALLOWLIST_CLASSIFICATION",
  responds_to: "P-20260721 §8 — 검증 전 FINAL 표시 금지",
  method: "001~009 소스 정적 분석 (DB 미접속)",
  candidate_count: rows.length,
  status_tally: tally,
  note: "REQUIRED_AND_VERIFIED 는 실행 경로 테스트를 통과한 뒤에만 부여한다. 현재 0건이다.",
  rows,
};
mkdirSync(OUT, { recursive: true });
const buf = Buffer.from(JSON.stringify(out, null, 2));
writeFileSync(join(OUT, "ALLOWLIST_CLASSIFICATION.json"), buf);

head("판정");
console.log(`\nCANDIDATES=${rows.length}`);
console.log(`STATUS=${JSON.stringify(tally)}`);
console.log(`REQUIRED_AND_VERIFIED=0 (실행 경로 테스트 전)`);
console.log(`SHA256=${createHash("sha256").update(buf).digest("hex")}`);
console.log(`OUT=${join(OUT, "ALLOWLIST_CLASSIFICATION.json")}`);
