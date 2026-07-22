// 목적별 동의 조회·설정 래퍼 (S2 설정 UI + S5 GA Consent Mode 공용).
//
// 권한 경계는 DB 다 — set_my_consent/get_my_consents 가 auth.uid() 로 본인만 다룬다.
// 맞춤광고(targeted_ads) 동의는 18+ 확인이 있어야 서버가 성립시킨다(age_required).

import { supabase } from "../supabase/client";
import { isEnabled } from "../features.js";

// 동의 문구 버전. 문구가 바뀌면 올린다(재동의 유도·이력 구분).
export const CONSENT_VERSION = "2026-07-22";

export async function getMyConsents() {
  if (!supabase) return { error: { code: "unavailable" } };
  const { data, error } = await supabase.rpc("get_my_consents");
  if (error) return { error };
  return { data: data ?? {} };
}

/**
 * @param {"product_analytics"|"targeted_ads"} purpose
 * @param {boolean} granted
 * @param {boolean} [ageConfirmed] 맞춤광고 동의 시 만 18세 이상 확인
 */
export async function setMyConsent(purpose, granted, ageConfirmed = false) {
  if (!supabase) return { error: { code: "unavailable" } };
  const { data, error } = await supabase.rpc("set_my_consent", {
    p_purpose: purpose,
    p_granted: granted,
    p_version: CONSENT_VERSION,
    p_age_confirmed: ageConfirmed,
  });
  if (error) return { error };
  // GA(Basic Consent Mode) 가 켜져 있고 상세통계 동의가 실제로 바뀌었으면, 태그를
  // 깨끗한 문서에서 (재)로드/폐기하도록 full navigation 한다(GPT B3). GA 미사용 시엔
  // 아무 일도 안 한다(reload 없음).
  if (data?.status === "ok" && purpose === "product_analytics" &&
      isEnabled("ga4") && typeof window !== "undefined") {
    window.location.reload();
  }
  return { data }; // { status: 'ok' | 'age_required' | 'bad_purpose' | ... }
}
