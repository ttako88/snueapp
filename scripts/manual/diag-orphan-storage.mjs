// ============================================================
// diag-orphan-storage.mjs — 인증문서 버킷의 고아 객체 탐지 (읽기 전용)
// ============================================================
//   node scripts/manual/diag-orphan-storage.mjs
//
// ⚠️ **이 도구는 아무것도 지우지 않는다.** --apply 같은 스위치도 없다.
//    삭제는 되돌릴 수 없고, 대상이 학생의 재학증명서·학생증이다.
//    잘못 지우면 사용자가 서류를 다시 떼어 와야 한다.
//    지우는 것은 별도 도구로, 이 목록을 사람이 확인한 뒤에 만든다.
//
// 무엇을 찾나 (#26)
//   계정 삭제·신청 파기 뒤에도 Storage 에 남은 객체. 두 종류다.
//     ① staging/<user_id>/...      — finalize 전에 버려진 업로드
//     ② verified/<request_id>/...  — 신청 행은 사라졌는데 파일만 남음
//
// 왜 남나
//   · finalize 실패 경로에서 staging 정리가 best-effort 다(응답을 막지 않으려고)
//   · 계정 soft delete → purge 가 DB 행만 지우고 객체를 안 지운다
//   · 업로드만 하고 finalize 를 안 한 채 이탈
//
// 판정 원칙
//   **"모르겠으면 고아가 아니다"** 로 센다. 조회에 실패한 항목은 UNKNOWN 으로
//   따로 세고 고아에 넣지 않는다. 삭제 후보 목록에 확신 없는 것을 섞으면
//   나중에 그 목록을 그대로 지우는 도구가 생겼을 때 사고가 난다.
// ============================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const BUCKET = "verification-docs";
// finalize 가 도는 중일 수 있다. 최근 것은 고아로 보지 않는다 —
// 업로드 직후 이 도구가 돌면 정상 파일을 고아로 잡는다.
const GRACE_HOURS = 24;

