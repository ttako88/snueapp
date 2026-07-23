// apply-pending.mjs — supabase/migrations/pending/*.sql 을 번호순으로 전부 적용.
// 개별 적용 로직은 검증된 prod-apply-migration.mjs 를 그대로 재사용(감싸기만 함).
// 기본 = 무엇이 적용될지 목록만(dry). 실제 적용은 --execute.
// 사용: node scripts/manual/apply-pending.mjs           (미리보기)
//       node scripts/manual/apply-pending.mjs --execute (실제 적용, 소유자)
import { readdirSync } from "node:fs";
import { execSync } from "node:child_process";

const DIR = "supabase/migrations/pending";
let files;
try { files = readdirSync(DIR).filter((f) => /^\d.*\.sql$/.test(f)).sort(); }
catch { console.error(`[중단] ${DIR} 를 찾지 못했습니다(프로젝트 루트에서 실행하세요).`); process.exit(1); }

if (files.length === 0) { console.log("적용할 pending 마이그레이션이 없습니다. (전부 적용됨)"); process.exit(0); }

console.log(`pending ${files.length}개 (번호 오름차순으로 적용):`);
for (const f of files) console.log("  · " + f);

if (!process.argv.includes("--execute")) {
  console.log("\n[dry] 위 순서대로 적용됩니다.");
  console.log("실제 적용: node scripts/manual/apply-pending.mjs --execute");
  process.exit(0);
}

for (const f of files) {
  console.log(`\n════════ 적용: ${f} ════════`);
  try {
    execSync(`node scripts/manual/prod-apply-migration.mjs pending/${f} --execute`, { stdio: "inherit" });
  } catch {
    console.error(`\n[중단] ${f} 적용 중 오류 — 이후 파일은 적용하지 않았습니다. 위 로그를 확인하세요.`);
    process.exit(1);
  }
}
console.log("\n✅ pending 전부 적용 완료.");
console.log("   ※ 'anon EXECUTE'·'객체 안 늘었다' 류 FAIL은 정상(무시). '실행 완료'면 성공.");
