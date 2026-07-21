// ============================================================
// resolve-practicum-schools.mjs — 협력학교 축약명 → 정식명·NEIS 코드
// ============================================================
// hwp 표에는 "개운초" 처럼 축약형으로만 적혀 있다. 급식·학교정보 API 를 쓰려면
// 정식명(서울개운초등학교)과 학교코드(7121298)가 필요하다.
//
// NEIS 학교기본정보 API 는 인증키 없이도 조회된다(실측). 시도교육청 코드를
// 서울부터 훑고, 없으면 인근 시도로 넓힌다 — 옥정초처럼 경기 소재인 경우가 있다.
//
// 결과를 그대로 믿지 않는다. 동명이교가 있을 수 있으므로 후보가 2개 이상이면
// 표시만 하고 자동 확정하지 않는다.
// ============================================================
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE = resolve(process.cwd(), "app/data/practicumSchools.json");
const APPLY = process.argv.includes("--apply");

// 서울 먼저, 그다음 인접 시도. 협력학교는 통학 가능 범위라 이 정도면 충분하다.
const OFFICES = [
  ["B10", "서울"], ["J10", "경기"], ["I10", "인천"],
];

async function lookup(fullName) {
  for (const [code, label] of OFFICES) {
    const url = "https://open.neis.go.kr/hub/schoolInfo"
      + `?Type=json&pIndex=1&pSize=10&ATPT_OFCDC_SC_CODE=${code}`
      + `&SCHUL_NM=${encodeURIComponent(fullName)}`;
    let j;
    try { j = await (await fetch(url)).json(); } catch { continue; }
    const rows = j?.schoolInfo?.[1]?.row;
    if (!rows?.length) continue;
    // 초등학교만 남긴다 — 같은 이름의 중학교가 걸릴 수 있다
    const elem = rows.filter((r) => r.SCHUL_KND_SC_NM === "초등학교");
    if (!elem.length) continue;
    return { office: label, officeCode: code, rows: elem };
  }
  return null;
}

const data = JSON.parse(readFileSync(FILE, "utf8"));
let resolved = 0, ambiguous = 0, missing = 0;

for (const s of data.schools) {
  if (s.neisCode) { resolved++; continue; }   // 이미 아는 것은 건드리지 않는다
  const guess = s.short.replace(/초$/, "초등학교");
  const hit = await lookup(guess);

  if (!hit) {
    console.log(`  ✖ ${s.short.padEnd(8)} 찾지 못함 (${guess})`);
    missing++;
    continue;
  }
  if (hit.rows.length > 1) {
    console.log(`  ⚠ ${s.short.padEnd(8)} 후보 ${hit.rows.length}개 — 자동 확정 안 함`);
    for (const r of hit.rows) console.log(`      ${r.SCHUL_NM} (${r.SD_SCHUL_CODE}) ${r.ORG_RDNMA ?? ""}`);
    s.candidates = hit.rows.map((r) => ({
      full: r.SCHUL_NM, neisCode: r.SD_SCHUL_CODE, address: r.ORG_RDNMA ?? null,
    }));
    ambiguous++;
    continue;
  }

  const r = hit.rows[0];
  s.full = r.SCHUL_NM;
  s.neisCode = r.SD_SCHUL_CODE;
  s.officeCode = hit.officeCode;
  s.address = r.ORG_RDNMA ?? null;
  s.tel = r.ORG_TELNO ?? null;
  s.homepage = r.HMPG_ADRES ?? null;
  console.log(`  ✔ ${s.short.padEnd(8)} → ${r.SCHUL_NM} (${r.SD_SCHUL_CODE}) ${hit.office}`);
  resolved++;
}

console.log(`\n확정 ${resolved} / 모호 ${ambiguous} / 미확인 ${missing}`);

if (APPLY) {
  data._meta.resolvedAt = new Date().toISOString().slice(0, 10);
  data._meta.resolveNote =
    "NEIS 학교기본정보 API 로 정식명·코드·주소·전화·홈페이지를 보강. "
    + "후보가 2개 이상인 학교는 candidates 에만 담고 확정하지 않았다.";
  writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`저장: ${FILE}`);
} else {
  console.log("(미리보기 — 저장하려면 --apply)");
}
