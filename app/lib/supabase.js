// Supabase 클라이언트 (브라우저 공용 싱글턴).
// 키는 환경변수에서: .env.local(로컬) / Vercel 환경변수(배포).
// anon 키는 공개되어도 되는 키 — 실제 보안은 DB의 RLS 정책이 담당한다
// (supabase/schema.sql 참고). service_role 키는 절대 여기 넣지 말 것.
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// 환경변수가 아직 없으면 null — 화면 쪽에서 "준비 중" 안내를 띄울 수 있게.
export const supabase = url && anonKey ? createClient(url, anonKey) : null;
