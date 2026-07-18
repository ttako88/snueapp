import "./globals.css";
import Header from "./components/Header";
import BottomNav from "./components/BottomNav";

// 브라우저 탭에 뜨는 제목/설명
export const metadata = {
  title: "서울교대 새록이",
  description: "서울교육대학교 급식·학사일정·공지를 한 곳에서",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body>
        {/* 예쁜 한글 글꼴 Pretendard 불러오기 (CDN) */}
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css"
        />
        {/* 앱 껍데기: 가운데 정렬 + 폰 너비(최대 480px) + 화면 높이 꽉 */}
        <div className="mx-auto flex h-dvh max-w-[480px] flex-col bg-[#f7fafc] shadow-sm">
          {/* 위: 헤더 (고정) */}
          <Header />

          {/* 가운데: 각 화면 내용 (이 부분만 스크롤됨) */}
          <main className="flex-1 overflow-y-auto">{children}</main>

          {/* 아래: 탭바 (고정) */}
          <BottomNav />
        </div>
      </body>
    </html>
  );
}
