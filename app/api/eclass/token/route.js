// ─────────────────────────────────────────────────────────────
//  e-Class(무들) 로그인 토큰 발급 "중계소" (주소: /api/eclass/token)
//
//  ⚠️ 개인정보 관련 중요 안내 (코드로 증명)
//  - 이 서버는 여러분의 아이디·비밀번호를 "저장"하지 않습니다.
//  - 이 서버는 여러분의 아이디·비밀번호를 "기록(로그)"하지 않습니다.
//  - 하는 일은 단 하나: 받은 아이디/비밀번호를 학교 e-Class 서버
//    (login/token.php)로 "그대로 전달"하고, 학교가 돌려준 '이용권(토큰)'만
//    여러분 브라우저로 넘겨줍니다.
//  - 이 함수가 끝나는 순간 아이디·비밀번호는 메모리에서 사라집니다.
//    (변수에만 잠깐 담겼다가 함수 종료와 함께 소멸 — DB·파일·로그 어디에도 안 남음)
//  - 비밀번호가 URL(주소)에 남지 않도록 GET이 아닌 POST 본문으로 전달합니다.
//
//  이 파일은 공개되어 있어 누구나 확인할 수 있습니다: github.com/ttako88/snueapp
// ─────────────────────────────────────────────────────────────

const ECLASS_TOKEN_URL = "https://lms.snue.ac.kr/login/token.php";

export async function POST(request) {
  try {
    const { username, password } = await request.json();
    if (!username || !password) {
      return Response.json({ error: "아이디와 비밀번호를 입력해 주세요." }, { status: 400 });
    }

    // 학교 무들에 토큰 요청. (비밀번호를 주소가 아닌 '본문'에 담아 전송)
    const res = await fetch(ECLASS_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0",
      },
      body: new URLSearchParams({
        username,
        password,
        service: "moodle_mobile_app",
      }),
      cache: "no-store",
    });
    const data = await res.json();

    if (data.token) {
      // 성공: '이용권(토큰)'만 돌려줌. 비밀번호는 여기서 끝. (privatetoken 등은 안 넘김)
      return Response.json({ token: data.token });
    }

    // 로그인 실패 (아이디/비번 오류 등) — 학교가 준 메시지를 그대로 전달
    return Response.json(
      { error: data.error || "로그인에 실패했어요. 아이디·비밀번호를 확인해 주세요." },
      { status: 401 }
    );
  } catch (err) {
    // 네트워크/파싱 오류 (비밀번호는 로그하지 않음)
    return Response.json(
      { error: "e-Class 연결 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요." },
      { status: 502 }
    );
  }
}
