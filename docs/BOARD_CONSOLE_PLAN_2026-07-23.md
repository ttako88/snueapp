# 게시판 관리 콘솔 구현 계획 (2026-07-23)

> **실행자 안내:** 이 계획은 `docs/BOARD_CONSOLE_DESIGN_2026-07-23.md`(옵션 superset 설계)의 구현본이다.
> 각 Task는 실패테스트→구현→통과→커밋의 TDD 사이클. 체크박스로 추적.

**Goal:** 운영자가 콘솔에서 게시판을 생성·수정·숨김·정렬하고, 게시판별 옵션(익명·광고·장터·SR적립 등)을 켜고 끌 수 있게 한다. 새 게시판 아이디어마다 코드 배포가 필요 없게.

**Architecture:** `public.boards` 테이블(이미 존재)을 **옵션 컬럼 superset으로 확장** + admin CRUD RPC(`board.manage` 권한) + 표시 경로를 하드코딩 `boards.js`에서 테이블(`list_boards()`)로 전환 + `/admin/console/boards` 콘솔 모듈. 각 옵션 기본 off → 새 게시판도 지금과 동일 동작.

**Tech Stack:** Next.js 16 App Router · React 19 · Supabase(Postgres definer RPC) · Tailwind. 마이그레이션은 `supabase/migrations/pending/` (소유자가 cmd로 적용 — 하네스가 Claude의 운영 DB 쓰기 차단).

## Global Constraints (spec에서 그대로)
- 마이그레이션 다음 번호 = **034**. `pending/`에 두고 소유자 cmd 적용. 추가형·가역.
- 정의자 RPC 규약: `security definer set search_path=''`, 사설 헬퍼는 `revoke execute ... from public,anon,authenticated`. authenticated용은 `grant execute ... to authenticated` + 내부 `require_permission`.
- 권한: `private.require_permission('board.manage')`. `board.manage`를 owner에 시드.
- 커밋은 명시 경로만(`git add <경로>`). `git add -A` 금지(GPT WIP 딸려감).
- boards 표시 데이터의 단일 출처를 테이블로 만든다 — `app/lib/boards.js` 하드코딩 배열 제거(폴백 상수만).
- 옵션 컬럼 기본값 = off/안전(새 게시판이 기존과 동일하게 동작).
- 완료어휘: CODE_WRITTEN/LOCAL_VERIFIED/PROD_VERIFIED/USER_REACHABLE. flag/미적용이면 USER_REACHABLE 아님.

## 현재 상태 (실측)
- `public.boards(id smallint PK, slug, name, icon, teaser, sort, access['members'|'preview'|'hidden'])` — 9행 시드, RLS(anon=preview만, auth=정책). `posts.board_id`→boards.id FK.
- 표시: `app/board/page.js`가 `import { BOARDS } from "../lib/boards"` 하드코딩 배열로 렌더. `app/lib/community/boards.js`의 `resolveBoardId(slug)`는 테이블 조회로 추정(확인 Task 2에서).
- 콘솔: `app/admin/console/boards/`는 현재 Placeholder. 권한 테이블 `private.role_permissions`, `require_permission` 존재(028).

## File Structure
- `supabase/migrations/pending/034_board_console.sql` — **생성**: boards 옵션 컬럼 확장 + board.manage 시드 + list_boards() + admin CRUD RPC.
- `app/lib/boards.js` — **수정**: 하드코딩 BOARDS를 폴백 상수로 강등(주석 갱신).
- `app/lib/community/boardList.js` — **생성**: 클라 `listBoards()`(공개 목록 RPC 래퍼) + 캐시.
- `app/board/page.js` — **수정**: BOARDS 배열 → `listBoards()` 결과.
- `app/lib/community/adminBoards.js` — **생성**: 콘솔용 admin RPC 래퍼.
- `app/admin/console/boards/page.js` — **수정**(Placeholder→실모듈): 목록·생성/수정·숨김·정렬.
- `tests/boardList.test.mjs` · `tests/adminBoards.test.mjs` — **생성**: 순수 로직(정렬·필터·검증) 테스트.

---
## Phase 1 — 콘솔 기본 CRUD (기존 필드로, 옵션 무관 · 최우선)

### Task 1: 마이그레이션 034 — board.manage 권한 + list_boards() 공개 RPC
**Files:** Create `supabase/migrations/pending/034_board_console.sql`
**Interfaces — Produces:** `public.list_boards()` returns setof(slug,name,icon,teaser,sort,access,status); `private.role_permissions`에 `('owner','board.manage')`.

