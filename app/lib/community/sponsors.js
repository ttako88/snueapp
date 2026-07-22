// first-party 스폰서 슬롯 래퍼 (S6). targetedAds OFF 면 컴포넌트가 렌더 안 함(휴면).
//
// 스폰서 선택은 서버(get_sponsor_for_slot)가 본인 컨텍스트로 한다 — 세그먼트는
// 서버 밖으로 안 나오고, 클라이언트는 delivery token + 크리에이티브만 받는다.
// 노출·클릭은 sponsor_id 가 아니라 **token** 으로 보낸다(위조·증폭 차단). 서버가
// token 에서 sponsor_id 를 복원하고 token 당 각 1회만 집계한다.

import { supabase } from "../supabase/client";
import { authedPost } from "./apiFetch";

export async function getSponsorForSlot(slot) {
  if (!supabase) return { error: { code: "unavailable" } };
  return supabase.rpc("get_sponsor_for_slot", { p_slot: slot });
}

export async function recordSponsorEvent(token, kind) {
  return authedPost("/api/ad-event", { token, kind });
}
