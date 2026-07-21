// ============================================================
// dev-ledger-relabel.mjs — ACL_MATERIALIZATION_LEDGER kind 라벨 정정 (READ-ONLY)
// ============================================================
// PASS_B 실행 당시 ledger 의 kind 를 relkind 로 판정해 시퀀스가 "schema" 로
// 오분류됐다. classification(REQUIRED / NO_REMOVAL_TARGET)은 정확하므로
// kind 라벨만 현재 committed dev 를 read-only 로 재조회해 정정한다.
// DB 에는 아무것도 쓰지 않는다. 원본 receipt 는 .pre-relabel 로 보존한다.
// ============================================================
import pg from "pg";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readDevEnv, assertDevUrl, scrub } from "./dev-url.mjs";
import * as L from "./fence-v2-lib.mjs";

const F = join(homedir(), "prod-runs", "DEV_PASS_B", "PASS_B_RECEIPTS.json");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

const { DEV_DB_URL: url } = readDevEnv(["DEV_DB_URL"]);
assertDevUrl(url, "DEV_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

try {
  await c.connect();
  const names = (await L.projectSchemas(c)).map((s) => s.schema);
  const inv = await L.inventory(c, names);
  const kindOf = new Map();
  for (const o of inv.relations) kindOf.set(o.ident, "relation");
  for (const o of inv.sequences) kindOf.set(o.ident, "sequence");
  for (const o of inv.routines) kindOf.set(o.ident, "routine");
  for (const o of inv.schemas) kindOf.set(o.ident, "schema");

  const before = readFileSync(F);
  const j = JSON.parse(before);
  let changed = 0, unresolved = 0;
  for (const row of j.ACL_MATERIALIZATION_LEDGER) {
    const k = kindOf.get(row.ident);
    if (!k) { row.kind = "UNRESOLVED"; unresolved++; continue; }
    if (row.kind !== k) { row.kind = k; changed++; }
  }
  j.LEDGER_KIND_RELABEL = {
    reason: "PASS_B 당시 relkind 기반 판정으로 sequence 가 schema 로 오분류됨. classification 은 불변.",
    relabeled: changed, unresolved,
    source_receipt_sha256_before: sha256(before),
    method: "READ_ONLY_REINVENTORY_OF_COMMITTED_DEV",
  };
  copyFileSync(F, F + ".pre-relabel");
  const out = Buffer.from(JSON.stringify(j, null, 2));
  writeFileSync(F, out);

  const tally = {};
  for (const r of j.ACL_MATERIALIZATION_LEDGER) {
    const key = `${r.kind}/${r.classification}`;
    tally[key] = (tally[key] || 0) + 1;
  }
  console.log(`relabeled=${changed} unresolved=${unresolved}`);
  console.log("분류 집계:", JSON.stringify(tally, null, 1));
  console.log("RECEIPT_SHA256_AFTER=" + sha256(out));
} catch (e) {
  console.error("[fail] " + scrub(e.message || String(e), url));
  process.exitCode = 1;
} finally { try { await c.end(); } catch {} }
