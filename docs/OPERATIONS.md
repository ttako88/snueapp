# 운영 절차 (백업 · 환경 전환 · 마이그레이션)

> 갱신: 2026-07-20 (Gate 2)

## ⚡ 빠른 명령 (자동화 — 컴팩 후에도 이걸 먼저 확인, 수동 반복 금지!)
> 전제: 시크릿은 `.env.prod.local`(프로젝트 루트 `snue-app/.env.prod.local`, gitignore)에 있음.
- **프로덕션 배포**: `node scripts/manual/deploy.mjs`
  - `.env.prod.local` 에 `VERCEL_DEPLOY_HOOK_URL=...` 1회 등록 필요(Vercel > Settings > Git > Deploy Hooks). URL은 화면에 안 뜸.
  - Claude가 이 스크립트로 직접 배포 가능(브라우저 훅 왕복 불필요).
- **pending 마이그레이션 전부 적용**: `node scripts/manual/apply-pending.mjs --execute` (미리보기는 `--execute` 없이)
  - ⚠️ 하네스가 Claude의 운영 DB 쓰기를 차단 → **이 cmd는 소유자가 실행.** Claude는 dry·검증만.
  - 적용 후 해당 파일을 `pending/` → `migrations/` 로 **git mv** (안 옮기면 재적용 충돌).
  - 헛FAIL('anon EXECUTE'·'객체 안 늘었다')은 정상.
- 배포/적용 성공 여부는 Claude가 읽기 프로브로 실측(예: `scripts/manual/probe-pending-applied.mjs`).

## 1. 환경 구분 (P0-9 개정: 로컬·Preview 기본 = dev)

| 환경 | Supabase | 키 위치 |
|---|---|---|
| **로컬 개발 (기본)** | **snueapp-dev (`uiikgqeoxocpvphlmoqp`)** | `.env.local` |
| Vercel Preview | snueapp-dev (dev 키만 등록 — prod secret 등록 금지) | Vercel → Preview env |
| Vercel Production | 운영 (`jclwkvxbvsegmbcnptpi`) | Vercel → Production env |

> **왜 바꿨나 (2026-07-20, GPT 런북 P0-9)**: 이제 앱에 쓰기 기능·service 작업이 있어,
> 로컬 기본이 운영 DB를 바라보면 실수 한 번이 운영 데이터를 오염시킬 수 있다.
> **운영 연결은 기본값이 아니라 예외(break-glass)다.**

### 운영 DB에 로컬로 연결해야 할 때 (break-glass 절차)

일상 개발에서는 금지. 운영 장애 조사 등 명확한 사유가 있을 때만:

1. 사유·시각을 기록하고 (커밋 메시지나 작업 로그)
2. `.env.local`의 dev 값을 주석 처리하고 운영 값을 임시로 넣은 뒤
3. **읽기 전용 작업만** 수행하고
4. 작업 즉시 dev 값으로 원복 (원복 확인: 브라우저 콘솔 접속 URL이 `uiikgqeoxocpvphlmoqp`인지)

규칙: dev에는 테스트 데이터만. 실제 학생증·증명서 파일 업로드 금지. Vercel(배포)은 로컬 전환의 영향을 받지 않음(자체 env 사용).

## 2. 백업 (마이그레이션 실행 전 필수)

무료 플랜은 자동 백업이 없다. 운영 DB에 마이그레이션을 적용하기 전:

1. **데이터 덤프**: Supabase 대시보드 → Database → 또는 로컬에서
   `npx supabase db dump --db-url "postgresql://...운영 연결문자열..." -f backup_YYYYMMDD.sql`
   (연결문자열은 대시보드 Connect 버튼에서. 비밀번호 포함이므로 파일·채팅에 남기지 말 것)
2. **Storage**: 인증자료 버킷이 생기면(Gate 5+) 대시보드에서 다운로드 또는 CLI 동기화
3. 백업 파일은 저장소 밖 안전한 위치에 (git 커밋 금지)
4. 유저가 실제로 생기면 Pro 플랜(자동 일일백업) 전환 검토

## 3. 마이그레이션 체크리스트

1. `supabase/migrations/00N_이름.sql` 작성 — 파일 머리에 목적·기대 결과·검증 쿼리·실패 시 대응 주석
2. **dev에 먼저 적용** → 검증 쿼리 실행 → 앱 스모크
3. 운영 백업 (위 2절)
4. 운영 SQL Editor에 적용 (파괴 경고가 뜨면 정말 의도한 것인지 재확인)
5. 검증 쿼리 → 배포 앱 스모크
6. 문제 시: 백업 복원이 최후 수단이므로, 애초에 **비파괴(추가형) 마이그레이션만** 작성할 것

파괴적 변경(drop/truncate/타입 변경)은 Gate 4a의 승인된 초기화 외에는 금지.
클립보드로 SQL을 옮길 때는 PowerShell `Set-Clipboard`(UTF-8) 사용 — `clip.exe`는 한글이 깨짐.

## 4. 키 관리

- publishable(sb_publishable_): 공개 가능. NEXT_PUBLIC_ env로 사용
- secret(sb_secret_)·DB 비밀번호·향후 OAuth client secret: **서버 전용**. 채팅·보고서·스크린샷·git·NEXT_PUBLIC 금지. Vercel에선 Sensitive 체크
- 유출 의심 시: Supabase 대시보드에서 즉시 재발급(rotate) 후 env 교체
