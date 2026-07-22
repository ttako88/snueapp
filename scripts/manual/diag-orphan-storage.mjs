// ============================================================
// diag-orphan-storage.mjs — 인증문서 버킷의 고아 객체 탐지 (읽기 전용)
// ============================================================
//   node scripts/manual/diag-orphan-storage.mjs
//
// ⚠️ **이 도구는 아무것도 지우지 않는다.** --apply 같은 스위치도 없고, Storage
//    삭제 API 를 부르거나 import 하지도 않는다(GPT 021 MUST). 삭제는 되돌릴 수
//    없고 대상이 학생의 재학증명서·학생증이라, 이 목록을 사람이 확인한 뒤
//    **별도 도구(별도 승인)** 로만 지운다.
//
// 무엇을 찾나 (#26 + 020 token-fence)
//   ① staging/<user_id>/...              — finalize 전에 버려진 업로드
//   ② verified/<id>/<token>/document     — 신청이 없거나 purge 됐거나,
//      020 token-fence 에서 **재인수·실패한 stale 작업자가 남긴 패배 token 경로**
//      (정본은 다른 token 경로다). 정본과 일치하지 않는 verified 객체가 고아다.
//
// 판정 원칙 — **"모르겠으면 고아가 아니다"**. 5분류로 센다(GPT 021 MUST):
//   ORPHAN_CANDIDATE   지울 후보(사람 확인 필요)
//   INVALID_PATH       폴더 이름이 신청 ID 형식이 아님/overflow — 고아수에 미합산
//   UNKNOWN            조회 실패 — 판정 안 함, 고아수에 미합산
//   RETAIN             현재 정본(유지)
//   RETAIN_GRACE       24시간 이내(유예) — finalize 진행 중일 수 있어 제외
//   → 고아 수·삭제 후보 수에는 ORPHAN_CANDIDATE 만 넣는다.
//
//   정본 경로·token 은 DB 에서 받지 않는다. 탐지기가 찾은 객체 경로를
//   svc_verification_object_status 에 넘기고 **일치 여부(path_matches)만** 받는다.
// ============================================================
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const BUCKET = "verification-docs";
const GRACE_HOURS = 24; // 업로드/finalize 직후를 고아로 오인하지 않는다.

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