- [ ] **Step 1: SQL 작성 (034, 1부: 권한 + 공개 목록)**
```sql
begin;
-- 1) board.manage 권한 시드 (owner 전용, 콘솔 게시판 관리)
insert into private.role_permissions (role, permission) values ('owner','board.manage')
  on conflict (role, permission) do nothing;

-- 2) 상태 컬럼 (access와 별개: 운영 비활성/보관). 기본 active.
alter table public.boards
  add column if not exists status text not null default 'active'
    check (status in ('active','disabled')),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists updated_by uuid;

-- 3) 공개 목록 RPC — 표시용 단일 출처. anon/authenticated 호출 가능.
--    hidden/disabled 제외. RLS 우회 위해 definer(정의자)로 일관 반환.
create or replace function public.list_boards()
returns table (slug text, name text, icon text, teaser text, sort smallint, access text)
language sql stable security definer set search_path = '' as $$
  select b.slug, b.name, b.icon, b.teaser, b.sort, b.access
    from public.boards b
   where b.status = 'active' and b.access <> 'hidden'
   order by b.sort asc, b.id asc
$$;
revoke execute on function public.list_boards() from public;
grant execute on function public.list_boards() to anon, authenticated;
commit;
```

- [ ] **Step 2: dry-run 검증 (Claude 가능, 읽기)**
Run: `node scripts/manual/prod-apply-migration.mjs pending/034_board_console.sql`
Expected: dry-run 통과(구문·객체계획 출력). `--execute`는 **소유자 cmd**.

- [ ] **Step 3: 커밋**
```bash
git add supabase/migrations/pending/034_board_console.sql
git commit -m "feat(board): 034 board.manage 권한 + list_boards 공개 RPC"
```

### Task 2: 표시 경로를 테이블로 전환 (boards.js 하드코딩 제거)
**Files:** Create `app/lib/community/boardList.js`, `tests/boardList.test.mjs`; Modify `app/board/page.js`, `app/lib/boards.js`
**Interfaces — Consumes:** `public.list_boards()` (Task 1). **Produces:** `listBoards()→Promise<Board[]>`, `Board={slug,name,icon,teaser,sort,access}`.

- [ ] **Step 1: 실패 테스트 — 정렬·형태 보장 (순수 함수 분리)**
```js
// tests/boardList.test.mjs
import { test } from "node:test"; import assert from "node:assert/strict";
import { sortBoards } from "../app/lib/community/boardList.js";
test("sortBoards: sort 오름차순, 동률은 slug", () => {
  const out = sortBoards([{slug:"b",sort:2},{slug:"a",sort:1},{slug:"c",sort:1}]);
  assert.deepEqual(out.map(b=>b.slug), ["a","c","b"]);
});
```

- [ ] **Step 2: 실패 확인**
Run: `node --test tests/boardList.test.mjs`
Expected: FAIL (`sortBoards` 없음).

- [ ] **Step 3: 구현**
```js
// app/lib/community/boardList.js
import { supabase } from "../supabase/client";
export function sortBoards(rows) {
  return [...rows].sort((a,b) => (a.sort-b.sort) || String(a.slug).localeCompare(String(b.slug)));
}
let _cache = null;
export async function listBoards() {
  if (_cache) return _cache;
  const { data, error } = await supabase.rpc("list_boards");
  if (error || !Array.isArray(data)) return null; // 폴백은 호출부가 처리
  _cache = sortBoards(data);
  return _cache;
}
```

- [ ] **Step 4: 통과 확인**
Run: `node --test tests/boardList.test.mjs` → PASS

- [ ] **Step 5: board/page.js 전환 (폴백 유지)**
```js
// app/board/page.js — 상단
import { BOARDS as BOARDS_FALLBACK } from "../lib/boards"; // 데이터 못 읽을 때만
import { listBoards } from "../lib/community/boardList";
// 컴포넌트에서: const boards = (await listBoards()) ?? BOARDS_FALLBACK;
// 기존 {BOARDS.map(...)} → {boards.map(...)}
```
`app/lib/boards.js` 주석을 "표시 단일 출처는 list_boards(); 이 배열은 폴백"으로 갱신.

- [ ] **Step 6: 로컬 검증 + 커밋**
Run: `node --test tests/boardList.test.mjs` → PASS
```bash
git add app/lib/community/boardList.js tests/boardList.test.mjs app/board/page.js app/lib/boards.js
git commit -m "feat(board): 표시 경로 list_boards 전환(하드코딩 배열은 폴백)"
```

### Task 3: admin CRUD RPC (034 2부)
**Files:** Modify `supabase/migrations/pending/034_board_console.sql`
**Interfaces — Produces:** `admin_list_boards()`, `admin_upsert_board(...)`, `admin_set_board_status(text,text)`, `admin_reorder_boards(text[])` — 모두 `board.manage`.

