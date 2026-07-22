"use client";
// ============================================================
// ConsentSettings — 데이터 동의 설정(상세 이용통계 / 맞춤광고). 설정 화면에 얹는다.
// ============================================================
// · 기본 OFF, 목적별 독립 토글. 상세통계 동의 ≠ 광고 동의.
// · 서버(set_my_consent)가 본인 것만·18+ 검증. 여기선 UI만.
// · productAnalytics flag OFF 거나 비로그인이면 렌더 안 함(휴면).
// · 맞춤광고 토글은 targetedAds flag 켜졌을 때만 노출(지금은 사업자등록 전이라 숨김).
import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "../lib/identity/useAuth";
import { isEnabled } from "../lib/features.js";
import { getMyConsents, setMyConsent } from "../lib/community/consent.js";

// 토글 한 줄. render 밖에 선언(매 렌더마다 재생성되면 상태·포커스가 튄다).
function Row({ on, onChange, busy, title, desc }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5">
      <div>
        <p className="text-sm font-bold text-[#0c4470]">{title}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-[#0c4470]/50">{desc}</p>
      </div>
      <button
        onClick={() => !busy && onChange(!on)} disabled={busy}
        className={`mt-0.5 h-6 w-11 shrink-0 rounded-full transition ${on ? "bg-[#0095da]" : "bg-[#0c4470]/15"} disabled:opacity-40`}>
        <span className={`block h-5 w-5 rounded-full bg-white shadow transition ${on ? "translate-x-5" : "translate-x-0.5"}`} />
      </button>
    </div>
  );
}

export default function ConsentSettings() {
  const { session } = useAuth();
  const [ana, setAna] = useState(false);
  const [ads, setAds] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const showAds = isEnabled("targetedAds");

  useEffect(() => {
    if (!session) return;
    let alive = true;
    (async () => {
      const { data } = await getMyConsents();
      if (!alive || !data) return;
      setAna(data.product_analytics?.granted === true);
      setAds(data.targeted_ads?.granted === true);
    })();
    return () => { alive = false; };
  }, [session]);

  if (!isEnabled("productAnalytics") || !session) return null;

  async function toggle(purpose, next) {
    setBusy(true); setNotice(null);
    let ageConfirmed = false;
    if (purpose === "targeted_ads" && next) {
      ageConfirmed = window.confirm("맞춤 광고 동의는 만 18세 이상만 가능해요. 만 18세 이상이 맞나요?");
      if (!ageConfirmed) { setBusy(false); return; }
    }
    const { data, error } = await setMyConsent(purpose, next, ageConfirmed);
    if (error || !data || (data.status !== "ok")) {
      setNotice(data?.status === "age_required" ? "만 18세 이상만 동의할 수 있어요." : "처리하지 못했어요. 잠시 뒤 다시.");
    } else {
      if (purpose === "product_analytics") setAna(next);
      else setAds(next);
      setNotice(next ? "동의했어요. 고마워요!" : "동의를 해제했어요.");
    }
    setBusy(false);
  }

  return (
    <section className="rounded-2xl bg-white p-4 shadow-sm">
      <p className="text-xs font-bold text-[#0c4470]/40">데이터 동의 (선택)</p>
      <p className="mt-1 text-[11px] leading-relaxed text-[#0c4470]/45">
        서비스 개선을 위한 익명 이용통계는 기본으로 최소 수집돼요. 아래는 원하면 켜는 선택 항목이에요.
        자세한 내용은 <Link href="/privacy" className="font-bold text-[#0095da]">개인정보 처리방침</Link>.
      </p>
      <div className="mt-2 divide-y divide-black/5">
        <Row on={ana} busy={busy} onChange={(v) => toggle("product_analytics", v)}
          title="상세 이용통계 동의"
          desc="학과·학년 세그먼트로 어떤 기능이 필요한지 파악해 서비스를 개선해요. 학번 원문·실명은 쓰지 않아요." />
        {showAds && (
          <Row on={ads} busy={busy} onChange={(v) => toggle("targeted_ads", v)}
            title="맞춤형 광고 동의 (만 18세 이상)"
            desc="학과·학년에 맞는 스폰서 정보를 보여줘요. 미동의여도 일반 광고는 나올 수 있어요. 광고주에게 개인정보는 넘기지 않아요." />
        )}
      </div>
      {notice && <p className="mt-2 text-[11px] font-bold text-[#0095da]">{notice}</p>}
    </section>
  );
}
