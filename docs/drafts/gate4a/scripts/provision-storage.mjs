// ============================================================
// provision-storage.mjs
// DRAFT — NOT EXECUTED — NOT APPROVED FOR DEV APPLY
// 근거: GATE3_DESIGN.md v1.3 §7 — 버킷은 서버 프로비저닝 스크립트로 생성 (dev·운영 동일)
// 실행: node scripts/provision-storage.mjs  (env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
// 이 초안은 어떤 프로젝트에도 실행되지 않았다. 실제 값은 env로만 주입 — 코드에 미기재.
// ============================================================
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;              // <DEV_PROJECT_REF> | <PROD_PROJECT_REF>
const key = process.env.SUPABASE_SERVICE_ROLE_KEY; // 서버 env에만 존재 (§2 트랙 B)
if (!url || !key) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요 (실행 전 dev/prod 대상 재확인!)");
  process.exit(1);
}

const BUCKET = "verification-docs";                // 인증 원본 전용 비공개 버킷 (§4.3)

const supabase = createClient(url, key, { auth: { persistSession: false } });

const { data: existing } = await supabase.storage.getBucket(BUCKET);
if (existing) {
  console.log(`[skip] bucket '${BUCKET}' 이미 존재 — public=${existing.public}`);
  if (existing.public) {
    console.error("!!! 버킷이 public 상태 — 즉시 수동 확인 필요");
    process.exit(2);
  }
} else {
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: false,                                  // 비공개 필수 (§4.3)
    fileSizeLimit: 10 * 1024 * 1024,                // 10MB
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "application/pdf"], // SVG·HTML 금지
  });
  if (error) { console.error("createBucket 실패:", error.message); process.exit(1); }
  console.log(`[ok] bucket '${BUCKET}' 생성`);
}

// 생성 후 검증 (§7: 생성 후 public=false 검증)
const { data: after, error: verr } = await supabase.storage.getBucket(BUCKET);
if (verr || !after || after.public !== false) {
  console.error("검증 실패 — public=false 확인 불가"); process.exit(2);
}
console.log("[verified] private bucket OK");
// Storage RLS 정책(업로드 경로 {uid}/{request_id}/{random} 제한)은 SQL 마이그레이션 소관 — §7
// TODO: storage.objects RLS 정책 SQL은 002 후속 또는 별도 005로 — GPT 검수 시 배치 결정