- [ ] **Step 1: SQL 추가 (commit 앞에)**
```sql
-- admin: 전체 목록(숨김 포함)
create or replace function public.admin_list_boards()
returns setof public.boards
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_permission('board.manage');
  return query select * from public.boards order by sort asc, id asc;
end $$;
revoke execute on function public.admin_list_boards() from public, anon, authenticated;
grant  execute on function public.admin_list_boards() to authenticated;

-- admin: 생성/수정 (slug 기준 upsert). slug 불변 규칙은 클라+여기 CHECK로.
create or replace function public.admin_upsert_board(
  p_slug text, p_name text, p_icon text, p_teaser text,
  p_access text, p_sort smallint)
returns public.boards
language plpgsql security definer set search_path = '' as $$
declare v public.boards;
begin
  perform private.require_permission('board.manage');
  if p_slug !~ '^[a-z0-9-]{2,32}$' then raise exception 'bad slug'; end if;
  if p_access not in ('members','preview','hidden') then raise exception 'bad access'; end if;
  insert into public.boards (slug,name,icon,teaser,access,sort,updated_at,updated_by)
    values (p_slug,p_name,p_icon,p_teaser,p_access,coalesce(p_sort,100), now(), auth.uid())
  on conflict (slug) do update set
    name=excluded.name, icon=excluded.icon, teaser=excluded.teaser,
    access=excluded.access, sort=excluded.sort, updated_at=now(), updated_by=auth.uid()
  returning * into v;
  return v;
end $$;
revoke execute on function public.admin_upsert_board(text,text,text,text,text,smallint) from public, anon, authenticated;
grant  execute on function public.admin_upsert_board(text,text,text,text,text,smallint) to authenticated;

-- admin: 상태(보관/활성). 하드삭제 대신 status/access로.
create or replace function public.admin_set_board_status(p_slug text, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_permission('board.manage');
  if p_status not in ('active','disabled') then raise exception 'bad status'; end if;
  update public.boards set status=p_status, updated_at=now(), updated_by=auth.uid() where slug=p_slug;
end $$;
revoke execute on function public.admin_set_board_status(text,text) from public, anon, authenticated;
grant  execute on function public.admin_set_board_status(text,text) to authenticated;
```
(정렬 변경은 admin_upsert_board의 p_sort로 처리 — 별도 reorder RPC는 YAGNI, 후속에서 필요시.)

- [ ] **Step 2: dry-run**
Run: `node scripts/manual/prod-apply-migration.mjs pending/034_board_console.sql`
Expected: dry-run 통과. `--execute`는 소유자.

- [ ] **Step 3: 커밋**
```bash
git add supabase/migrations/pending/034_board_console.sql
git commit -m "feat(board): admin CRUD RPC(board.manage) 추가"
```

### Task 4: 콘솔 클라이언트 lib
**Files:** Create `app/lib/community/adminBoards.js`, `tests/adminBoards.test.mjs`
**Interfaces — Consumes:** Task 3 RPC. **Produces:** `adminListBoards()`, `adminUpsertBoard(board)`, `adminSetBoardStatus(slug,status)`, `validateBoardInput(board)→string|null`.

- [ ] **Step 1: 실패 테스트 — 입력 검증(순수)**
```js
// tests/adminBoards.test.mjs
import { test } from "node:test"; import assert from "node:assert/strict";
import { validateBoardInput } from "../app/lib/community/adminBoards.js";
test("slug 형식", () => {
  assert.equal(validateBoardInput({slug:"anime",name:"애니",icon:"🎬",access:"preview"}), null);
  assert.match(validateBoardInput({slug:"A B",name:"x",icon:"x",access:"preview"}), /슬러그/);
});
test("access 값", () => {
  assert.match(validateBoardInput({slug:"ok",name:"x",icon:"x",access:"bad"}), /공개 범위/);
});
```

- [ ] **Step 2: 실패 확인**
Run: `node --test tests/adminBoards.test.mjs` → FAIL

- [ ] **Step 3: 구현**
```js
// app/lib/community/adminBoards.js
import { supabase } from "../supabase/client";
export function validateBoardInput(b) {
  if (!/^[a-z0-9-]{2,32}$/.test(b.slug || "")) return "슬러그는 영소문자·숫자·하이픈 2~32자예요.";
  if (!b.name?.trim()) return "게시판 이름을 적어주세요.";
  if (!b.icon?.trim()) return "아이콘 이모지를 넣어주세요.";
  if (!["members","preview","hidden"].includes(b.access)) return "공개 범위를 골라주세요.";
  return null;
}
export async function adminListBoards() { return supabase.rpc("admin_list_boards"); }
export async function adminUpsertBoard(b) {
  return supabase.rpc("admin_upsert_board", {
    p_slug:b.slug, p_name:b.name, p_icon:b.icon, p_teaser:b.teaser ?? "",
    p_access:b.access, p_sort:b.sort ?? 100 });
}
export async function adminSetBoardStatus(slug, status) {
  return supabase.rpc("admin_set_board_status", { p_slug:slug, p_status:status });
}
```

