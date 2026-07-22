"use client";
// 회원 관리 — 검색·목록·상세 + 이용권 부여/회수(owner).
//
// 서버 RPC(admin_list_members / admin_member_detail / grant_entitlement /
// revoke_entitlement)가 권한과 PII 노출을 최종 판정한다. 화면은 미러다.

import { useEffect, useState } from "react";
import { useAuth } from "../../../lib/identity/useAuth";
import {
  adminListMembers, adminMemberDetail, grantEntitlement, revokeEntitlement, roleHasPerm,
  isNotActivated, setMemberRole, deleteMember, setMemberNote,
} from "../../../lib/community/adminConsole";

const ROLE_LABEL = { member: "일반", moderator: "모더레이터", operator: "운영자", owner: "오너" };

const STATUS_LABEL = {
  pending: "대기", submitted: "심사중", verified: "인증", rejected: "반려",
  expired: "만료", deleting: "삭제중",
};
const SANCTION_LABEL = {
  none: "", write_restricted: "쓰기제한", community_suspended: "정지", banned: "강퇴",
};

export default function MembersPage() {
  const { profile } = useAuth();
  const role = profile?.role ?? null;
  const canManageCost = roleHasPerm(role, "entitlement.manage_cost");

  const [search, setSearch] = useState("");  // 입력 중 값
  const [query, setQuery] = useState("");     // 확정된 검색어(Enter 시)
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notActivated, setNotActivated] = useState(false);
  const [selected, setSelected] = useState(null); // member_id
  const [reloadTick, setReloadTick] = useState(0);

  // 목록 로드 — effect 본문에서 직접 setState 하지 않고 async IIFE + alive 가드.
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setError(null); setNotActivated(false);
      const { data, error: err } = await adminListMembers({
        search: query.trim() || null, status: status || null, limit: 50,
      });
      if (!alive) return;
      if (isNotActivated(err)) setNotActivated(true);
      else if (err) setError(err.message || "불러오지 못했어요");
      else setRows(Array.isArray(data) ? data : []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [query, status, reloadTick]);

  return (
    <div className="flex flex-col gap-3">
      {/* 검색 */}
      <div className="flex gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && setQuery(search)}
          placeholder="닉네임 검색"
          className="min-w-0 flex-1 rounded-lg bg-[#f2f6fa] px-3 py-2 text-sm text-[#0c4470]" />
        <select value={status} onChange={(e) => setStatus(e.target.value)}
          className="rounded-lg bg-[#f2f6fa] px-2 py-2 text-xs text-[#0c4470]">
          <option value="">전체상태</option>
          <option value="verified">인증</option>
          <option value="submitted">심사중</option>
          <option value="pending">대기</option>
        </select>
      </div>

      {loading && <Muted>불러오는 중…</Muted>}
      {notActivated && <NotActivated />}
      {error && <p className="text-sm text-[#c0392b]">{error}</p>}

      {!loading && !error && !notActivated && rows.length === 0 && <Muted>결과가 없어요.</Muted>}

      <div className="flex flex-col gap-1.5">
        {rows.map((m) => (
          <button key={m.member_id} onClick={() => setSelected(m.member_id)}
            className="flex items-center gap-2 rounded-xl bg-white p-3 text-left shadow-sm active:opacity-80">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-[#0c4470]">
                {m.nickname || <span className="text-[#0c4470]/40">닉네임 없음</span>}
                {m.username && <span className="ml-1.5 text-[11px] font-normal text-[#0c4470]/40">@{m.username}</span>}
              </span>
              <span className="block text-[11px] text-[#0c4470]/50">
                {STATUS_LABEL[m.verification_status] ?? m.verification_status}
                {m.role !== "member" && ` · ${m.role}`}
                {m.sanction !== "none" && ` · ${SANCTION_LABEL[m.sanction]}`}
                {m.hakbeon_verified && " · 🎓학번"}
                {m.analytics_consent && " · 📊동의"}
              </span>
              {m.note && (
                <span className="mt-0.5 block truncate text-[11px] text-[#0c4470]/35">📝 {m.note}</span>
              )}
            </span>
            <span className="text-xs text-[#0c4470]/30">›</span>
          </button>
        ))}
      </div>

      {selected && (
        <MemberDetail memberId={selected} canManageCost={canManageCost} isOwner={role === "owner"}
          onClose={() => setSelected(null)} onChanged={() => setReloadTick((t) => t + 1)} />
      )}
    </div>
  );
}

