"use client";
// 운영 설정 — 런타임 기능 토글. (다음 배포에서 활성화)
import Placeholder from "../Placeholder";
export default function SettingsPage() {
  return (
    <Placeholder title="운영 설정"
      lines={[
        "무배포로 켜고 끌 수 있는 운영 기능 토글이 여기 모여요.",
        "인증·역할·권한 같은 보안 경계는 여기서 바꾸지 않아요(코드/DB가 판정).",
        "광고·외부발신처럼 법적·외부 효과가 있는 토글은 별도 등급으로 분리돼요.",
      ]} />
  );
}