- [ ] **Step 4: 통과 확인 + 커밋**
Run: `node --test tests/adminBoards.test.mjs` → PASS
```bash
git add app/lib/community/adminBoards.js tests/adminBoards.test.mjs
git commit -m "feat(board): 콘솔 admin 클라이언트 lib + 입력검증"
```

### Task 5: 콘솔 모듈 UI (`/admin/console/boards`)
**Files:** Modify `app/admin/console/boards/page.js` (Placeholder→실모듈)
**Interfaces — Consumes:** Task 4 lib. 기존 콘솔 모듈(`app/admin/console/members/page.js`)의 레이아웃·권한 게이트·`isNotActivated` 처리 패턴을 그대로 따른다.

- [ ] **Step 1: 모듈 작성** — 목록(카드: 아이콘·이름·slug·access·status·글수 생략) + [새 게시판] + 각 행 [수정][보관/활성 토글]. 폼: slug(신규만 편집)·name·icon·teaser·access(members/preview/hidden 셀렉트)·sort. 저장 시 `validateBoardInput`→`adminUpsertBoard`→목록 새로고침. 에러는 members 모듈과 동일한 안내 스타일. (구체 JSX는 members/page.js 패턴 복제 — 실행자는 그 파일을 열어 동일 구조로 작성.)

- [ ] **Step 2: 로컬 렌더 확인**
Run: preview_start(name) → `/admin/console/boards` 접속(owner 계정) → 목록·폼 렌더, 콘솔 에러 없음.

- [ ] **Step 3: 커밋**
```bash
git add app/admin/console/boards/page.js
git commit -m "feat(board): 콘솔 게시판 관리 모듈(CRUD·상태)"
```

**Phase 1 완료 조건:** 034 적용(소유자) 후, owner가 콘솔에서 새 게시판 생성→`/board`에 즉시 노출, 보관→목록에서 사라짐. 코드 배포로 게시판 추가하던 흐름 종료.

---
## Phase 2 — 옵션 superset (소유자가 번호 고른 것만 활성)
설계 `BOARD_CONSOLE_DESIGN_2026-07-23.md` §2의 옵션 컬럼(B~F)을 **선택된 것만** 추가·배선.
- **2-1 스키마**: 035 마이그레이션으로 선택 옵션 컬럼을 boards에 add(기본 off). `admin_upsert_board`·`list_boards` 반환에 컬럼 추가(반환형 변경 → 함수 drop+recreate, 031 패턴).
- **2-2 콘솔 편집칸**: 콘솔 폼에 옵션별 토글/셀렉트/숫자 추가(접이식 섹션 B~F).
- **2-3 배선(옵션별 1 Task씩)**: 각 옵션이 실제 게시판 화면에 작용하게. 예: `allow_anonymous`→작성자 표기 숨김, `market_mode`→가격 필드+목록 노출, `sr_reward_post`→글 작성 시 SR 적립(§3 SR경제 연동), 광고 옵션→광고 컴포넌트 mount(사업자 후).
- 각 옵션 Task는 [지금]만 즉시, [서버]/[사업자]는 스키마·편집칸까지만(값 저장, 렌더는 인프라 후).
- **착수 트리거:** 소유자가 A~F 번호 선택 → 그 목록으로 이 Phase의 Task들을 확정.

---
## Self-Review
- **Spec 커버리지:** 설계 §3(034 마이그·CRUD·권한)·§4(콘솔 모듈)·§1(테이블 승격=이미 존재하므로 확장으로 대체)·§5(배선)=Phase 2. 옵션 superset=Phase 2(선택 대기). ✔
- **가정 정정:** 설계 §3의 "boards 테이블 승격"은 불필요(이미 존재) → "옵션 컬럼 확장"으로 수정 반영. posts.board FK도 이미 board_id.
- **타입 일관성:** `Board={slug,name,icon,teaser,sort,access}` (list_boards 반환) = boardList/adminBoards 전반 일치. admin RPC 파라미터명 `p_*` 일치.
- **미결(실행자 확인):** Task 2에서 `app/lib/community/boards.js`의 `resolveBoardId`가 테이블 조회인지 확인(맞으면 추가 작업 없음). 콘솔 레이아웃/권한 게이트는 members 모듈 실물 참조.