function readEnv(file) {
  if (!existsSync(file)) return {};
  const m = {};
  for (const l of readFileSync(file, "utf8").split(/\r?\n/)) {
    const x = /^([A-Za-z0-9_]+)=(.*)$/.exec(l.trim());
    if (x) m[x[1]] = x[2].replace(/^["']|["']$/g, "");
  }
  return m;
}
const env = { ...readEnv(".env.local"), ...process.env };
const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("[중단] SUPABASE_URL / SUPABASE_SECRET_KEY 가 필요합니다.");
  process.exit(1);
}
const svc = createClient(url, key, { auth: { persistSession: false } });

/** 한 폴더의 객체를 전부 나열한다. 페이지네이션을 끝까지 돈다. */
async function listAll(prefix) {
  const out = [];
  const PAGE = 100;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await svc.storage.from(BUCKET)
      .list(prefix, { limit: PAGE, offset, sortBy: { column: "name", order: "asc" } });
    // ⚠️ 실패를 빈 배열로 덮지 않는다. 조용히 0건이 되면 "고아 없음" 으로
    //    잘못 보고하게 된다 — 이 프로젝트에서 같은 유형으로 여러 번 틀렸다.
    if (error) throw new Error(`list(${prefix}) 실패: ${error.message}`);
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

const ageHours = (o) => {
  const t = o.updated_at ?? o.created_at;
  return t ? (Date.now() - new Date(t).getTime()) / 36e5 : null;
};

console.log(`\n인증문서 고아 객체 점검 (읽기 전용)`);
console.log(`버킷: ${BUCKET} · 유예 ${GRACE_HOURS}시간\n`);

const report = { staging: [], verified: [], unknown: [], scanned: 0 };

// ── 1. staging ──────────────────────────────────────────────
// staging/<user_id>/<...>. 사용자에게 uploading 신청이 하나도 없으면 고아다.
const stagingUsers = await listAll("staging");
console.log(`staging 하위 폴더 ${stagingUsers.length}개`);

for (const u of stagingUsers) {
  if (!u.name) continue;
  let objects;
  try { objects = await listAll(`staging/${u.name}`); }
  catch (e) { report.unknown.push({ path: `staging/${u.name}`, why: e.message }); continue; }
  report.scanned += objects.length;

  // 이 사용자에게 살아 있는 uploading 신청이 있는가.
  const { data, error } = await svc.rpc("svc_count_open_uploads", { p_member_id: u.name });
  if (error) {
    // RPC 가 아직 없으면(미적용) 판정하지 않는다. 추측해서 고아로 몰면
    // 나중에 이 목록이 삭제 대상이 됐을 때 실제 신청 파일이 날아간다.
    report.unknown.push({
      path: `staging/${u.name}/*`, count: objects.length,
      why: `판정 불가 — ${error.message}` });
    continue;
  }
  const open = Number(data?.open ?? 0);
  for (const o of objects) {
    const h = ageHours(o);
    if (h !== null && h < GRACE_HOURS) continue;          // 유예 중
    if (open > 0) continue;                                // 살아 있는 신청 있음
    report.staging.push({ path: `staging/${u.name}/${o.name}`,
                          size: o.metadata?.size ?? null, ageHours: h?.toFixed(1) });
  }
}

// ── 2. verified ─────────────────────────────────────────────
// verified/<request_id>/document. 신청 행이 없거나 purge 됐으면 고아다.
const verifiedDirs = await listAll("verified");
console.log(`verified 하위 폴더 ${verifiedDirs.length}개`);

for (const d of verifiedDirs) {
  if (!d.name) continue;
  if (!/^[1-9][0-9]*$/.test(d.name)) {
    report.unknown.push({ path: `verified/${d.name}`, why: "신청 ID 형식이 아님" });
    continue;
  }
  let objects;
  try { objects = await listAll(`verified/${d.name}`); }
  catch (e) { report.unknown.push({ path: `verified/${d.name}`, why: e.message }); continue; }
  report.scanned += objects.length;

  const { data, error } = await svc.rpc("svc_verification_request_exists", {
    p_request_id: d.name });
  if (error) {
    report.unknown.push({ path: `verified/${d.name}/*`, count: objects.length,
                          why: `판정 불가 — ${error.message}` });
    continue;
  }
  if (data?.exists === true && data?.purged !== true) continue;  // 정상
  for (const o of objects) {
    const h = ageHours(o);
    if (h !== null && h < GRACE_HOURS) continue;
    report.verified.push({
      path: `verified/${d.name}/${o.name}`, size: o.metadata?.size ?? null,
      ageHours: h?.toFixed(1),
      why: data?.exists ? "신청은 있으나 purged" : "신청 행 없음" });
  }
}

// ── 결과 ────────────────────────────────────────────────────
const line = (k, v) => console.log(`  ${String(k).padEnd(34)} ${v}`);
console.log("\n=== 결과 ===");
line("검사한 객체", report.scanned);
line("고아 후보 — staging", report.staging.length);
line("고아 후보 — verified", report.verified.length);
line("판정 불가(UNKNOWN)", report.unknown.length);

const show = (title, arr) => {
  if (!arr.length) return;
  console.log(`\n${title}`);
  for (const x of arr.slice(0, 20)) {
    console.log(`  ${x.path}${x.ageHours ? `  (${x.ageHours}h)` : ""}${x.why ? `  ${x.why}` : ""}`);
  }
  if (arr.length > 20) console.log(`  … 그 외 ${arr.length - 20}건`);
};
show("고아 후보 — staging", report.staging);
show("고아 후보 — verified", report.verified);
show("판정 불가 — 지우면 안 됩니다", report.unknown);

const dir = join(homedir(), "prod-runs");
mkdirSync(dir, { recursive: true });
const out = join(dir, `ORPHAN_STORAGE_${new Date().toISOString().slice(0, 10)}.json`);
// ⚠️ 경로에 user_id 가 들어간다. 이 파일을 공유하거나 커밋하지 말 것.
writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
console.log(`\n목록 저장: ${out}`);
console.log("⚠️ 경로에 사용자 ID 가 포함됩니다. 공유·커밋하지 마세요.");
console.log("⚠️ 이 도구는 아무것도 지우지 않았습니다. 삭제는 승인 후 별도 도구로 합니다.\n");
