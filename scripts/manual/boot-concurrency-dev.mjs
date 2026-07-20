// R2: bootstrap 실제 2세션 동시성 시험 (dev 전용). 두 세션이 동시에 owner 부트스트랩을
// 시도해도 advisory lock(owner_role_change)으로 직렬화되어 정확히 1명만 성공함을 실측.
// DEV_DB_URL은 .env.dev.local에서·값 비출력. 끝에 dev를 fixture 상태(d3=owner)로 복원.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const DEV_REF = "uiikgqeoxocpvphlmoqp", PROD_REF = "jclwkvxbvsegmbcnptpi";
function loadUrl() {
  const raw = readFileSync(resolve(process.cwd(), ".env.dev.local"), "utf8");
  const m = raw.match(/^\s*DEV_DB_URL\s*=\s*(.+)\s*$/m);
  if (!m) throw new Error("DEV_DB_URL 없음");
  const url = m[1].trim().replace(/^["']|["']$/g, "");
  const u = new URL(url);
  const host = u.hostname.toLowerCase(), user = decodeURIComponent(u.username || "");
  const ref = (/^db\.([a-z0-9]+)\.supabase\.co$/.exec(host) || [])[1]
            || (/\.pooler\.supabase\.com$/.test(host) ? (/(?:^|\.)([a-z0-9]{20})$/.exec(user) || [])[1] : null);
  if (ref === PROD_REF || ref !== DEV_REF) throw new Error("대상이 dev가 아님 — 중단");
  return url;
}
const T1 = "00000000-0000-0000-0000-0000000000f1";
const T2 = "00000000-0000-0000-0000-0000000000f2";
const HMAC1 = "a".repeat(64), HMAC2 = "b".repeat(64);

const bootSql = (target, hmac) => `do $$
declare v_existing uuid; v_m private.members%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('owner_role_change'));
  perform pg_sleep(0.3);  -- 창을 벌려 실제 경쟁 유도
  select * into v_m from private.members where id='${target}' for update;
  select id into v_existing from private.members where role='owner' limit 1;
  if v_existing is not null then raise exception 'refuse: owner exists'; end if;
  insert into private.school_identities(member_id,real_name,student_no_hmac,hmac_key_version)
    values ('${target}','concurrencytest','${hmac}',1);
  update private.members set verification_status='verified', role='owner' where id='${target}';
  insert into private.audit_logs(actor_id,action,target_type,target_id,reason)
    values ('${target}','bootstrap_owner','member','${target}','concurrency');
  if (select count(*) from private.members where role='owner')<>1 then raise exception 'post owner<>1'; end if;
end $$;`;

const url = loadUrl();
const setup = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const c1 = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const c2 = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function run(c, sql) {
  try { await c.query("begin"); await c.query(sql); await c.query("commit"); return "ok"; }
  catch (e) { try { await c.query("rollback"); } catch {} return "refused:" + (e.message || "").slice(0, 30); }
}

async function main() {
  await Promise.all([setup.connect(), c1.connect(), c2.connect()]);
  // 준비: 기존 owner 제거, 신선 대상 2명 생성(email 인증·닉네임·pending/member/none)
  await setup.query(`
    update private.members set role='member' where role='owner';
    insert into auth.users(id,email,email_confirmed_at) values
      ('${T1}','fx-cc1@dev.test',now()),('${T2}','fx-cc2@dev.test',now())
      on conflict (id) do update set email_confirmed_at=now();
    delete from private.school_identities where member_id in ('${T1}','${T2}');
    update private.members set nickname='동시성1', verification_status='pending', role='member', sanction='none', sanction_until=null where id='${T1}';
    update private.members set nickname='동시성2', verification_status='pending', role='member', sanction='none', sanction_until=null where id='${T2}';
  `);
  // 동시 실행
  const [r1, r2] = await Promise.all([run(c1, bootSql(T1, HMAC1)), run(c2, bootSql(T2, HMAC2))]);
  const owners = (await setup.query("select count(*)::int n, coalesce(string_agg(id::text,','),'')  ids from private.members where role='owner'")).rows[0];
  const ok = [r1, r2].filter((x) => x === "ok").length;
  const refused = [r1, r2].filter((x) => x.startsWith("refused")).length;
  console.log(JSON.stringify({ c1: r1, c2: r2, success: ok, refused, final_owner_count: owners.n }));
  const pass = ok === 1 && refused === 1 && owners.n === 1;
  console.log("R2_CONCURRENCY: " + (pass ? "PASS (정확히 1명 성공·1명 거부·owner=1)" : "FAIL"));
  // 복원: 테스트 대상 제거 + d3 owner 복원(fixture 상태)
  await setup.query(`
    delete from auth.users where id in ('${T1}','${T2}');
    delete from private.audit_logs where reason='concurrency';
    update private.members set verification_status='verified', role='owner', sanction='none', sanction_until=null where id='00000000-0000-0000-0000-0000000000d3';
  `);
  await Promise.all([setup.end(), c1.end(), c2.end()]);
  process.exit(pass ? 0 : 2);
}
main().catch((e) => { console.error("[fail] " + (e.message || e)); process.exit(1); });
