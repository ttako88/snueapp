# 학생 인증 파이프라인 — 구성과 남은 준비물

작성 2026-07-21. 설계 근거는 `GATE3_DESIGN.md` §4.1~§4.3.

## 흐름

```
사용자 (/settings/verification)
  │  이름·학번·서류종류·파일
  ▼
POST /api/verification/begin            [service_role]
  · 학번 정규화(8자리) → 보존 중인 전 키버전으로 HMAC 계산 → 원문 폐기
  · staging 경로를 **INSERT 전에** 확정: staging/{uid}/{random}
  · begin_verification RPC → request 생성 (uploading, 경로 포함) ← 쓰기 1회
  · staging 전용 signed upload URL 반환 (5분)
  │
  ▼  supabase.storage.uploadToSignedUrl   (staging 에만 쓸 수 있다)
  │
POST /api/verification/finalize         [service_role]
  · staging 객체를 내려받아 재검증
      존재 · 소유 prefix · 1~10MB · magic bytes (JPEG/PNG/WebP/PDF만)
  · 검증 통과분을 verified/{request_id}/document 로 **서버가 복사**
      (Content-Type 은 서버 판정값으로 기록)
  · storage_path 를 verified 로 조건부 확정 → staging 삭제
  · 그 뒤에만 finalize_verification RPC → submitted 전이
  │
  ▼
심사 콘솔 (/admin/verification)
  · POST /api/verification/document
      verified 경로만 허용 → 60초 signed URL 생성
      → audit_logs 기록 성공 후에만 URL 반환 (fail-closed)
  · review_verification RPC 로 승인·반려
```

**불변조건 둘**

1. 파일이 서버 검증을 통과하기 전에는 어떤 경로로도 `submitted` 가 되지 않는다.
   signed URL 만 받고 업로드하지 않아 7일 삭제 시계를 동결시키는 악용을 막기
   위해 begin/finalize 를 나눴다.
2. **심사자가 여는 바이트는 사용자가 바꿀 수 없다.** staging 업로드 토큰은
   만료 전까지 살아 있으므로, 검증한 자리에 파일을 그대로 두면
   `정상 업로드 → 검증 통과 → 악성 파일로 덮어쓰기` 가 성립한다(TOCTOU).
   그래서 검증한 바이트를 사용자가 토큰을 갖지 못한 `verified/` 로 옮긴다.
   *(GPT 보안 검수 P-20260721-…PRIORITY_01 지적사항)*

**감사 기록은 fail-closed** — `audit_logs` 기록에 실패하면 URL 을 주지 않는다.
경고만 띄우고 열어 주면 기록 없는 접근이 가능해지기 때문이다. 이벤트명이
`…_signed_url_issued` 인 이유는, URL 을 발급한 사실과 브라우저가 실제로
바이트를 받아 간 사실이 다르고 서버가 아는 것은 앞의 것뿐이기 때문이다.

## 파일

| 층 | 경로 |
|---|---|
| 학번 정규화·HMAC | `app/lib/server/verification/hmac.mjs` |
| 파일 정책·magic bytes | `app/lib/server/verification/files.mjs` |
| 라우트 공통 인증 | `app/lib/server/verification/auth.mjs` |
| 라우트 | `app/api/verification/{begin,finalize,document}/route.js` |
| 경로·형식 회귀 테스트 | `tests/verification-files.test.mjs` (9건) |
| 브라우저 절차 | `app/lib/community/verificationSubmit.js` |
| 사용자 화면 | `app/settings/verification/page.js` |
| 심사 콘솔 | `app/admin/verification/page.js` |

## 준비물 점검

```
node scripts/manual/diag-verification-ready.mjs
```

env·버킷·RPC 존재에 더해, 코드의 `doc_type` 목록이 DB CHECK 제약과 같은지
대조한다. 어긋나면 begin 이 원인을 알 수 없는 실패로 보인다.

## 배치 대상 미리보기 (아무것도 바꾸지 않음)

```
node scripts/manual/diag-batch-targets.mjs
```

