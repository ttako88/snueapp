# 🦌 서울교대 앱 — 작업 재개 안내서

> 멈췄다가 다시 할 때 이 파일을 Claude에게 보여주고 "이어서 하자"고 하면 됨.

## 지금까지 어디까지 했나 (2026-07-18)

**✅ 1~6단계 완료 — 4개 탭 전부 진짜 학교 데이터로 작동!**

- **홈**(`/`): 오늘의 급식 + 다가오는 일정 3개 + 최신 공지 3개 요약
- **급식**(`/meal`): 이번 주 중식 요일별 카드 (오늘 파란 강조, 휴무 처리)
- **학사일정**(`/schedule`): 다가오는 일정 날짜순 카드
- **공지**(`/notices`): 학사공지 목록 → 누르면 상세(본문+첨부파일)

전부 학교 홈페이지에서 로그인 없이 실시간으로 가져옴 (계정·게시판 없음).

**⏭️ 다음: 7단계** — 다듬기 (로딩/에러 표시 개선, 캐싱, 반응형 점검)
그다음 8단계 — Vercel 배포 (조상호님 GitHub/Vercel 계정 필요)

## 만든 파일 구조

```
snue-app/app/
├─ layout.js              앱 전체 틀 (헤더+내용+탭바)
├─ page.js                홈 화면
├─ globals.css            색상/기본 스타일
├─ components/
│  ├─ Header.js           위쪽 바 (새록이+서울교대)
│  ├─ BottomNav.js        아래 탭 4개 (현재 탭 파란불)
│  └─ Placeholder.js      "준비중" 재사용 부품
├─ meal/page.js           급식 화면
├─ schedule/page.js       학사일정 화면
├─ notices/page.js        공지 목록 화면
├─ notices/[nttSn]/page.js  공지 상세 화면
└─ api/                   ← "중계소" (서버가 학교에 대신 요청)
   ├─ schedule/route.js   학사일정 (JSON)
   ├─ meal/route.js       급식 (HTML→cheerio 파싱)
   ├─ notices/route.js    공지 목록 (HTML 파싱)
   └─ notices/[nttSn]/route.js  공지 상세 (HTML 파싱)
```

## 재개할 때 (개발 서버 켜기)

터미널에서:
```
cd C:\Users\조상호\Desktop\클로드\snue-app
npm run dev
```
브라우저에서 `localhost:3000` 열기.
- node 안 잡히면: PATH에 `C:\Program Files\nodejs` 추가 (또는 새 터미널)
- ⚠️ 서버가 이상하면(컴파일 워커 에러 등): node 프로세스 전부 종료
  (`taskkill //F //IM node.exe`) 후 `.next` 폴더 지우고 다시 `npm run dev`.
  ← 좀비 서버 여러 개 겹치면 이 증상 나옴. 항상 서버는 1개만.

## 확정된 방향 (바뀌면 안 되는 것)

- **범위**: 급식·학사일정·공지만 (로그인·계정·게시판 없음). 이게 v1.
- **플랫폼**: 반응형 웹 먼저 (앱은 나중)
- **비주얼**: 새록이 + SNUE 블루(#0095DA). 폰 너비(480px) 가운데 정렬 앱 스타일.
- **작업 방식**: 한 단계씩, Claude가 만들고 원리 설명 → 조상호님이 localhost:3000으로 확인

## 색상

SNUE 블루 `#0095DA` / 새록이 스카이블루 `#A2D3F4` / 네이비 `#0C4470`(기본 글자) / 배경연하늘 `#EAF6FD` / 포인트핑크 `#FF97C5`

## 참고

- 전체 리서치·데이터소스: `C:\Users\조상호\Desktop\클로드\design.md` (22개 섹션)
- ⚠️ 이 Next.js는 16.2 최신버전이라 옛 방식과 다를 수 있음 (`app/AGENTS.md` 참고)