function MemberDetail({ memberId, canManageCost, isOwner, onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [detailTick, setDetailTick] = useState(0);
  // window.prompt 는 모바일·인앱 웹뷰에서 막혀서 버튼이 안 먹는 것처럼 보인다.
  // 인앱 사유 입력으로 대체한다: 버튼을 누르면 pending 을 세우고 사유칸을 띄운다.
  const [pending, setPending] = useState(null); // { kind:'grant'|'revoke', grantType?, quota?, grantId?, title }
  const [reason, setReason] = useState("");
  const [noteText, setNoteText] = useState("");
  const [noteMsg, setNoteMsg] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setError(null);
      const { data, error: err } = await adminMemberDetail(memberId);
      if (!alive) return;
      if (err) setError(err.message || "불러오지 못했어요");
      else { setDetail(data); setNoteText(data?.note || ""); }
    })();
    return () => { alive = false; };
  }, [memberId, detailTick]);

  const saveNote = async () => {
    setNoteMsg(null); setBusy(true);
    const { error: err } = await setMemberNote({ memberId, note: noteText });
    setBusy(false);
    if (err) { setNoteMsg("저장 실패"); return; }
    setNoteMsg("저장했어요"); onChanged?.();
  };

  const refresh = () => { setDetailTick((t) => t + 1); onChanged?.(); };

  const DEL_ERR = {
    forbidden: "삭제 권한이 없어요(오너만).", cannot_delete_self: "본인 계정은 지울 수 없어요.",
    cannot_delete_staff: "운영진 계정은 이 도구로 지울 수 없어요.", reason_required: "사유를 적어주세요.",
  };

  const confirmPending = async () => {
    const r = reason.trim();
    if (!r || !pending) return;
    const p = pending;
    setBusy(true);
    let err = null;
    if (p.kind === "grant") {
      const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
      ({ error: err } = await grantEntitlement({
        memberId, key: "lesson_plan_generate", grantType: p.grantType,
        quota: p.grantType === "quota" ? p.quota : null,
        expiresAt: p.grantType === "quota" ? expiresAt : null, reason: r,
      }));
    } else if (p.kind === "revoke") {
      ({ error: err } = await revokeEntitlement({ grantId: p.grantId, reason: r }));
    } else if (p.kind === "role") {
      ({ error: err } = await setMemberRole({ memberId, role: p.role, reason: r }));
    } else if (p.kind === "delete") {
      ({ error: err } = await deleteMember({ memberId, reason: r }));
      setBusy(false);
      if (err) { setError(DEL_ERR[err.message] || "삭제하지 못했어요."); return; }
      // 계정이 사라졌다 — 상세를 닫고 목록을 새로고침.
      setPending(null); setReason(""); onChanged?.(); onClose?.();
      return;
    }
    setBusy(false);
    if (err) { setError(err.message || "처리하지 못했어요."); return; }
    setPending(null); setReason("");
    refresh();
  };

  const ents = detail?.entitlements ?? [];
  const activeLessonPlan = ents.some(
    (e) => e.key === "lesson_plan_generate" && e.status === "active");

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/30" onClick={onClose}>
      <div className="max-h-[85vh] w-full overflow-y-auto rounded-t-3xl bg-white p-4"
        onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-bold text-[#0c4470]">회원 상세</p>
          <button onClick={onClose} className="text-sm text-[#0c4470]/50">닫기</button>
        </div>

        {error && <p className="mb-2 text-sm text-[#c0392b]">{error}</p>}
        {!detail ? <Muted>불러오는 중…</Muted> : (
          <>
            <Row label="닉네임" value={detail.nickname || "없음"} />
            <Row label="아이디" value={detail.username || "—"} />
            <Row label="이메일" value={detail.email || "—"} />
            <Row label="권한" value={detail.role} />
            <Row label="인증" value={STATUS_LABEL[detail.verification_status] ?? detail.verification_status} />
            <Row label="학번 인증" value={detail.hakbeon_verified ? "완료 🎓" : "미등록"} />
            <Row label="통계 동의" value={detail.analytics_consent ? "동의 📊" : "미동의"} />
            <Row label="제재" value={SANCTION_LABEL[detail.sanction] || "없음"} />

            {/* 운영자 메모 — 회원별 1개. 목록에도 회색 미리보기로 뜬다. */}
            <div className="mt-3 rounded-xl bg-[#f2f6fa] p-3">
              <p className="text-xs font-bold text-[#0c4470]/70">📝 운영자 메모</p>
              <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} rows={2}
                placeholder="이 회원에 대한 메모 (운영자만 보여요)" maxLength={1000}
                className="mt-1.5 w-full resize-none rounded-lg bg-white px-3 py-2 text-sm text-[#0c4470] outline-none" />
              <div className="mt-1 flex items-center gap-2">
                <button disabled={busy} onClick={saveNote}
                  className="rounded-lg bg-[#0c4470] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">메모 저장</button>
                {noteMsg && <span className="text-[11px] text-[#0c4470]/50">{noteMsg}</span>}
              </div>
            </div>

            {/* 이용권 */}
            <p className="mb-1 mt-4 text-xs font-bold text-[#0c4470]/70">이용권</p>
            {ents.length === 0 ? <Muted>부여된 이용권이 없어요.</Muted> : (
              <div className="flex flex-col gap-1.5">
                {ents.map((e) => (
                  <div key={e.grant_id}
                    className="flex items-center gap-2 rounded-xl bg-[#f2f6fa] p-3">
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-bold text-[#0c4470]">
                        {e.key === "lesson_plan_generate" ? "지도안 생성" : e.key}
                        {" · "}
                        {e.grant_type === "unlimited" ? "무제한"
                          : `${e.used}/${e.quota_total}회`}
                        {e.status !== "active" && " · 회수됨"}
                      </span>
                      <span className="block text-[11px] text-[#0c4470]/45">
                        {e.expires_at ? `~${e.expires_at.slice(0, 10)}` : "무기한"}
                        {e.reason && ` · ${e.reason}`}
                      </span>
                    </span>
                    {canManageCost && e.status === "active" && (
                      <button disabled={busy}
                        onClick={() => { setReason(""); setPending({ kind: "revoke", grantId: e.grant_id, title: "이용권 회수" }); }}
                        className="rounded-lg bg-white px-2.5 py-1 text-[11px] font-bold text-[#c0392b] disabled:opacity-50">
                        회수
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* 지도안 이용권 부여 (owner) */}
            {canManageCost && !activeLessonPlan && (
              <div className="mt-3 rounded-xl bg-[#eaf6ff] p-3">
                <p className="text-xs font-bold text-[#0c4470]">지도안 생성권 부여</p>
                <p className="mt-0.5 text-[11px] text-[#0c4470]/55">
                  결제 없이 이 회원이 지도안을 뽑을 수 있게 해요.
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button disabled={busy}
                    onClick={() => { setReason(""); setPending({ kind: "grant", grantType: "quota", quota: 10, title: "지도안 생성권 · 30일 10회" }); }}
                    className="rounded-lg bg-[#0095da] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">
                    30일 · 10회
                  </button>
                  <button disabled={busy}
                    onClick={() => { setReason(""); setPending({ kind: "grant", grantType: "quota", quota: 3, title: "지도안 생성권 · 30일 3회" }); }}
                    className="rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-[#0095da] disabled:opacity-50">
                    30일 · 3회
                  </button>
                  <button disabled={busy}
                    onClick={() => { setReason(""); setPending({ kind: "grant", grantType: "unlimited", title: "지도안 생성권 · 무제한" }); }}
                    className="rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-[#0c4470]/70 disabled:opacity-50">
                    무제한(무기한)
                  </button>
                </div>
              </div>
            )}

            {/* 역할(권한) 변경 — 오너만. grant_role 이 DB 에서 재검사·마지막 오너 보호. */}
            {isOwner && detail.role !== "owner" && (
              <div className="mt-3 rounded-xl bg-[#f2f6fa] p-3">
                <p className="text-xs font-bold text-[#0c4470]">권한 부여 · 변경</p>
                <p className="mt-0.5 text-[11px] text-[#0c4470]/55">현재: <b>{ROLE_LABEL[detail.role] ?? detail.role}</b>. 믿을 만한 지인에게 운영 권한을 줄 수 있어요.</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {["operator", "moderator", "member"].filter((rk) => rk !== detail.role).map((rk) => (
                    <button key={rk} disabled={busy}
                      onClick={() => { setReason(""); setPending({ kind: "role", role: rk, title: `권한을 '${ROLE_LABEL[rk]}'(으)로 변경` }); }}
                      className="rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-[#0c4470]/80 disabled:opacity-50">
                      {ROLE_LABEL[rk]}(으)로
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 계정 삭제 — 오너만, 비가역. 운영진·본인은 서버가 거부. */}
            {isOwner && detail.role !== "owner" && (
              <div className="mt-3 rounded-xl border border-[#d05b6a]/30 bg-[#fdf3f4] p-3">
                <p className="text-xs font-bold text-[#c0392b]">계정 삭제 (되돌릴 수 없음)</p>
                <p className="mt-0.5 text-[11px] text-[#0c4470]/55">테스트·깡통 계정 정리용. 이 회원의 계정과 데이터가 영구 삭제되고 아이디·학번이 풀려요.</p>
                <button disabled={busy}
                  onClick={() => { setReason(""); setPending({ kind: "delete", danger: true, title: `${detail.nickname || "이 회원"} 계정 삭제` }); }}
                  className="mt-2 rounded-lg bg-[#c0392b] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">
                  계정 삭제
                </button>
              </div>
            )}

            {/* 사유 입력 패널 — window.prompt 대체(모바일/웹뷰 호환). */}
            {pending && (
              <div className="mt-3 rounded-xl border border-[#0095da]/30 bg-white p-3">
                <p className="text-xs font-bold text-[#0c4470]">{pending.title}</p>
                <p className="mt-0.5 text-[11px] text-[#0c4470]/55">사유를 적어주세요 (감사 기록에 남아요).</p>
                <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && confirmPending()}
                  placeholder="예: 베타테스트 참여"
                  className="mt-2 w-full rounded-lg bg-[#f2f6fa] px-3 py-2 text-sm text-[#0c4470] outline-none" />
                <div className="mt-2 flex gap-1.5">
                  <button disabled={busy || !reason.trim()} onClick={confirmPending}
                    className={`rounded-lg px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40 ${pending.danger ? "bg-[#c0392b]" : "bg-[#0095da]"}`}>
                    {pending.danger ? "삭제 확인" : "확인"}
                  </button>
                  <button disabled={busy} onClick={() => { setPending(null); setReason(""); }}
                    className="rounded-lg bg-[#f2f6fa] px-3 py-1.5 text-xs font-bold text-[#0c4470]/60">
                    취소
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between border-b border-[#f2f6fa] py-1.5 text-sm">
      <span className="text-[#0c4470]/55">{label}</span>
      <span className="font-bold text-[#0c4470]">{value}</span>
    </div>
  );
}
function NotActivated() {
  return (
    <div className="rounded-2xl bg-[#fff7e6] p-4">
      <p className="text-sm font-bold text-[#0c4470]">아직 활성화되지 않았어요</p>
      <p className="mt-1 text-xs text-[#0c4470]/60">
        회원 관리·이용권 기능은 DB 준비(migration 028)를 운영에 적용한 뒤 열려요.
        코드는 배포됐고, 적용만 하면 바로 동작해요.
      </p>
    </div>
  );
}
function Muted({ children }) {
  return <p className="text-sm text-[#0c4470]/50">{children}</p>;
}
