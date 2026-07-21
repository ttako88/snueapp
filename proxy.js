// ============================================================
// 임시 유지보수 게이트 (APP_EDGE_WRITE_FENCE)
// ============================================================
// 이 파일은 운영 DB 재구성 동안에만 존재하는 **임시 커밋 전용** 파일이다.
// 최종 RC 배포 시 이 커밋이 없는 e9d1c75 트리로 교체되며, main에 병합하지 않는다.
//
// 설계 의도:
//   · 환경변수에 의존하지 않는다. env 누락·오타로 서비스가 열리는 실패를 막기 위해
//     코드 자체에서 무조건 ON이다. (기존 MAINTENANCE_ENABLED는 "Cron 배치 활성"이라는
//     **반대 의미**의 별개 변수다. 혼동 금지.)
//   · 정적 자산을 제외한 모든 경로·모든 메서드를 Proxy 단계에서 즉시 끊는다.
//     Route Handler까지 요청이 도달하지 않으므로 DB·Auth·Storage 접근이 발생하지 않는다.
//   · /api/maintenance(Cron 진입점)도 예외 없이 막는다.
//
// 한계 (GPT 검수 확인 사항):
//   Supabase REST를 브라우저에서 직접 호출하면 Vercel Proxy를 우회한다.
//   따라서 이것은 1차 방어선일 뿐이고, 완전한 쓰기 차단은 후속 DB_WRITE_FENCE
//   (anon/authenticated/PUBLIC의 DML·EXECUTE 회수)로 완성한다.
//
// Next.js 16 기준: Middleware가 Proxy로 명칭 변경됨.
//   node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md
//   node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md
//   - 루트 proxy.js / named export `proxy` / config.matcher
//   - Response를 직접 반환하면 즉시 응답 (v13.1+)
//   - 런타임은 Node.js 기본. `runtime` 설정 시 에러이므로 지정하지 않는다.
// ============================================================

const BODY = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>점검 중</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#eaf6fd; color:#0c4470;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Apple SD Gothic Neo","Noto Sans KR",sans-serif; }
  main { max-width:22rem; padding:2rem 1.5rem; text-align:center; }
  h1 { font-size:1.125rem; margin:0 0 .75rem; }
  p { font-size:.875rem; line-height:1.7; margin:0; opacity:.75; }
</style>
</head>
<body>
<main>
  <h1>서비스 점검 중입니다</h1>
  <p>서비스 기반 정비 중이며 잠시 후 다시 이용할 수 있습니다.</p>
</main>
</body>
</html>
`;

export function proxy() {
  // 요청 내용을 읽지 않는다 — 어떤 경로·메서드·본문이든 동일하게 끊는다.
  return new Response(BODY, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store, no-cache, max-age=0, must-revalidate",
      "Retry-After": "900",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

// 정적 자산만 통과시킨다. 그 외 모든 경로(/, /login, /board/*, /api/*)는 위 503으로 간다.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
