# 지도안 생성 분석 시트 — 설계 (2026-07-23, 소유자 지시)

소유자: 콘솔에 지도안 생성 내역·효용성 분석. 실행별 상세 + 일일 집계 + 재사용(효용) 신호.

## 이미 잡히는 데이터 (재활용 — 중복 저장 안 함)
- 라우트(`app/api/lesson-plan/route.js`)가 실행마다: 모델·토큰·**API비용(costKrw)**·**SR사용액**·이용권 소비·member·**planType(약안/세안)**·시각을 각 ledger(ai budget / entitlement_ledger 028 / SR 023)에 기록.
- **없는 것**: 학년·교과서(출판사/ID)·목차(단원/차시)는 **요청 body에만 있고 저장 안 됨**. 약안→세안 체인, 내보내기(docx/hwp/pdf), 재사용률도 미기록.

## 신규 테이블 `private.lesson_plan_runs` (실행 1건 = 1행)
```
id             uuid pk default gen_random_uuid()
member_id      uuid  not null            -- 누가
plan_type      text  not null            -- 'brief'(약안) | 'full'(세안)
grade          int                       -- 학년
subject        text                      -- 교과
unit           text                      -- 단원명(선택 입력이라 null 가능)
textbook_id    text                      -- 교과서ID(출판사 식별)
publisher      text                      -- 출판사(textbook_id에서 도출 저장)
model          text  not null            -- 사용 모델 id
funding_source text  not null            -- 'owner' | 'entitlement' | 'paid'
cost_krw       int   not null default 0  -- 이 실행 API 원가(정산액 denormalize)
sr_spent       int   not null default 0  -- 이 실행 SR 차감(0=owner/이용권)
chained_from   uuid  references private.lesson_plan_runs(id)  -- 약안→이어 뽑은 세안이면 그 약안 run
created_at     timestamptz not null default now()
-- 내보내기(사후 업데이트, 클라 보고)
exported_docx_at timestamptz
exported_hwp_at  timestamptz
exported_pdf_at  timestamptz
```
- **로깅 시점**: 라우트가 생성 성공·정산 직후 `svc_log_lesson_run(...)` 호출(service_role). 비용/SR은 정산 결과를 그대로 넣음(이중 출처 방지 위해 ledger가 원본, 이건 분석용 스냅샷).
- **chained_from(약안→세안 체인)**: 세안 생성 시, 같은 member+동일 unit(+textbook)의 **가장 최근 약안 run**을 찾아 링크. 클라가 약안 run_id를 들고 있다가 세안 요청에 실어 보내는 방식이 가장 정확(권장) — 라우트가 그 id 검증 후 저장.

## 내보내기 기록 (클라 → 서버 보고)
- 내보내기는 클라이언트에서 일어남 → 작은 엔드포인트 `POST /api/lesson-plan/export-log { runId, format }` 신설. `svc_mark_lesson_export(run_id, format)`로 해당 컬럼 timestamp 갱신.
- PDF: 현재 미구현(브라우저 인쇄→PDF만). 내보내기 버튼에 PDF 추가 시 함께 보고. (docx는 방금 배포됨 → 저장 시 보고 추가.)

## 콘솔 뷰 `/admin/console/analytics` 내 "지도안 생성 분석" 섹션 (권한: analytics 계열)
집계 RPC(전부 `require_permission`), 아래를 카드/표로:
1. **오늘(KST)**: 생성수 **약안/세안 별도 카운트** · 이용 인원(distinct member) · 총 API비용(₩) · 총 SR 사용액. (일자 선택/최근 N일 추이)
2. **실행 내역 표**(최근순, 필터: 기간·교과·학년·plan_type·funding): 시각·닉네임·약/세·학년·교과·교과서·단원·모델·₩·SR·내보내기(docx/hwp/pdf 아이콘).
3. **효용 지표(파생)**:
   - **약안→세안 업그레이드율** = (약안 뽑은 뒤 같은 단원 세안까지 간 member 수) ÷ (약안 뽑은 member 수) %. chained_from 기반.
   - **재사용(단골) 분포**: member별 총 실행수 버킷 — 1회(이탈 신호)·2~4회·5회+. "1회 쓰고 다시 안 씀" 비율을 **생성기 효용 부족 신호**로 강조 표시.
   - **내보내기 전환율** = 내보내기(docx/hwp/pdf 아무거나) 있은 run ÷ 전체 run %. (뽑고 실제로 파일까지 = 실사용 신호)
4. **모델별**: 실행수·평균 ₩·평균 SR(2단계 AI 모델콘솔과 연동).

## 확정 필요 (내 기본안 — 다르면 알려주세요)
1. **"재구매/단골" 정의**: 기본안 = **member별 누적 실행수 버킷(1 / 2~4 / 5+)** + **최근 30일 재실행 여부**. (구독/결제 아니라 "재사용"이 재구매 대용.) 이대로?
2. **약안→세안 체인 방식**: 기본안 = **클라가 약안 run_id 보관 → 세안 요청에 실어 보냄**(가장 정확). 대안(서버가 member+unit로 추정)은 부정확. 클라 방식으로?
3. **소급 없음**: 이 기능 배포 전 생성분은 로그 없음(새로 쌓임). OK?
4. **PII**: member_id(내부 uuid)만. 표에는 닉네임 표시(콘솔 회원 규약과 동일). 학번·실명·이메일 없음. OK?

## 구현 순서 (확정 후)
1. 마이그 03x: `lesson_plan_runs` 테이블 + `svc_log_lesson_run` + `svc_mark_lesson_export` + 집계 RPC(`admin_lesson_analytics_overview`, `admin_lesson_runs_list`). (소유자 cmd 적용)
2. 라우트: 정산 직후 run 로깅 + chained_from 수신. 응답에 run_id 반환.
3. 클라: 내보내기 시 export-log 보고. 약안 run_id 보관→세안에 전달.
4. 콘솔: "지도안 생성 분석" 섹션(카드+표+파생지표).
- 마이그레이션 번호는 게시판(034)·AI콘솔과 겹치지 않게 배정(선착 034, 이건 035/036).
```
