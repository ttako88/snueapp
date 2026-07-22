"use client"; // 설정 값을 브라우저(localStorage)에서 읽고 씀

import Link from "next/link";
import { useEffect, useState } from "react";
import { SetupSheet } from "../components/Timetable";
import { DEFAULT_SEMESTER, SEMESTER_LABELS, loadTimetableSetup, saveTimetableSetup } from "../lib/timetable";
import { useAuth, signOut } from "../lib/identity/useAuth";
import { CALENDAR_KINDS, loadHiddenKinds, saveHiddenKinds } from "../lib/calendarFilters";
import ConsentSettings from "../components/ConsentSettings";

// 설정 항목 정의. 나중에 새 설정이 생기면 여기 섹션을 추가하면 됨
// (앞으로 헤더 햄버거 메뉴로 옮기더라도 이 페이지 자체는 그대로 재사용).
export default function SettingsPage() {
  const [loaded, setLoaded] = useState(false);
  const [setup, setSetup] = useState(null); // 학년·과·학기
  const [eclassConnected, setEclassConnected] = useState(false);
  const [hiddenKinds, setHiddenKinds] = useState([]); // 숨긴 일정 종류 key 목록
  const { session, profile, loading: authLoading } = useAuth();

  // 심사 콘솔 진입점 노출 여부. 이건 UX 게이트일 뿐이고 실제 권한 경계는
  // DB 다 — 심사 RPC 들이 actor_role_check('operator') 를 첫 문장에서 부른다.
  const isReviewer = ["operator", "owner"].includes(profile?.role);

  const [setupOpen, setSetupOpen] = useState(false);
  const [formGrade, setFormGrade] = useState(3);
  const [formDept, setFormDept] = useState("");
  const [formSemester, setFormSemester] = useState(DEFAULT_SEMESTER);

  useEffect(() => {
    setSetup(loadTimetableSetup());
    setEclassConnected(Boolean(localStorage.getItem("eclassCalUrl")));
    setHiddenKinds(loadHiddenKinds());
    setLoaded(true);
  }, []);

  function openSetup() {
    setFormGrade(setup?.grade || 3);
    setFormDept(setup?.dept || "");
    setFormSemester(setup?.semester || DEFAULT_SEMESTER);
    setSetupOpen(true);
  }
  function saveSetup() {
    if (!formDept) return;
    const s = saveTimetableSetup(formGrade, formDept, formSemester);
    setSetup(s);
    setSetupOpen(false);
  }
  // 종류별 표시 토글: 체크하면 그 종류를 캘린더에서 숨긴다(일정 자체는 지우지 않음).
  function toggleKindHidden(key, hide) {
    setHiddenKinds((prev) => {
      const next = hide ? [...new Set([...prev, key])] : prev.filter((k) => k !== key);
      saveHiddenKinds(next);
      return next;
    });
  }

  if (!loaded) return null;

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <h2 className="text-lg font-bold text-[#0c4470]">설정</h2>

      {/* 계정 (게시판용 로그인) */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <p className="mb-1 text-xs font-bold text-[#0c4470]/40">계정</p>
        {authLoading ? (
          <p className="text-sm text-[#0c4470]/40">확인 중...</p>
        ) : session ? (
          <div className="flex w-full items-center justify-between">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-[#0c4470]">
                {profile ? profile.nickname : "닉네임 미설정"}
              </span>
              <span className="block truncate text-xs text-[#0c4470]/45">{session.user.email}</span>
            </span>
            <button
              onClick={async () => {
                await signOut();
              }}
              className="shrink-0 text-xs font-bold text-[#d05b6a]/80"
            >
              로그아웃
            </button>
          </div>
        ) : (
          <Link href="/login" className="flex w-full items-center justify-between">
            <span className="text-sm text-[#0c4470]/50">로그인하면 게시판을 쓸 수 있어요</span>
            <span className="shrink-0 text-xs font-bold text-[#0095da]">로그인 ›</span>
          </Link>
        )}
      </section>

      {/* 알림함 · 내 스크랩 (로그인 시) */}
      {session && (
        <Link href="/settings/messages" className="flex items-center justify-between rounded-2xl bg-white p-4 shadow-sm active:opacity-80">
          <span className="text-sm font-medium text-[#0c4470]">🔔 알림함</span>
          <span className="shrink-0 text-xs font-bold text-[#0095da]">받은 알림 ›</span>
        </Link>
      )}
      {session && (
        <Link href="/settings/bookmarks" className="flex items-center justify-between rounded-2xl bg-white p-4 shadow-sm active:opacity-80">
          <span className="text-sm font-medium text-[#0c4470]">📌 내 스크랩</span>
          <span className="shrink-0 text-xs font-bold text-[#0095da]">모아보기 ›</span>
        </Link>
      )}

      {/* 내 시간표 */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <p className="mb-1 text-xs font-bold text-[#0c4470]/40">내 시간표</p>
        {setup ? (
          <button onClick={openSetup} className="flex w-full items-center justify-between text-left">
            <span className="text-sm font-medium text-[#0c4470]">
              {setup.grade}학년 · {setup.dept}과 · {SEMESTER_LABELS[setup.semester] || setup.semester}
            </span>
            <span className="shrink-0 text-xs font-bold text-[#0095da]">변경 ›</span>
          </button>
        ) : (
          <button onClick={openSetup} className="flex w-full items-center justify-between text-left">
            <span className="text-sm text-[#0c4470]/50">아직 설정 안 함</span>
            <span className="shrink-0 text-xs font-bold text-[#0095da]">설정하기 ›</span>
          </button>
        )}
      </section>

      {/* e-Class 연동 */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <p className="mb-1 text-xs font-bold text-[#0c4470]/40">e-Class 연동</p>
        <Link href="/eclass" className="flex w-full items-center justify-between">
          <span className="flex items-center gap-1.5 text-sm font-medium text-[#0c4470]">
            {eclassConnected ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-[#57a06f]" /> 연결됨
              </>
            ) : (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-black/20" /> 연결 안 됨
              </>
            )}
          </span>
          <span className="shrink-0 text-xs font-bold text-[#0095da]">{eclassConnected ? "관리" : "연동하기"} ›</span>
        </Link>
      </section>

      {/* 캘린더 표시 — 종류별로 숨길 수 있음 (일정 삭제 아님) */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <p className="mb-1 text-xs font-bold text-[#0c4470]/40">캘린더 표시</p>
        <p className="mb-2.5 text-[11px] text-[#0c4470]/40">숨겨도 일정이 지워지진 않고, 캘린더에서만 안 보여요.</p>
        <div className="flex flex-col gap-2.5">
          {CALENDAR_KINDS.map((kind) => (
            <label key={kind.key} className="flex items-center justify-between">
              <span className="text-sm font-medium text-[#0c4470]">{kind.label} 숨기기</span>
              <input
                type="checkbox"
                checked={hiddenKinds.includes(kind.key)}
                onChange={(e) => toggleKindHidden(kind.key, e.target.checked)}
                className="h-5 w-5 accent-[#0095da]"
              />
            </label>
          ))}
        </div>
      </section>

      {/* 도움·운영 — 버그 제보는 로그인 없이도 화면은 보이고 안에서 안내한다 */}
      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <p className="mb-1 text-xs font-bold text-[#0c4470]/40">도움</p>
        <Link href="/settings/verification" className="flex w-full items-center justify-between">
          <span className="text-sm font-medium text-[#0c4470]">학생 인증</span>
          <span className="shrink-0 text-xs font-bold text-[#0095da]">신청 ›</span>
        </Link>
        <Link href="/settings/bug-report" className="mt-3 flex w-full items-center justify-between border-t border-black/5 pt-3">
          <span className="text-sm font-medium text-[#0c4470]">버그 제보 · 건의</span>
          <span className="shrink-0 text-xs font-bold text-[#0095da]">보내기 ›</span>
        </Link>
        {isReviewer && (
          <Link href="/admin" className="mt-3 flex w-full items-center justify-between border-t border-black/5 pt-3">
            <span className="text-sm font-medium text-[#0c4470]">관리자 콘솔</span>
            <span className="shrink-0 text-xs font-bold text-[#0095da]">운영자 ›</span>
          </Link>
        )}
      </section>

      {/* 데이터 동의 — 맨 아래 배치(상단은 사용자를 쫓아냄). productAnalytics+로그인 시에만 노출 */}
      <ConsentSettings />

      <p className="text-center text-[11px] text-[#0c4470]/30">앞으로 추가되는 설정도 여기 모아둘게요</p>

      {setupOpen && (
        <SetupSheet {...{ formGrade, setFormGrade, formDept, setFormDept, formSemester, setFormSemester, saveSetup }} onClose={() => setSetupOpen(false)} />
      )}
    </div>
  );
}
