# 게시판 관리 콘솔 설계 (2026-07-23, 소유자 지시)

> 소유자: "새 게시판 아이디어 생길 때마다 부탁하기 번거롭다. 콘솔에서 **생성·삭제**하고,
> 게시판마다 **옵션**(익명·광고배너·인피드광고·게시판별 광고 타게팅·사진/GIF·장터 가격노출 등)을
> 최대한 많이 패키징해서 미리 달아둬라. 브레인스토밍한 **전체 옵션을 다 살려서** 설계로 남기고,
> 실제 켤 것은 나중에 번호로 고르겠다."
>
> **상태: 옵션 메뉴 확정 대기.** 이 문서는 전체 옵션의 superset 설계다. 소유자가 번호로
> 고르면 그 범위로 writing-plans → 구현. 스키마는 전부 담되 **각 옵션 기본값 = off/안전**이라
> 새 게시판은 지금 게시판과 동일하게 동작한다(고른 것만 켜짐).

---
## 0. 현재 상태 (실측)
- 게시판은 **이중 하드코딩**: `app/lib/boards.js` 배열(표시용 9개) + DB `posts.board` CHECK 제약(002_foundation.sql). 추가하려면 양쪽 고치고 재배포.
- 감사보고서 R8: "Gate 4a 에서 boards 테이블로 일원화 예정" — **이 설계가 그 일원화**.
- 028 `role_permissions`/`require_permission` 있음 → `board.manage` 권한으로 게이트.
- 현재 9개: free·secret·practicum·promo·club·teacher-exam·market·alumni·dorm.

## 1. 아키텍처
**2층 구조**: `public.boards` 테이블(정의·옵션 단일 출처) + 콘솔 편집 UI + 렌더링 배선.
- `boards.js` 하드코딩 배열 → 테이블 조회로 대체(서버 컴포넌트/RPC). 배열은 시드+폴백으로만 잔존.
- `posts.board` CHECK → `boards.slug` 참조로 전환(신규 슬러그가 자동 허용되게).
- 옵션은 **컬럼 superset**. 새 게시판 = 콘솔에서 한 줄. 새 옵션 = 컬럼 하나 + 편집칸 + 배선 한 곳.

### 노출 경계
- boards 행은 **공개 읽기 OK**(목록·아이콘·옵션이 클라 렌더를 구동). 광고 유닛ID도 원래 클라에 노출되는 값이라 무방.
- **민감 비밀(광고 API 시크릿·제휴 키)은 boards 테이블에 두지 않는다** — §3 AI 키관리와 같은 `provider_keys`식 암호화 저장을 재사용하고, boards 는 "어떤 슬롯/카테고리"만 참조.
- **쓰기 = `board.manage` 권한(owner/staff)**. 생성·수정·숨김·순서·옵션 편집 전부.

## 2. `public.boards` 스키마 (옵션 superset — 전체 살림)
```
public.boards
  slug          text primary key         -- 불변 식별자 ^[a-z0-9-]{2,32}$
  name          text not null            -- 제목
  teaser        text                     -- 설명(대표 성격 안내, 주제 한정 아님)
  icon          text                     -- 이모지
  sort_order    int  not null default 100
  status        text not null default 'active'   -- active|hidden|disabled
  created_by    uuid, created_at, updated_at

  -- B. 정체성·표시
  theme_color        text                     -- B1 대표색(널=기본)
  default_sort       text default 'recent'    -- B2 recent|popular
  use_tags           bool default false       -- B3 말머리 사용
  tags               text[]                   -- B3 말머리 목록 예:{정보,질문,후기}
  allow_pinned_notice bool default true       -- B4 공지 상단고정 허용(012)
  show_thumbnail     bool default false       -- B5 목록 썸네일

  -- C. 참여·권한
  allow_anonymous    bool default false       -- C1 익명 허용(비밀게시판식)
  write_role         text default 'member'    -- C2 everyone|member|verified|staff
  read_public        bool default true        -- C3 비로그인 읽기 허용
  allow_comments     bool default true        -- C4
  allow_votes        bool default true        -- C5 추천·비추천
  allow_reports      bool default true        -- C6 신고
  min_account_age_days int default 0          -- C7 가입 N일 후 글쓰기

  -- D. 콘텐츠 타입
  allow_image        bool default false       -- D1 [서버] 사진(스토리지 필요)
  allow_gif          bool default false       -- D2 [서버]
  allow_file         bool default false       -- D3 [서버]
  market_mode        bool default false       -- D4 장터: 가격필드+목록 제목·가격 노출+판매상태
  require_title      bool default true        -- D5
  max_body_chars     int                      -- D5 널=무제한
  allow_link_preview bool default false       -- D6

  -- E. 광고·수익화 (게시판별 타게팅)
  ad_banner          bool default false       -- E1 [사업자] 상단 배너
  ad_infeed          bool default false       -- E2 [사업자] 인피드 광고
  ad_infeed_interval int default 0            -- E2 N번째 글마다
  ad_category        text                     -- E3 애니→figure/game, 영화→movie ...
  ad_unit_id         text                     -- E4 게시판별 광고 유닛(제휴는 provider_keys 참조)
  allow_sponsor_pinned bool default false     -- E5 스폰서 고정글(sponsors 모듈)
  sr_reward_post     int default 0            -- E6 글 작성 +SR
  sr_reward_comment  int default 0            -- E6 댓글 +SR

  -- F. 운영·모더레이션
  auto_hide_reports  int default 0            -- F1 N회 신고시 자동숨김(0=off)
  write_cooldown_sec int default 0            -- F2 도배방지 쿨다운
  daily_post_limit   int default 0            -- F3 0=무제한
  banned_words       text[]                   -- F4 금지어
```
CHECK: enum 컬럼 값 제한, `*_interval/*_limit/age/reward >= 0`, `write_role in (...)`, `status in (...)`.
시드: 현재 9개 게시판을 기본값으로 INSERT(=지금 동작 그대로).

