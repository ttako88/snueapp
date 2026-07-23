# 지도안 HWP 내보내기 — 방법 연구 (2026-07-23)

소유자 지시: 생성한 약안/세안을 **HWP(한글)로 내보내기**. 교사들이 지도안을 hwp로 제출하니 실사용 가치 큼.

## 제약 (우리 환경)
- 앱 = Next.js/Vercel **serverless**. **한컴오피스 설치·Windows COM 자동화 불가**(pyhwpx·hwpapi 류는 배제).
- 따라서 **순수 코드로 파일을 생성**해야 함. 다행히 **HWPX는 개방형 포맷**이라 가능.

## 포맷 선택: HWP(바이너리) vs HWPX vs 대안
- **HWP(.hwp)** = 옛 바이너리(CFBF). 생성 라이브러리 빈약·불안정 → 비권장.
- **HWPX(.hwpx)** = 한글 2014+ 기본 개방형 포맷(OWPML, ZIP+XML). **한글에서 .hwp와 똑같이 열림**. ZIP+XML이라 **서버에서 순수 코드로 생성 가능**. → **목표 포맷.**
- **DOCX** = 한글이 무리 없이 열고 → "다른 이름으로 저장 > hwp" 가능. 생성 라이브러리 성숙(`docx` npm, 순수 Node). → **즉시 가능한 임시 경로.**

## 라이브러리 지형 (2026-07 실측)
- **JS/Node**: `node-hwp`·`openhwp` = 대부분 **읽기 전용**, 생성 미성숙. → Node 단독 HWPX 생성은 **직접 템플릿 방식**이 현실적.
- **Python**: **`python-hwpx`**(airmang) = 한컴 없이 HWPX 읽기·편집·생성·검증(크로스플랫폼). `mail_merge`(템플릿 대량생성)·`fill_hwpx`(라벨-값 서식 채우기, "강사 카드/신청서" 예시 = 지도안 서식과 동형)·XSD 검증. **`hwpx-skill`**(jkf87) = **마크다운/텍스트→HWPX 자동 생성**(우리 AI 출력이 마크다운이라 적합).
- `docx`(npm) = DOCX 순수 Node 생성, 안정적.

## 우리 데이터와의 접점
- 현재 생성기 출력 = **마크다운**(섹션 + 본시학습 **표**). `lessonPrompt.mjs` STRUCTURE가 표를 마크다운 표로 지정.
- HWPX 서식을 **깔끔히** 채우려면 마크다운 blob보다 **구조화 출력(JSON: 섹션 + 표 rows)**이 유리 → 프롬프트/라우트가 구조화 필드도 내보내게 하면 서식 채우기가 정확해짐.

## 권장 경로 (2단계)
**1단계 — 즉시(임시): DOCX 내보내기**
- `docx`(npm)로 서버에서 .docx 생성 → 다운로드. 교사가 한글로 열어 hwp 저장 가능.
- 장점: 순수 Node·Vercel에서 오늘 당장 가능·무인프라. 단점: 네이티브 hwp 아님(한 단계 저장 필요).

**2단계 — 목표: HWPX 네이티브 내보내기**
- 방식 A (**Node 단독, 권장**): **약안/세안 HWPX 서식(.hwpx)을 미리 제작** → 앱에서 unzip → `section0.xml`에 내용 주입(문단·본시학습 표 셀) → rezip. 라이브러리: `jszip`/`adm-zip` + XML 문자열/파서. **스택 단일(Node) 유지·Python 런타임 불필요.**
- 방식 B (**python-hwpx, 기능 풍부**): Vercel **Python 서버리스 함수**(또는 별도 마이크로서비스)에서 `python-hwpx`로 `mail_merge`/`fill_hwpx` + XSD 검증. 장점: 서식 채우기·검증 성숙. 단점: **Python 런타임/서비스 추가**(스택 이중화).
- 공통 인에이블러: 생성기가 **구조화 출력**(JSON 섹션 + 표 rows)도 반환하게 → 서식 필드에 정밀 매핑.

## 결정 제안
- **지금**: DOCX 내보내기 버튼부터(빠른 실사용 가치). 
- **그다음**: HWPX **방식 A(Node 서식 템플릿)** — 스택 단일 유지가 운영상 유리. 서식 품질/검증이 부족하면 **방식 B(python-hwpx)**로 승급.
- 선행: 약안·세안 **HWPX 서식 1벌씩** 제작(한글에서 손으로 만들어 .hwpx 저장 → 그걸 템플릿으로) + 생성기 구조화 출력.

## 리스크·주의
- 저작권/서식: 표준 지도안 서식은 공개 양식 사용(특정 출판사 서식 복제 금지).
- HWPX XML은 네임스페이스·표 구조가 장황 → 방식 A는 **미리 만든 서식에 값만 주입**(XML을 처음부터 짜지 말 것)으로 안정화.
- 폰트/장평 등 세부는 한글에서 열었을 때 검증 필요(로컬 왕복).

## 출처
- python-hwpx (PyPI / GitHub airmang/python-hwpx)
- hwpx-skill (GitHub jkf87/hwpx-skill — 마크다운→HWPX), hwpx-skill(airmang)
- hancom-io/hwpx-owpml-model (OWPML 공식 모델)
- node-hwp(123jimin), openhwp — 읽기 전용 참고
- docx (npm) — DOCX 생성
