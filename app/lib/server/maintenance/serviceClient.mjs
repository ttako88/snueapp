// service_role Supabase 클라이언트 팩토리 (서버 전용).
// GPT §5-4: server-only, persistSession=false, autoRefreshToken=false, NEXT_PUBLIC 키 금지.
// 실제 secret 값은 서버 env(SUPABASE_SECRET_KEY)에서만 — 클라이언트 번들 유입 금지.
// P0-3: 변수명은 Supabase 공식 명칭(sb_secret_) 기준 SUPABASE_SECRET_KEY로 통일.
//   env "변수명"과 DB "service_role 역할"은 별개 — sb_secret_ 키가 service 권한으로 RPC를 호출하는 구조는 동일.
import { createClient } from "@supabase/supabase-js";

export function createServiceClient(env) {
  if (typeof window !== "undefined") {
    throw new Error("service client는 서버 전용입니다 — 클라이언트에서 생성 금지");
  }
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("service env 누락");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
