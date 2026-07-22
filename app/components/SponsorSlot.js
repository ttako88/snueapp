"use client";
// ============================================================
// SponsorSlot — first-party 스폰서 슬롯 (S6). targetedAds OFF 면 렌더 안 함(휴면).
// ============================================================
// 서버가 본인 컨텍스트로 고른 스폰서만 받는다. "광고·후원" 을 명시하고, 링크는
// rel=sponsored nofollow. 노출은 마운트 시, 클릭은 클릭 시 집계로 보낸다.
// 현재 어떤 화면에도 미배선(완전 휴면). 활성화 시 원하는 자리에 <SponsorSlot slot="slot_home"/>.
import { useEffect, useState } from "react";
import { isEnabled } from "../lib/features.js";
import { getSponsorForSlot, recordSponsorEvent } from "../lib/community/sponsors.js";

export default function SponsorSlot({ slot }) {
  const active = isEnabled("targetedAds");
  const [ad, setAd] = useState(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    (async () => {
      const { data } = await getSponsorForSlot(slot);
      if (!alive || !data) return;
      setAd(data);
      recordSponsorEvent(data.token, "impression"); // sponsor_id 아닌 delivery token
    })();
    return () => { alive = false; };
  }, [active, slot]);

  if (!active || !ad) return null;

  return (
    <a
      href={ad.link}
      target="_blank"
      rel="noreferrer nofollow sponsored"
      onClick={() => recordSponsorEvent(ad.token, "click")}
      className="block rounded-2xl border border-black/5 bg-white p-4 shadow-sm"
    >
      <span className="text-[10px] font-bold uppercase tracking-wide text-[#0c4470]/40">
        광고 · 후원
      </span>
      <p className="mt-1 text-sm font-bold text-[#0c4470]">{ad.title}</p>
      {ad.body && <p className="mt-0.5 text-xs text-[#0c4470]/60">{ad.body}</p>}
    </a>
  );
}