## 3. 마이그레이션 (034, dual-definition 해소)
1. `public.boards` 생성 + 9개 시드.
2. `posts.board` **CHECK 제거 → FK(`boards.slug`)** 또는 트리거 검증. 기존 글 슬러그가 시드에 다 있으니 무결성 통과.
3. RPC:
   - `list_boards()`(anon, status<>'disabled'만, order순) — 목록·렌더용.
   - `admin_list_boards()` / `admin_upsert_board(...)` / `admin_set_board_status(slug,status)` / `admin_reorder_boards(...)` — 전부 `require_permission('board.manage')`.
   - upsert 는 slug 불변·enum·음수 CHECK 서버 재검증.
4. `role_permissions` 에 `board.manage` 키 추가(owner·staff).
5. `app/lib/boards.js`: 배열 → `list_boards()` 결과(캐시). 배열은 폴백 상수로만.

## 4. 콘솔 모듈 `/admin/console/boards`
- **목록**: 게시판 카드(아이콘·이름·status·글수) + 순서 드래그 + [새 게시판] 버튼.
- **생성/수정 폼**: 섹션 접이식 — 기본(slug·name·teaser·icon) / B 표시 / C 참여 / D 콘텐츠 / E 광고 / F 모더레이션. 각 옵션 = 토글·셀렉트·숫자칸. `[서버]/[사업자]` 옵션엔 회색 "인프라 준비 후" 힌트(값은 저장되지만 렌더 배선은 해당 단계에서).
- **삭제**: 하드삭제 대신 **status='hidden'(보관, 글 보존)**. 하드삭제는 owner+빈 게시판만.
- 권한: `board.manage`. 감사로그(028 audit) 기록.

## 5. 렌더링 배선 (옵션→화면, 단계적 가능)
스키마가 전부 담으므로 배선은 옵션별 독립·점진. 미배선 옵션은 기본 off라 무해.
- C1 익명 → 작성자 표기 숨김(secret 게시판 로직 재사용). C2/C3 → 글쓰기/읽기 게이트. C4~C6 → 버튼 노출. C7 → 작성 가드.
- D4 장터 → 작성폼 가격 필드 + 목록 `제목·가격·판매상태`. D5 → 폼 검증. D1~D3 → 스토리지 도입 시.
- E1/E2 → 광고 컴포넌트 mount(사업자·광고계정 후). E3/E4 → 광고 요청에 category/unit 실어보냄. E5 → sponsors. E6 → SR 적립(§3 SR경제, ticket_ledger reason).
- F1~F4 → 신고 처리·작성 가드.

## 6. 구현 단계(제안 — 소유자 번호 선택 후 확정)
1. **034 마이그레이션 + list_boards + boards.js 전환** (토대, 지금 동작 보존).
2. **콘솔 boards 모듈 CRUD + status/순서** (A 전부).
3. **[지금] 옵션 배선** — C·D4·D5·B·F 중 고른 것.
4. **광고 옵션(E)** — 스키마·입력칸은 2에서 이미 저장, 렌더는 사업자·광고계정 후 값만.
5. **[서버] 옵션(D1~D3)** — 스토리지 도입 시.
- 각 단계 독립 커밋·flag/배포 분리. 어디서 멈춰도 깨끗.

---
## 부록. 그 외 콘솔화 후보 (G — 나중에 함께 고를 것)
- **G1** flag 관리(courseReview·aiCreditCharge 등 콘솔 on/off).
- **G2** 공지·배너 관리 + **지도안 PR 배너 문구 편집**(LessonPlanIntro 하드코딩→편집형).
- **G3** 모더레이션 큐(신고글 일괄 숨김/복구·유저 제재, 013/014).
- **G4** 버그·문의 접수함(014 bug_report).
- **G5** 광고/스폰서 중앙관리(광고 유닛·스폰서 슬롯·게시판 타게팅, E와 짝).
- **G6** 강의평가/학교후기 관리(승인·숨김·과목 마스터, §3 SR 적립원천).
- **G7** 실습학교 데이터 관리(catalog CSV 업로드/편집, #0 실습도우미 토대).
- **G8** 약관·개인정보 버전 관리(재동의 유도).

## 참고
- §3 AI·SR: `docs/AI_MODELS_AND_SR_ECONOMY_DESIGN.md`(광고/SR 적립·키관리 안전설계와 연동).
- 콘솔·권한: `docs/ADMIN_CONSOLE_2026-07-23.md`, 028 role_permissions.
- 야간 작업지시서: `docs/WORKORDER_2026-07-23_NIGHT.md`.
