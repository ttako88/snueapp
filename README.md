# 서울교대 새록이 (snueapp)

서울교육대학교 학생을 위한 비공식 캠퍼스 앱. 마스코트 새록이와 함께 🦌

**배포**: https://snueapp.vercel.app

## 기능

**정보 (로그인 불필요)**
- 오늘의 급식 · 학사일정 · 학사공지 (학교 공개 데이터를 서버에서 파싱)
- 개인 시간표 (학년·심화과정 자동 채움, 학기별 저장) · 시간표 마법사 (교양/재이수 조합 생성)
- 학점 계산기 · e-Class 일정 연동(iCal) · 통합 캘린더

**커뮤니티 (개발 중 — [로드맵](docs/ARCHITECTURE_AUDIT_PHASE1.md))**
- 이메일 로그인, 게시판 9종, 글/댓글/익명 작성
- 학생 인증·역할·신고 체계는 Gate 3~7에서 구축 예정

## 기술

Next.js 16 (App Router) · React 19 · Tailwind 4 · Supabase (Auth/Postgres/RLS) · Vercel

## 개발

```bash
npm install
npm run dev     # localhost:3000
npm test        # node --test (마법사 엔진 등)
npm run build
```

환경변수는 [.env.example](.env.example) 참고. 실제 값은 `.env.local`(로컬)과 Vercel 환경변수(배포)에.

## 문서

| 문서 | 내용 |
|---|---|
| [docs/CURRENT_STATE.md](docs/CURRENT_STATE.md) | **현재 상태 요약 — AI 협업 세션은 여기부터** |
| [docs/ARCHITECTURE_AUDIT_PHASE1.md](docs/ARCHITECTURE_AUDIT_PHASE1.md) | 커뮤니티 전환 아키텍처 기준 문서 (Gate 1 승인본) |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 백업·env 전환·마이그레이션 절차 |
| `docs/archive/` | 역사 기록 (현재와 다를 수 있음) |

## 주의

- `supabase/schema.sql`은 초기 설치 전용 — **운영 DB에 재실행 금지** (데이터 전체 삭제됨)
- 운영 DB 변경은 `supabase/migrations/`의 번호 붙은 증분 파일로만
- 학교 데이터 크롤링은 캐시로 요청을 최소화하고 있음 (요청 예의)

비공식 개인 프로젝트이며 서울교육대학교 공식 서비스가 아닙니다.
