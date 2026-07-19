# 운영 절차 (백업 · 환경 전환 · 마이그레이션)

> 갱신: 2026-07-20 (Gate 2)

## 1. 환경 구분

| 환경 | Supabase | 키 위치 |
|---|---|---|
| 로컬 개발 | 기본은 운영을 바라봄 (읽기 위주 개발 시) | `.env.local` |
| 로컬 dev 실험 | snueapp-dev (`uiikgqeoxocpvphlmoqp`) | `.env.dev.local`에 보관 |
| 배포 | 운영 (`jclwkvxbvsegmbcnptpi`) | Vercel → Settings → Environment Variables |

### 로컬을 dev로 전환

1. `.env.local`의 두 값을 잠시 주석 처리(# 붙이기)하고 `.env.dev.local`의 두 줄을 복사해 넣기
2. dev 서버 재시작 (Next가 env 변경을 자동 감지하지만, 확실히 하려면 재시작)
3. 화면 하단 등에서 dev임을 확인하려면: 브라우저 콘솔에서 접속 URL이 `uiikgqeoxocpvphlmoqp`인지 확인
4. **작업 후 반드시 원복** — 원복 잊으면 게시판이 빈 dev 데이터를 보여줘서 바로 티 남

규칙: dev에는 테스트 데이터만. 실제 학생증·증명서 파일 업로드 금지. Vercel(배포)은 이 전환의 영향을 받지 않음(자체 env 사용).

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
