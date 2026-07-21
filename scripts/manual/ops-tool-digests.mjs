// ============================================================
// ops-tool-digests.mjs — 운영도구 파일의 Git blob SHA-1 + SHA-256 기록
// ============================================================
// GPT 런북이 운영도구를 수정할 때마다 "Git blob SHA와 파일 SHA-256 기록"을
// 요구한다. 손으로 뽑으면 빠뜨리거나 회차마다 대상이 달라지므로 고정한다.
//
// Git blob SHA-1 은 파일 내용만의 해시가 아니라
//   sha1("blob " + 바이트길이 + "\0" + 내용)
// 이다. git hash-object 없이도 동일 값을 계산할 수 있다.
//
// 사용: node scripts/manual/ops-tool-digests.mjs
// ============================================================
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const TOOLS = [
  "scripts/manual/prod-url.mjs",
  "scripts/manual/dev-url.mjs",
  "scripts/manual/prod-inventory.mjs",
  "scripts/manual/prod-conn-diag.mjs",
  "scripts/manual/set-prod-pooler.mjs",
  "scripts/manual/prod-backup.mjs",
  "scripts/manual/setup-prod-secret.mjs",
  "scripts/manual/verify-app-fence.mjs",
  "scripts/manual/prod-reset-community.sql",
];

const gitBlobSha1 = (buf) =>
  createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest("hex");

console.log("운영도구 digest (ops worktree 기준)\n");
console.log(`  ${"파일".padEnd(42)} ${"git blob SHA-1".padEnd(42)} SHA-256`);
console.log(`  ${"-".repeat(42)} ${"-".repeat(42)} ${"-".repeat(64)}`);

for (const t of TOOLS) {
  const p = resolve(process.cwd(), t);
  if (!existsSync(p)) { console.log(`  ${t.padEnd(42)} (없음)`); continue; }
  // git 은 저장소에 LF 로 넣으므로 CRLF 를 정규화해야 실제 blob SHA 와 일치한다.
  const raw = readFileSync(p);
  const norm = Buffer.from(raw.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  console.log(`  ${t.replace("scripts/manual/", "").padEnd(42)} ${gitBlobSha1(norm).padEnd(42)} ${createHash("sha256").update(norm).digest("hex")}`);
}
console.log("\n  (CRLF→LF 정규화 후 계산 — git 저장 형식과 일치)");
