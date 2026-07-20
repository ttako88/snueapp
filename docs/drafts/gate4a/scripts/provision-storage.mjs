// ============================================================
// provision-storage.mjs  (r3 — GPT 3차 검수 원칙 반영)
// DRAFT — NOT EXECUTED — NOT APPROVED FOR DEV APPLY
// 근거: GATE3_DESIGN.md v1.3 §7 — dev·운영 동일 스크립트
//
// 원칙 (GPT 3차):
//  - --dry-run이 기본. 실제 적용은 --apply 플래그 + TARGET_ENV 환경 확인이 모두 있어야 함
//  - 기존 버킷이 있으면 설정을 읽어 기대값과 비교만 — 불일치 시 조용히 덮어쓰지 않고 실패·보고
//  - 오류·로그에 secret·토큰·키 출력 금지
//  - dev/prod 프로젝트 ID 혼동 방지 (URL의 project ref를 TARGET_ENV 기대값과 대조)
//  - 실제 삭제 기능 없음 (이 스크립트는 생성·검증만)
//
// 실행 예: node provision-storage.mjs                → dry-run (기본)
//          TARGET_ENV=dev node provision-storage.mjs --apply
// env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / TARGET_ENV(dev|prod) /
//      EXPECTED_PROJECT_REF_DEV / EXPECTED_PROJECT_REF_PROD  (값은 env에만 — 코드 미기재)
// ============================================================
import { createClient } from "@supabase/supabase-js";

const BUCKET = "verification-docs";
const EXPECTED = {
  public: false,
  fileSizeLimit: 10 * 1024 * 1024,
  allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
};

const apply = process.argv.includes("--apply");
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const targetEnv = process.env.TARGET_ENV;

function fail(msg, code = 1) { console.error(`[fail] ${msg}`); process.exit(code); }

if (!url || !key) fail("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요");
if (apply && !["dev", "prod"].includes(targetEnv ?? ""))
  fail("--apply에는 TARGET_ENV=dev|prod 필수 (dry-run은 불필요)");

// dev/prod 혼동 방지: URL의 project ref를 기대값과 대조
const ref = new URL(url).hostname.split(".")[0];
const expectedRef = targetEnv === "prod"
  ? process.env.EXPECTED_PROJECT_REF_PROD
  : process.env.EXPECTED_PROJECT_REF_DEV;
if (apply) {
  if (!expectedRef) fail(`EXPECTED_PROJECT_REF_${targetEnv.toUpperCase()} 미설정 — 대상 확인 불가`);
  if (ref !== expectedRef) fail(`project ref 불일치 — URL은 '${ref}', ${targetEnv} 기대값과 다름. 중단`);
}
console.log(`[mode] ${apply ? "APPLY" : "dry-run"} / target=${targetEnv ?? "(미지정)"} / bucket=${BUCKET}`);

const supabase = createClient(url, key, { auth: { persistSession: false } });

const { data: existing, error: getErr } = await supabase.storage.getBucket(BUCKET);
if (getErr && !/not found/i.test(getErr.message)) fail(`getBucket 오류 (메시지 생략 — secret 비출력)`);

if (existing) {
  // 비교만 — 불일치 시 실패·보고 (조용한 덮어쓰기 금지)
  const diffs = [];
  if (existing.public !== EXPECTED.public) diffs.push("public");
  if (Number(existing.file_size_limit) !== EXPECTED.fileSizeLimit) diffs.push("file_size_limit");
  const mimes = existing.allowed_mime_types ?? [];
  if (mimes.length !== EXPECTED.allowedMimeTypes.length
      || !EXPECTED.allowedMimeTypes.every((m) => mimes.includes(m))) diffs.push("allowed_mime_types");
  if (diffs.length > 0) fail(`버킷 존재하나 설정 불일치: ${diffs.join(", ")} — 수동 확인 필요`, 2);
  console.log("[ok] 버킷 존재 + 설정 일치 (변경 없음)");
} else if (!apply) {
  console.log("[dry-run] 버킷 없음 → --apply 시 생성 예정 (private, 10MB, JPEG/PNG/WebP/PDF)");
} else {
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: EXPECTED.public,
    fileSizeLimit: EXPECTED.fileSizeLimit,
    allowedMimeTypes: EXPECTED.allowedMimeTypes,
  });
  if (error) fail("createBucket 실패 (메시지 생략)");
  const { data: after } = await supabase.storage.getBucket(BUCKET);
  if (!after || after.public !== false) fail("생성 후 검증 실패 — public=false 확인 불가", 2);
  console.log("[ok] 버킷 생성 + private 검증 완료");
}
// 이 스크립트에 삭제 기능은 없다. Storage RLS 정책은 005_storage_policies.sql 소관.
