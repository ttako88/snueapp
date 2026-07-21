// 학생 인증 제출 — 브라우저 쪽 절차.
//
// 왜 RPC 직접 호출이 아니라 서버 라우트를 거치는가:
//   begin_verification / finalize_verification 은 service_role 전용이다.
//   학번 HMAC 은 서버 비밀키로 계산해야 하고, 저장 경로도 서버가 정해야
//   남의 영역에 파일을 붙이는 일을 막을 수 있다. 그래서 이 파일은 라우트를
//   호출하는 얇은 층이다.
//
// 학번 원문은 begin 요청 본문으로만 나가고 여기 어디에도 보관하지 않는다.

import { supabase } from "./../supabase/client";
import { authedPost } from "./apiFetch";
import { asBigintParam, invalidIdResult } from "./ids";

export const DOC_TYPES = [
  { code: "student_card", label: "학생증", hint: "실물 학생증 앞면" },
  { code: "smart_id", label: "모바일 학생증", hint: "앱 화면 캡처" },
  { code: "enrollment_cert", label: "재학증명서", hint: "발급 3개월 이내" },
  { code: "leave_cert", label: "학적증명서", hint: "휴학·복학 등" },
];

export const ACCEPT_MIME = "image/jpeg,image/png,image/webp,application/pdf";
export const MAX_BYTES = 10 * 1024 * 1024;

/** 서버가 주는 사유 코드를 사람이 읽는 말로. 모르는 코드는 그대로 두지 않는다. */
const MESSAGES = {
  unauthorized: "로그인이 풀렸어요. 다시 로그인해 주세요.",
  invalid_input: "입력을 다시 확인해 주세요.",
  student_no_format: "학번은 숫자 8자리예요.",
  student_no_year: "학번 앞 네 자리(입학년도)를 확인해 주세요.",
  real_name_format: "이름을 다시 확인해 주세요.",
  doc_type: "서류 종류를 선택해 주세요.",
  student_no_unverifiable: "이 학번으로는 인증할 수 없어요. 학교 지원으로 문의해 주세요.",
  not_eligible: "지금은 인증을 신청할 수 없는 상태예요.",
  already_in_progress: "이미 진행 중인 신청이 있어요.",
  file_too_large: "파일이 10MB를 넘어요.",
  file_type_not_allowed: "JPG·PNG·WebP·PDF만 올릴 수 있어요.",
  no_file: "파일을 찾지 못했어요. 다시 올려 주세요.",
  not_uploading: "이미 처리된 신청이에요.",
  service_unavailable: "인증 기능이 아직 준비 중이에요.",
  storage_unavailable: "파일 보관소에 연결하지 못했어요.",
};

export function messageFor(code) {
  return MESSAGES[code] ?? "처리하지 못했어요. 잠시 뒤 다시 시도해 주세요.";
}

/**
 * 제출 전 과정. 세 단계 중 어디서 실패했는지 호출부가 알 수 있게
 * step 을 함께 돌려준다.
 */
export async function submitVerification({ realName, studentNo, docType, file }, onStep) {
  if (!(file instanceof File) || file.size === 0) return { error: { code: "no_file" }, step: "file" };
  if (file.size > MAX_BYTES) return { error: { code: "file_too_large" }, step: "file" };

  onStep?.("begin");
  const begun = await authedPost("/api/verification/begin", { realName, studentNo, docType });
  if (begun.error) return { ...begun, step: "begin" };
  const { requestId, bucket, path, token } = begun.data;

  onStep?.("upload");
  const { error: upErr } = await supabase.storage
    .from(bucket)
    .uploadToSignedUrl(path, token, file);
  if (upErr) return { error: { code: "storage_unavailable" }, step: "upload" };

  // 여기서 실패하면 파일은 올라갔지만 신청은 uploading 에 머문다.
  // 24시간 뒤 배치가 정리하고, 그 전에는 사용자가 같은 신청으로 재시도할 수 있다.
  onStep?.("finalize");
  const done = await authedPost("/api/verification/finalize", { requestId });
  if (done.error) return { ...done, step: "finalize", requestId };
  return { data: done.data, step: "done" };
}

/** 업로드까지는 끝났는데 finalize 만 실패한 경우의 재시도 */
export async function retryFinalize(requestId) {
  const id = asBigintParam(requestId);
  if (!id) return invalidIdResult();
  return authedPost("/api/verification/finalize", { requestId: id });
}

// 조회·철회는 이미 verification.js 에 있다. 같은 것을 두 벌 두면 한쪽만
// 고쳐지는 날이 온다. 여기서는 다시 내보내기만 한다.
export { listMyVerificationRequests, withdrawVerification } from "./verification";
