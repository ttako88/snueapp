"use client";
// 이용권 현황 — 지금 누구에게 어떤 기능이 열려 있나. 부여/회수는 회원 관리에서.

import Link from "next/link";
import { useEffect, useState } from "react";
import { adminListEntitlements, isNotActivated } from "../../../lib/community/adminConsole";

export default function EntitlementsPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notActivated, setNotActivated] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setError(null); setNotActivated(false);
      const { data, error: err } = await adminListEntitlements();
      if (!alive) return;
      if (isNotActivated(err)) setNotActivated(true);
      else if (err) setError(err.message || "불러오지 못했어요");
      else setRows(Array.isArray(data) ? data : []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-[#0c4470]/45">
        부여·회수는 <Link href="/admin/console/members" className="font-bold text-[#0095da]">회원 관리</Link>에서 해요.
      </p>

      {loading && <Muted>불러오는 중…</Muted>}
      {notActivated && (
        <div className="rounded-2xl bg-[#fff7e6] p-4">
          <p className="text-sm font-bold text-[#0c4470]">아직 활성화되지 않았어요</p>
          <p className="mt-1 text-xs text-[#0c4470]/60">
            이용권 기능은 migration 028을 운영에 적용하면 열려요. 코드는 배포됐어요.
          </p>
        </div>
      )}
      {error && <p className="text-sm text-[#c0392b]">{error}</p>}
      {!loading && !error && !notActivated && rows.length === 0 && <Muted>활성 이용권이 없어요.</Muted>}

      <div className="flex flex-col gap-1.5">
        {rows.map((e) => (
          <div key={e.grant_id} className="rounded-xl bg-white p-3 shadow-sm">
            <p className="text-sm font-bold text-[#0c4470]">
              {e.nickname || "닉네임 없음"}
            </p>
            <p className="mt-0.5 text-[11px] text-[#0c4470]/55">
              {e.entitlement_key === "lesson_plan_generate" ? "지도안 생성" : e.entitlement_key}
              {" · "}
              {e.grant_type === "unlimited" ? "무제한" : `${e.used}/${e.quota_total}회`}
              {e.expires_at && ` · ~${e.expires_at.slice(0, 10)}`}
              {e.reason && ` · ${e.reason}`}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function Muted({ children }) {
  return <p className="text-sm text-[#0c4470]/50">{children}</p>;
}
