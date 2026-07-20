// service_role Supabase 클라이언트 팩토리 (서버 전용).
// GPT §5-4: server-only, persistSession=false, autoRefreshToken=false, NEXT_PUBLIC 키 금지.
// 실제 secret 값은 서버 env(SUPABASE_SERVICE_ROLE_KEY)에서만 — 클라이언트 번들 유입 금지.
import { createClient } from "@supabase/supabase-js";

export function createServiceClient(env) {
  if (typeof window !== "undefined") {
    throw new Error("service client는 서버 전용입니다 — 클라이언트에서 생성 금지");
  }
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("service env 누락");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
