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
// 실행 예: node provision-storage.mjs                → dry-run (원격 읽기 전용·변경 없음)
//          node provision-storage.mjs --offline-plan  → 완전 무접촉, 기대 설정만 출력
//          APP_ENV=dev node provision-storage.mjs --apply
// env: SUPABASE_URL / SUPABASE_SECRET_KEY / APP_ENV(dev|prod) /
//      EXPECTED_PROJECT_REF_DEV / EXPECTED_PROJECT_REF_PROD  (값은 env에만 — 코드 미기재)
// r4: dry-run도 원격 읽기이므로 APP_ENV·EXPECTED_PROJECT_REF 검증을 통과해야 조회함
// ============================================================
import { createClient } from "@supabase/supabase-js";

const BUCKET = "verification-docs";
const EXPECTED = {
  public: false,
  fileSizeLimit: 10 * 1024 * 1024,
  allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
};

const apply = process.argv.includes("--apply");
const offlinePlan = process.argv.includes("--offline-plan");
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
const appEnv = process.env.APP_ENV;   // r4: TARGET_ENV → APP_ENV 통일 (dev|prod, 그 외 중단)

// r4: 고정 오류 코드만 출력 (원문·secret 비출력, 운영자가 분류 가능)
//   env_missing / env_invalid / ref_mismatch / bucket_not_found / config_mismatch / api_failure / verify_failure
function fail(codeName, exit = 1) { console.error(`[fail] ${codeName}`); process.exit(exit); }

if (offlinePlan) {                    // 완전 무접촉 모드: 기대 설정만 출력
  console.log("[offline-plan] 기대 설정:", JSON.stringify({ bucket: BUCKET, ...EXPECTED }));
  process.exit(0);
}
if (!url || !key) fail("env_missing");
// r4: dry-run도 원격 읽기(getBucket)를 하므로 환경 검증을 모든 네트워크 모드에 적용
if (!["dev", "prod"].includes(appEnv ?? "")) fail("env_invalid");
const ref = new URL(url).hostname.split(".")[0];
const expectedRef = appEnv === "prod"
  ? process.env.EXPECTED_PROJECT_REF_PROD
  : process.env.EXPECTED_PROJECT_REF_DEV;
if (!expectedRef) fail("env_missing");
if (ref !== expectedRef) fail("ref_mismatch");
console.log(`[mode] ${apply ? "APPLY" : "dry-run (원격 읽기 전용·변경 없음)"} / env=${appEnv} / bucket=${BUCKET}`);

const supabase = createClient(url, key, { auth: { persistSession: false } });

const { data: existing, error: getErr } = await supabase.storage.getBucket(BUCKET);
if (getErr && !/not found/i.test(getErr.message)) fail("api_failure");

// r4: 정규화 비교 — MIME은 순서 무관 정렬, size는 숫자 바이트
const normMimes = (a) => [...(a ?? [])].map(String).sort().join(",");
if (existing) {
  const diffs = [];
  if (existing.public !== EXPECTED.public) diffs.push("public");
  if (Number(existing.file_size_limit) !== EXPECTED.fileSizeLimit) diffs.push("file_size_limit");
  if (normMimes(existing.allowed_mime_types) !== normMimes(EXPECTED.allowedMimeTypes))
    diffs.push("allowed_mime_types");
  if (diffs.length > 0) { console.error(`[detail] ${diffs.join(",")}`); fail("config_mismatch", 2); }
  console.log("[ok] 버킷 존재 + 설정 일치 (변경 없음)");
} else if (!apply) {
  console.log("[dry-run] 버킷 없음 → --apply 시 생성 예정 (private, 10MB, JPEG/PNG/WebP/PDF)");
} else {
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: EXPECTED.public,
    fileSizeLimit: EXPECTED.fileSizeLimit,
    allowedMimeTypes: EXPECTED.allowedMimeTypes,
  });
  if (error) fail("api_failure");
  const { data: after } = await supabase.storage.getBucket(BUCKET);
  if (!after || after.public !== false) fail("verify_failure", 2);
  console.log("[ok] 버킷 생성 + private 검증 완료");
}
// 이 스크립트에 삭제 기능은 없다. Storage RLS 정책은 005_storage_policies.sql 소관.
