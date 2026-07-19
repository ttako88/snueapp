"use client"; // 로그인 세션은 브라우저에서만 존재

import { useEffect, useState } from "react";
import { supabase } from "./supabase";

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
    setProfileLoading(true);
    supabase
      .from("profiles")
      .select("id, nickname")
      .eq("id", session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        setProfile(data ?? null);
        setProfileLoading(false);
      });
  }, [session]);

  return { session, profile, setProfile, loading, profileLoading };
}

export async function signOut() {
  if (supabase) await supabase.auth.signOut();
}