/** 한 폴더의 항목을 전부 나열한다. 페이지네이션을 끝까지 돈다(GPT 021 MUST). */
async function listAll(prefix) {
  const out = [];
  const PAGE = 100;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await svc.storage.from(BUCKET)
      .list(prefix, { limit: PAGE, offset, sortBy: { column: "name", order: "asc" } });
    // ⚠️ 실패를 빈 배열로 덮지 않는다 — 조용히 0건이 되면 "고아 없음" 오보가 된다.
    if (error) throw new Error(`list(${prefix}) 실패: ${error.message}`);
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

// Storage list 는 파일과 하위폴더를 함께 준다. 하위폴더는 metadata 가 없다.
const isFolder = (o) => !o.metadata;
const ageHours = (o) => {
  const t = o.updated_at ?? o.created_at ?? o.metadata?.lastModified;
  return t ? (Date.now() - new Date(t).getTime()) / 36e5 : null;
};

console.log(`\n인증문서 고아 객체 점검 (읽기 전용)`);
console.log(`버킷: ${BUCKET} · 유예 ${GRACE_HOURS}시간\n`);

const report = {
  scanned_objects: 0, staging_folders: 0, verified_id_folders: 0,
  orphan_candidate: [], invalid_path: [], unknown: [],
  retain_count: 0, grace_retain_count: 0,
};
const add = (cls, item) => report[cls].push(item);

// ── 1. staging/<user_id>/<...> ──────────────────────────────
// 사용자에게 살아 있는 uploading 신청이 하나도 없으면 그 폴더 객체는 고아.
const stagingUsers = (await listAll("staging")).filter(isFolder);
report.staging_folders = stagingUsers.length;
console.log(`staging 하위 폴더 ${stagingUsers.length}개`);

for (const u of stagingUsers) {
  let objects;
  try { objects = await listAll(`staging/${u.name}`); }
  catch (e) { add("unknown", { path: `staging/${u.name}`, why: e.message }); continue; }
  const files = objects.filter((o) => !isFolder(o));
  report.scanned_objects += files.length;

  const { data, error } = await svc.rpc("svc_count_open_uploads", { p_member_id: u.name });
  if (error) {
    add("unknown", { path: `staging/${u.name}/*`, count: files.length,
                     why: `판정 불가 — ${error.message}` });
    continue;
  }
  const open = Number(data?.open ?? 0);
  for (const o of files) {
    const h = ageHours(o);
    if (h !== null && h < GRACE_HOURS) { report.grace_retain_count++; continue; }
    if (open > 0) { report.retain_count++; continue; }   // 살아 있는 신청 있음
    add("orphan_candidate", { path: `staging/${u.name}/${o.name}`,
        size: o.metadata?.size ?? null, ageHours: h?.toFixed(1),
        why: "uploading 신청 없음" });
  }
}

// ── 2. verified/<id>/<token>/document ───────────────────────
// 020 token-fence: 정본은 하나의 token 경로. 신청이 없거나 purge 됐거나,
// 넘긴 경로가 현재 정본이 아니면(패배 token) 고아.
const idFolders = (await listAll("verified")).filter(isFolder);
report.verified_id_folders = idFolders.length;
console.log(`verified 하위 id 폴더 ${idFolders.length}개`);

for (const d of idFolders) {
  if (!/^[1-9][0-9]*$/.test(d.name)) {
    add("invalid_path", { path: `verified/${d.name}`, why: "신청 ID 형식 아님" });
    continue;
  }
  // <id> 아래 token 폴더들을 돈다.
  let tokenDirs;
  try { tokenDirs = (await listAll(`verified/${d.name}`)).filter(isFolder); }
  catch (e) { add("unknown", { path: `verified/${d.name}`, why: e.message }); continue; }

  for (const t of tokenDirs) {
    let objects;
    try { objects = await listAll(`verified/${d.name}/${t.name}`); }
    catch (e) { add("unknown", { path: `verified/${d.name}/${t.name}`, why: e.message }); continue; }
    const files = objects.filter((o) => !isFolder(o));
    report.scanned_objects += files.length;

    for (const o of files) {
      const objPath = `verified/${d.name}/${t.name}/${o.name}`;
      const h = ageHours(o);
      if (h !== null && h < GRACE_HOURS) { report.grace_retain_count++; continue; }

      const { data, error } = await svc.rpc("svc_verification_object_status", {
        p_request_id: d.name, p_object_path: objPath });
      if (error) { add("unknown", { path: objPath, why: `판정 불가 — ${error.message}` }); continue; }
      if (data?.reason === "bad_id") { add("invalid_path", { path: objPath, why: "bad_id" }); continue; }

      if (data?.exists !== true) {
        add("orphan_candidate", { path: objPath, size: o.metadata?.size ?? null,
            ageHours: h?.toFixed(1), why: "신청 행 없음" });
      } else if (data?.purged === true) {
        add("orphan_candidate", { path: objPath, size: o.metadata?.size ?? null,
            ageHours: h?.toFixed(1), why: "신청 purged" });
      } else if (data?.path_matches !== true) {
        // 신청은 있는데 이 경로는 현재 정본이 아니다 = 020 패배 token 경로.
        add("orphan_candidate", { path: objPath, size: o.metadata?.size ?? null,
            ageHours: h?.toFixed(1), why: "정본 아님(패배 token 경로)" });
      } else {
        report.retain_count++;   // 현재 정본
      }
    }
  }
}

// ── 결과 ────────────────────────────────────────────────────
const line = (k, v) => console.log(`  ${String(k).padEnd(34)} ${v}`);
console.log("\n=== 결과 (분류별) ===");
line("검사한 객체", report.scanned_objects);
line("ORPHAN_CANDIDATE (삭제 후보)", report.orphan_candidate.length);
line("INVALID_PATH (형식 이상, 미합산)", report.invalid_path.length);
line("UNKNOWN (판정 불가, 미합산)", report.unknown.length);
line("RETAIN (현재 정본)", report.retain_count);
line("RETAIN_GRACE (24h 유예)", report.grace_retain_count);

const show = (title, arr) => {
  if (!arr.length) return;
  console.log(`\n${title}`);
  for (const x of arr.slice(0, 20))
    console.log(`  ${x.path}${x.ageHours ? `  (${x.ageHours}h)` : ""}${x.why ? `  — ${x.why}` : ""}`);
  if (arr.length > 20) console.log(`  … 그 외 ${arr.length - 20}건`);
};
show("ORPHAN_CANDIDATE — 사람 확인 후 별도 도구로만 삭제", report.orphan_candidate);
show("INVALID_PATH — 형식 이상(지우지 말 것)", report.invalid_path);
show("UNKNOWN — 판정 불가(지우면 안 됩니다)", report.unknown);

const dir = join(homedir(), "prod-runs");
mkdirSync(dir, { recursive: true });
const out = join(dir, `ORPHAN_STORAGE_${new Date().toISOString().slice(0, 10)}.json`);
// ⚠️ 경로에 user_id 가 들어간다. 이 파일을 공유하거나 커밋하지 말 것.
writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
console.log(`\n목록 저장: ${out}`);
console.log("⚠️ 경로에 사용자 ID 가 포함됩니다. 공유·커밋하지 마세요.");
console.log("⚠️ 이 도구는 아무것도 지우지 않았습니다. 삭제는 승인 후 별도 도구로 합니다.\n");
