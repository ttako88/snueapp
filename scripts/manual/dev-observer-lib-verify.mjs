// ============================================================
// dev-observer-lib-verify.mjs — observer-lib 문법·identity 검증 (READ-ONLY)
// ============================================================
// GPT §4-5 "보완된 observer logic 을 현재 dev 에서 read-only 로
// 문법·identity 검증" 대응.
//
// dev 는 이미 COMMIT 됐으므로 가시성은 당연히 전부 1 이다. 여기서 검증하는
// 것은 가시성 수치가 아니라 다음이다.
//   - 매니페스트 산출이 봉인 baseline 기준으로 정확한가
//   - kind 별 lookup 이 전부 문법적으로 실행되고 해당 객체를 집어내는가
//   - commitAllowed 게이트가 "보이면 막는다"로 올바르게 동작하는가
//   - sealPreFenceRaw / compareRawToSeal 이 순서 차이까지 잡아내는가
// ============================================================
import pg from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readDevEnv, assertDevUrl, scrub } from "./dev-url.mjs";
import * as L from "./fence-v2-lib.mjs";
import * as O from "./observer-lib.mjs";

const BASE = join(homedir(), "prod-runs", "DEV_PRE_TX_BASELINE", "PRE_TX_BASELINE_RECEIPT.json");
const head = (t) => console.log(`\n=== ${t} ===`);
const line = (k, v) => console.log(`  ${String(k).padEnd(46)} ${v}`);
const fails = [];
const rec = (n, ok, d) => { if (!ok) fails.push(n); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); };

const { DEV_DB_URL: url } = readDevEnv(["DEV_DB_URL"]);
assertDevUrl(url, "DEV_DB_URL");
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const obs = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  await c.connect(); await obs.connect();
  const baseline = JSON.parse(readFileSync(BASE, "utf8"));
  const baseIdents = new Set(baseline.objects.map((o) => `${o.kind}|${o.ident}`));
  const schemas = (await L.projectSchemas(c)).map((s) => s.schema);

  head("1. createdManifest — 분모를 카탈로그에서 산출");
  const man = await O.createdManifest(c, schemas, baseIdents);
  line("kind별", JSON.stringify(man.byKind));
  line("총계", man.total);
  rec("dev 실측 매니페스트 95와 일치", man.total === 95, String(man.total));
  rec("routine 55 포함 (08 이 놓쳤던 부분)", man.byKind.routine === 55, String(man.byKind.routine));
  rec("schema 2 포함", man.byKind.schema === 2, String(man.byKind.schema));

  head("2. kind별 lookup 실행 — 문법·identity 해석");
  const vis = await O.observerVisibility(obs, man);
  line("denominator / checked", `${vis.denominator} / ${vis.checked}`);
  line("visible / unresolvable", `${vis.visible} / ${vis.unresolvable}`);
  rec("전수 검사됨 (checked = denominator)", vis.checked === man.total,
    `${vis.checked}/${man.total}`);
  rec("해석 실패 0", vis.unresolvable === 0, String(vis.unresolvable));
  // dev 는 COMMIT 됐으므로 전부 보여야 한다. 이게 lookup 이 실제로
  // 객체를 집어낸다는 증거다. 안 보이면 lookup 이 헛돈 것이다.
  rec("커밋된 객체가 전부 보임 (lookup 실효성)", vis.visible === man.total,
    `${vis.visible}/${man.total}`);
  rec("commitAllowed 게이트가 올바르게 막음", vis.commitAllowed === false,
    `commitAllowed=${vis.commitAllowed} (보이므로 false 가 정상)`);

  head("3. sealPreFenceRaw — 봉인");
  const seal = await O.sealPreFenceRaw(c, schemas);
  line("entry / NULL acl", `${seal.entry_count} / ${seal.null_acl_count}`);
  line("sha256", seal.sha256.slice(0, 32) + "…");
  rec("봉인 항목이 비어있지 않음", seal.entry_count > 0, String(seal.entry_count));

  head("4. compareRawToSeal — 자기 자신과 대조하면 exact");
  const again = await O.sealPreFenceRaw(c, schemas);
  const same = O.compareRawToSeal(seal, again.entries);
  rec("동일 상태 대조 = exact", same.exact, JSON.stringify({
    order: same.order_only_difference_count, content: same.content_difference_count,
    nullness: same.nullness_difference_count }));

  head("5. 대조기가 실제로 차이를 잡는지 (음성 대조)");
  // 봉인을 인위로 흔들어 각 차이 유형이 실제로 검출되는지 확인한다.
  // 검출기가 조용하면 "exact" 는 아무 의미가 없다.
  const idx = again.entries.findIndex((e) => !e.acl_is_null && (e.acl_raw || "").includes(","));
  if (idx < 0) {
    line("음성 대조", "aclitem 2개 이상인 항목이 없어 순서 검출은 건너뜀");
  } else {
    const flipped = again.entries.map((e, i) => {
      if (i !== idx) return e;
      const it = e.acl_raw.replace(/^\{|\}$/g, "").split(",");
      return { ...e, acl_raw: `{${it.reverse().join(",")}}` };
    });
    const d1 = O.compareRawToSeal({ entries: again.entries }, flipped);
    rec("ORDER_ONLY 차이를 검출", d1.order_only_difference_count === 1,
      `order=${d1.order_only_difference_count}`);
    const mutated = again.entries.map((e, i) =>
      i === idx ? { ...e, acl_raw: "{postgres=r/postgres}" } : e);
    const d2 = O.compareRawToSeal({ entries: again.entries }, mutated);
    rec("CONTENT 차이를 검출", d2.content_difference_count === 1,
      `content=${d2.content_difference_count}`);
    const nulled = again.entries.map((e, i) =>
      i === idx ? { ...e, acl_is_null: true } : e);
    const d3 = O.compareRawToSeal({ entries: again.entries }, nulled);
    rec("NULLNESS 차이를 검출", d3.nullness_difference_count === 1,
      `nullness=${d3.nullness_difference_count}`);
    const dropped = again.entries.filter((_, i) => i !== idx);
    const d4 = O.compareRawToSeal({ entries: again.entries }, dropped);
    rec("항목 누락을 검출", d4.diffs.some((x) => x.type === "ONLY_IN_SEAL"),
      d4.diffs.filter((x) => x.type === "ONLY_IN_SEAL").length + "건");
  }

  head("판정");
  console.log(`\nOBSERVER_LIB_VERIFY=${fails.length ? "FAIL" : "PASS"}`);
  console.log(`MANIFEST_TOTAL=${man.total} BY_KIND=${JSON.stringify(man.byKind)}`);
  console.log(`LOOKUP_UNRESOLVABLE=${vis.unresolvable}`);
  console.log(`PREFENCE_SEAL_ENTRIES=${seal.entry_count}`);
  if (fails.length) for (const f of fails) console.log(`  · ${f}`);
  return fails.length ? 3 : 0;
}

let code = 1;
try { code = await main(); } catch (e) { console.error("[fail] " + scrub(e.message || String(e), url)); }
finally { try { await c.end(); } catch {} try { await obs.end(); } catch {} }
process.exit(code);
