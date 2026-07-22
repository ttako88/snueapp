# AI 모델 레지스트리 · 모델별 SR 가격 · SR 경제 설계 (2026-07-23, 소유자 지시)

> 소유자: "AI 선택 토글(무한확장). 신모델 나오면 교체·추가 쉽게. API마다 가격 다르게 →
> 내가 API별 가격 책정하는 칸 + 이용자한테 '클로드는 400SR, 제미나이는 300SR' 보여줄 방법(메뉴판)."
> + "SR 경제(버는 곳/쓰는 곳/UI)는 별도로 합리적으로 설계."

## 지금 상태 (실측)
- provider.mjs: 모델별 어댑터 이미 있음 — gemini·claude·gpt 프리픽스로 분기. **API 키 있으면 자동 활성**.
- budget.mjs MODELS: gemini-flash/flash-lite/pro·claude-haiku-4-5·gpt-5-mini (in/out 토큰 원가 KRW). 지금은 GEMINI_API_KEY만 등록 → 제미나이만 활성.
- 023 ai_price_config: purpose(약안/세안) → cost_sr. **모델 구분 없음** (약안 10 / 세안 25 SR). aiCreditCharge flag OFF(휴면).
- 지도안 라우트: funding_source(owner→이용권→SR). SR 경로는 flag ON 시 동작.

## A. AI 모델 레지스트리 (무한확장)
**모델 = 코드 레지스트리(정적 메타) + DB 가격(운영자 편집)** 2층으로.
- 코드(budget.mjs 확장): `{ id, label(사용자표기), provider, blurb(한줄소개), badge('빠름'|'고품질'|'프리미엄'), order, adapter키 }`. 신모델 = 이 표에 한 줄 + provider.mjs 어댑터(있으면) + API 키.
- 활성 조건: (API 키 존재) AND (DB에서 enabled). 키 빠지면 자동 숨김(현행 availableProviders 유지).
- **신모델 교체**: label/blurb/badge/order를 바꾸거나 새 id 추가 → 무한확장. 기존 id 유지하며 default만 바꿔도 됨.

## B. 모델별 SR 가격 (운영자 책정)
- 신규 테이블 `private.ai_model_pricing(model_id, purpose, sr_cost, enabled, updated_by, updated_at, PK(model_id,purpose))`.
  - 023 ai_price_config(purpose→cost)를 대체/보완. 라우트가 (선택모델 × 약안/세안) → sr_cost 로 차감.
- 운영자 콘솔 "AI·가격" 모듈: 모델 목록 + 각 모델의 약안/세안 SR 입력칸 + enabled 토글. (owner: flag.manage 또는 신규 pricing 권한)
- 라우트 변경: 요청 body에 model 받음(허용목록 검증) → 그 모델의 sr_cost 로 charge → 그 모델로 generate.

## C. 이용자 메뉴판 (모델 선택 + 가격 표시)
- 지도안 화면에 **모델 선택 카드/드롭다운**:
  - 각 카드: `label · badge · "약안 300 SR / 세안 400 SR"` + blurb.
  - 예: "Gemini 3.6 Flash · 빠름 · 약안 100 / 세안 300 SR" / "Claude Haiku · 고품질 · 약안 150 / 세안 400 SR".
  - 내 SR 잔액과 함께 표시 → 부족하면 비활성+안내("SR이 모자라요. 강의평 쓰고 충전!").
- 선택한 모델 → 생성 요청에 실려 감. 차감량이 모델마다 다른 건 **카드에 SR 숫자로** 직접 보여주는 게 가장 명확(토글보다 카드 메뉴판).

## D. SR 경제 (버는 곳/쓰는 곳/UI) — 별도 phase
- **버는 곳**(적립원천): 강의평가 작성·실습후기·자료 등록·Google Rewarded Ads 시청·가입/출석 보너스. 각 +N SR (022 ticket_ledger 원장, reason별).
- **쓰는 곳**: 지도안 생성(모델별, 위 B)·자료 열람(해피캠퍼스식). SR = 현금화·양도 불가.
- **UI**: 잔액·거래내역(내역 페이지) + 각 소비지점에 가격 표시 + 충전 유도.
- durable 상태기계(023 토대): CHARGED→GENERATING→CONSUMED/REFUNDED. timeout 시 영구차감 방지.
- 활성화 전: 적립원천 최소 1개(강의평) + 잔액/내역 UI + 모델가격 세팅. 그 전엔 이용권(028)이 지인 경로.

## 빌드 순서(제안)
1. **레지스트리 확장**(budget.mjs 메타 + availableModels 리스트 RPC/헬퍼) — 근거 놓기.
2. **ai_model_pricing 테이블 + 운영자 가격 콘솔**(owner) — 가격 책정 칸.
3. **이용자 모델 메뉴판**(지도안 화면, 잔액 연동) — 단, SR charge는 flag ON 후 실동작.
4. **SR 적립원천 1개(강의평)** + 잔액/내역 UI → aiCreditCharge ON → 공개 경제 가동.
5. 신모델/신 API는 1의 레지스트리에 추가만.

## 안전·주의
- 모델 허용목록은 **서버가 최종 검증**(클라가 임의 model 문자열로 비싼 모델 우회 못 하게).
- 가격은 DB(운영자 편집) — 코드 재배포 없이 조정. 단 음수·0 방지 CHECK.
- API 키는 소유자만 env 등록(제미나이 외 GPT/Claude 키 미등록 시 자동 비활성).
- SR은 현금화·양도 불가 유지(환금성 리스크 회피).
