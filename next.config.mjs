/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        // 인증 서류를 다루는 화면들. 실명·학번·서류 이미지가 지나가는 자리라
        // 공유 PC 의 뒤로가기 캐시나 중간 프록시에 남으면 안 된다.
        // API 응답에는 이미 no-store 를 붙였지만 화면 HTML 은 별개 응답이다.
        source: "/:seg(admin|settings)/:rest*",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
          // 심사 화면이 남의 사이트 프레임 안에서 열리면 클릭재킹으로
          // 승인·반려 버튼을 누르게 만들 수 있다.
          { key: "X-Frame-Options", value: "DENY" },
          // 서류 열람 signed URL 이 Referer 로 외부에 새 나가지 않게.
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
