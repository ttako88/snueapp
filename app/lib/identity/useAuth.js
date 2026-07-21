"use client"; // 로그인 세션은 브라우저에서만 존재

import { useEffect, useState } from "react";
import { supabase } from "../supabase/client";

// 로그인 세션 + 내 프로필(닉네임)을 함께 제공하는 훅.
// - session === null && !loading → 비로그인
// - session 있고 profile === null → 가입은 했지만 닉네임을 아직 안 만듦
export function useAuth() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true); // 세션 확인 중
  const [profileLoading, setProfileLoading] = useState(false); // 닉네임(profiles) 조회 중

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!supabase || !session) {
      setProfile(null);
      return;
    }
    // 신 스키마에는 public.profiles 가 없다. 회원 정보는 private.members 에
    // 있고 클라이언트는 그 스키마에 접근할 수 없다(001 이 USAGE 를 회수).
    // 정해진 통로는 definer RPC 다. private 를 직접 읽는 우회는 하지 않는다.
    //
    // get_my_member 는 setof 를 돌려주므로 행이 없으면 빈 배열이다.
    // 닉네임을 아직 안 만든 상태는 "행이 있고 nickname 이 null" 이다.
    // 이 둘을 구분하지 않으면 온보딩 화면이 안 뜬다.
    setProfileLoading(true);
    supabase
      .rpc("get_my_member")
      .then(({ data }) => {
        const row = Array.isArray(data) ? data[0] : data;
        setProfile(row && row.nickname ? row : null);
        setProfileLoading(false);
      });
  }, [session]);

  return { session, profile, setProfile, loading, profileLoading };
}

export async function signOut() {
  if (supabase) await supabase.auth.signOut();
}