expire-uploads / stale-reviews / purge / delete-accounts 각각이 지금 실행되면
무엇을 집을지, 그리고 DB 가 모르는 고아 Storage 객체가 있는지 센다.
`begin read only` 안에서 돌아 실수로도 쓰기가 되지 않는다.
실제 실행은 `/api/maintenance?job=…` (CRON_SECRET 필요) 이며 Cron 은 아직 비활성이다.

## 화면 응답 헤더

`/admin/*` 과 `/settings/*` 에 `Cache-Control: no-store`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer` 를 건다 (`next.config.mjs`). 각각 공유 PC 의
뒤로가기 캐시, 심사 버튼 클릭재킹, signed URL 의 Referer 유출을 막는다.
**dev 서버는 Cache-Control 을 자체 값으로 덮어쓰므로 확인은 운영 빌드에서 해야 한다**
(`next build && next start` 로 실측 완료).

## 상태 (2026-07-21)

- ✅ 비공개 버킷 `verification-docs` 생성 (10MB, 4개 MIME, `storage.objects` 정책 0개)
- ✅ RPC 6종 운영에 존재
- ✅ 로컬 HMAC 키 `VERIFY_HMAC_KEY_V1` / `VERIFY_HMAC_CURRENT_VER=1` (`.env.local`)
- ✅ GPT 보안 검수 반영 — staging/verified 경로 분리(TOCTOU), begin 단일 쓰기,
  audit fail-closed, 회귀 테스트 9건
- ⛔ **`SUPABASE_SECRET_KEY` 미등록** — 이것이 없으면 세 라우트 모두 503

### 남은 조치 — 명령 하나

```
npm run verify:setup
```

Supabase secret key 를 붙여넣기만 하면 나머지는 스크립트가 한다.
화면에는 `*` 만 보이고, 값은 `.env.local`(git 비추적)에만 들어간다.

이 스크립트가 대신 해 주는 것:
- 붙여넣은 키가 **실제로 동작하는지** Supabase 에 물어 확인 (형식만 보고 넘어가면
  "등록했는데 여전히 503" 이 된다). publishable 키를 잘못 넣으면 즉시 거부.
- 로컬 HMAC 키가 없으면 생성
- **운영(Vercel)용 HMAC 키를 따로 생성해 한 번만 표시** — 로컬 키를 운영에
  재사용하지 않도록. Vercel 에 넣을 변수 3개를 그대로 보여 준다.

> TTY 전용이라 파이프·CI·에이전트로는 실행되지 않는다. Claude 가 대신 실행해
> 줄 수 없다는 뜻이고, 그게 의도한 성질이다.

### 등록 후 확인

```
npm run verify:ready   # 준비 상태 — VERIFICATION_READY=PASS 여야 한다
npm run dev            # (다른 터미널)
npm run verify:e2e     # 실제 제출 흐름
```

`verify:e2e` 는 테스트 계정 2개를 만들어 정상 경로와 **거부 경로**를 함께 본다:
1건 제한, 남의 request 로 finalize, 업로드 전 finalize, 토큰 없는 호출,
잘못된 학번·doc_type, 일반 사용자의 서류 열람, 그리고 **staging 토큰으로
verified 를 덮어쓸 수 있는지**(TOCTOU). 끝나면 계정을 지운다.

> dev 서버는 시작할 때 `.env.local` 을 읽는다. 키를 넣었으면 **재시작**해야 한다.
> 재시작하지 않으면 여전히 503 이고, 스크립트가 그 경우를 따로 안내한다.

> ⚠️ HMAC 키는 지우면 끝이다. 학번 원문을 저장하지 않으므로 기존 HMAC 을
> 새 키로 재계산할 수 없다. 그 버전으로 저장된 행이 남아 있는 한 키를 보관한다
> (§4.2). 키를 잃으면 그 버전의 중복 가입 차단이 영구히 사라진다.

## 아직 없는 것

- `uploading` 24시간 초과분 `upload_expired` 전환 + 고아 객체 정리 배치 (§9, Cron 미활성)
- 심사 지연 알림 (`owner_warned_3_at` / `owner_warned_7_at`)
- 파기 배치 (`purge_after` 도달분)
