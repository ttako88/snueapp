// ============================================================
// dev-emit-reference-profile.mjs — dev 참조 프로파일 봉인 (READ-ONLY)
// ============================================================
// dev 는 동일 파생물 + 동일 fence 로 COMMIT 까지 마친 참조 구현이다.
// 그 상태를 환경 독립 프로파일로 뽑아 봉인한다. 운영 사후검증은 이것과
// 대조한다. 자기 자신을 기준으로 삼는 검증을 피하기 위함이다.
//
// 대조기가 실제로 차이를 잡는지 음성 대조도 함께 돌린다.
// 검출기가 조용하면 "일치"는 아무 의미가 없다.
// ============================================================
import pg from "pg";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readDevEnv, assertDevUrl, scrub } from "./dev-url.mjs";
import * as RP from "./reference-profile-lib.mjs";

const OUT = join(homedir(), "prod-runs", "REFERENCE_PROFILE");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(46)} ${v}`);
const fails = [];
const rec = (n, ok, d) => { if (!ok) fails.push(n); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

const { DEV_DB_URL: url } = readDevEnv(["DEV_DB_URL"]);
assertDevUrl(url, "DEV_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect();
  mkdirSync(OUT, { recursive: true });

  head("1. dev 프로파일 산출");
  const prof = await RP.buildProfile(c, "DEV_POST_TXB_FENCED");
  line("topology", JSON.stringify(prof.topology));
  line("acl_is_null", prof.acl_is_null_count);
  line("mutation privilege", prof.mutation_privilege_count);
  line("default privileges", prof.default_privileges.count);
  line("privilege matrix 키", Object.keys(prof.privilege_matrix).length);
  line("probe", `${prof.probe_telemetry.attempted}/${prof.probe_telemetry.completed}, unclassified ${prof.probe_telemetry.unclassified}`);
  rec("mutation privilege 0", prof.mutation_privilege_count === 0, String(prof.mutation_privilege_count));
  rec("probe unclassified 0", prof.probe_telemetry.unclassified === 0, String(prof.probe_telemetry.unclassified));

  head("2. 자기 대조 = 일치");
  const self = RP.compareProfiles(prof, prof);
  rec("동일 프로파일 대조 시 차이 0", self.identical, String(self.difference_count));

  head("3. 음성 대조 — 검출기가 실제로 잡는가");
  const mutate = (fn) => { const p = JSON.parse(JSON.stringify(prof)); fn(p); return p; };
  const t1 = RP.compareProfiles(prof, mutate((p) => { p.topology.routine -= 1; }));
  rec("topology 차이 검출", t1.difference_count > 0, `${t1.difference_count}건`);
  const t2 = RP.compareProfiles(prof, mutate((p) => { p.object_idents.relation.pop(); }));
  rec("객체 누락 검출", t2.diffs.some((d) => d.missing?.length), JSON.stringify(t2.diffs.find((d) => d.missing?.length)?.missing ?? []));
  const t3 = RP.compareProfiles(prof, mutate((p) => {
    const k = Object.keys(p.privilege_matrix)[0]; p.privilege_matrix[k].count += 1; }));
  rec("privilege matrix 차이 검출", t3.difference_count > 0, `${t3.difference_count}건`);
  const t4 = RP.compareProfiles(prof, mutate((p) => { p.default_privileges.canonical_sha256 = "x"; }));
  rec("default privilege 변조 검출", t4.difference_count > 0, `${t4.difference_count}건`);
  const t5 = RP.compareProfiles(prof, mutate((p) => {
    p.privilege_matrix["anon|fn|EXECUTE"] = { count: 1, idents_sha256: "y" }; }));
  rec("없던 권한이 생긴 것 검출", t5.diffs.some((d) => d.type === "ONLY_IN_TARGET"),
    t5.diffs.filter((d) => d.type === "ONLY_IN_TARGET").length + "건");

  const buf = Buffer.from(JSON.stringify(prof, null, 2));
  const file = join(OUT, "DEV_REFERENCE_PROFILE.json");
  writeFileSync(file, buf);

  head("판정");
  console.log(`\nREFERENCE_PROFILE=${fails.length ? "FAIL" : "SEALED"}`);
  console.log(`TOPOLOGY=${JSON.stringify(prof.topology)}`);
  console.log(`MUTATION_PRIVILEGE=${prof.mutation_privilege_count}`);
  console.log(`SHA256=${createHash("sha256").update(buf).digest("hex")}`);
  console.log(`OUT=${file}`);
  if (fails.length) for (const f of fails) console.log(`  · ${f}`);
  return fails.length ? 3 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} }
process.exit(code);
