// 버그 제보 데이터 접근.
// 시그니처는 운영 카탈로그 확인값이다 — submit_bug_report 는 인자가 5개이고
// 순서가 (category, title, detail, app_path, app_version) 이다.
//
// DB 제약을 화면 쪽에서도 알고 있어야 사용자에게 미리 안내할 수 있다.
// 서버가 거부한 뒤 알 수 없는 오류를 띄우는 것보다 낫다.
//   title  2~100자, 줄바꿈·제어문자 금지
//   detail 5~2000자
//   app_path '/' 로 시작하는 경로 형식

import { supabase } from "../supabase/client";
import { asBigintParam, invalidIdResult } from "./ids";

export const BUG_CATEGORIES = [
  { code: "crash", label: "앱이 멈춰요" },
  { code: "wrong_data", label: "정보가 틀려요" },
  { code: "ui_broken", label: "화면이 깨져요" },
  { code: "login", label: "로그인 문제" },
  { code: "performance", label: "너무 느려요" },
  { code: "suggestion", label: "이런 게 있으면 좋겠어요" },
  { code: "other", label: "기타" },
];

export const BUG_LIMITS = { titleMin: 2, titleMax: 100, detailMin: 5, detailMax: 2000 };

/** 화면에서 미리 거를 수 있는 것은 걸러 알려준다. 통과하면 null. */
export function validateBugReport({ category, title, detail }) {
  if (!BUG_CATEGORIES.some((c) => c.code === category)) return "분류를 골라주세요.";
  const t = (title ?? "").trim();
  const d = (detail ?? "").trim();
  if (t.length < BUG_LIMITS.titleMin || t.length > BUG_LIMITS.titleMax)
    return `제목은 ${BUG_LIMITS.titleMin}~${BUG_LIMITS.titleMax}자로 써주세요.`;
  // DB 제약은 제목에 제어문자를 금지한다.
  // 정규식 리터럴에 제어문자를 넣으면 소스에 보이지 않는 바이트가 박혀
  // 나중에 읽거나 고칠 수 없다. 코드포인트로 직접 본다.
  const hasControl = [...t].some((ch) => {
    const cp = ch.codePointAt(0);
    return (cp >= 1 && cp <= 31) || cp === 127;
  });
  if (hasControl) return "제목에 줄바꿈이나 특수문자를 넣을 수 없어요.";
  if (d.length < BUG_LIMITS.detailMin || d.length > BUG_LIMITS.detailMax)
    return `내용은 ${BUG_LIMITS.detailMin}~${BUG_LIMITS.detailMax}자로 써주세요.`;
  return null;
}

/**
 * 제보 등록. app_path 는 어느 화면에서 눌렀는지 자동 수집하는 값이라
 * 사용자가 입력하지 않는다. '/' 로 시작하지 않으면 아예 보내지 않는다.
 */
export function submitBugReport({ category, title, detail, appPath, appVersion }) {
  const invalid = validateBugReport({ category, title, detail });
  if (invalid) return Promise.resolve({ data: null, error: { message: invalid } });
  const path = typeof appPath === "string" && /^\/[A-Za-z0-9/_\-[\]]{0,100}$/.test(appPath)
    ? appPath : null;
  return supabase.rpc("submit_bug_report", {
    p_category: category,
    p_title: title.trim(),
    p_detail: detail.trim(),
    p_app_path: path,
    p_app_version: appVersion ?? null,
  });
}

export function listMyBugReports() {
  return supabase.rpc("list_my_bug_reports");
}

export function withdrawBugReport(id) {
  const p = asBigintParam(id);
  if (p === null) return Promise.resolve(invalidIdResult());
  return supabase.rpc("withdraw_bug_report", { p_id: p });
}

export const BUG_STATUS_LABEL = {
  open: "접수됨",
  triaged: "확인함",
  in_progress: "고치는 중",
  resolved: "해결됨",
  wont_fix: "고치지 않기로 함",
  duplicate: "중복 제보",
  expired_unattended: "기간 만료",
};
