import Link from "next/link";

// 개인정보 처리방침 — 분석·수익화 활성화에 맞춘 고지. 실제 시스템 동작과 일치시킨다
// (수집 항목·목적·보관·동의/철회·제3자 미전송). 문구가 바뀌면 CONSENT_VERSION 도 올린다.
export const metadata = { title: "개인정보 처리방침 · 새록이" };

const Sec = ({ t, children }) => (
  <section className="mt-4">
    <h2 className="text-sm font-bold text-[#0c4470]">{t}</h2>
    <div className="mt-1 space-y-1 text-[13px] leading-relaxed text-[#0c4470]/70">{children}</div>
  </section>
);

export default function PrivacyPage() {
  return (
    <div className="px-4 py-5">
      <div className="flex items-center gap-2">
        <Link href="/settings" className="text-sm text-[#0c4470]/50">‹</Link>
        <h1 className="text-base font-bold text-[#0c4470]">개인정보 처리방침</h1>
      </div>
      <p className="mt-2 text-[11px] text-[#0c4470]/40">시행일 2026-07-23 · 서울교대 새록이(비공식 학생 앱)</p>

      <Sec t="1. 수집하는 항목">
        <p>· <b>필수(최소)</b>: 로그인 계정(이메일), 학생 인증 시 실명·학번(중복가입 방지용으로 즉시 HMAC 처리, 원문은 보관하지 않음).</p>
        <p>· <b>익명 이용통계(기본)</b>: 어떤 화면·기능을 썼는지 집계용 이벤트. 개인을 식별하지 않는 <b>집계 카운터</b>로만 저장.</p>
        <p>· <b>상세 이용통계(동의 시에만)</b>: 학번에서 도출한 <b>학과·학년 세그먼트</b>와 무작위 가명 식별자. 학번 원문·실명은 쓰지 않음.</p>
      </Sec>
      <Sec t="2. 이용 목적">
        <p>서비스 품질 개선(어떤 기능이 필요/불필요한지 파악), 오류 파악, 통계. 동의 시 학과·학년별 필요에 맞춘 개선.</p>
      </Sec>
      <Sec t="3. 동의와 철회">
        <p>상세 이용통계·맞춤광고 동의는 <b>기본 꺼짐</b>이며 <Link href="/settings" className="font-bold text-[#0095da]">설정 &gt; 데이터 동의</Link>에서 언제든 켜고 끌 수 있습니다. 상세통계 동의가 광고 동의로 자동 전환되지 않습니다. 맞춤광고는 만 18세 이상만 동의할 수 있습니다.</p>
      </Sec>
      <Sec t="4. 보관과 파기">
        <p>동의 기반 상세 이벤트의 원시 기록은 일정 기간(약 90일) 후 집계로만 남기고 파기합니다. 인증 서류·실명 등은 인증 처리 목적 달성 후 파기합니다.</p>
      </Sec>
      <Sec t="5. 제3자 제공">
        <p>개인을 식별할 수 있는 정보(실명·학번·학번HMAC·회원ID·정확한 학과·학년)는 <b>광고주·외부 분석도구(구글 등)에 제공하지 않습니다.</b> 대시보드·광고 선택은 앱 내부에서만 이뤄지며, 외부에는 집계치만 활용합니다.</p>
      </Sec>
      <Sec t="6. 안전 조치">
        <p>목적별로 식별자를 분리하고, 소수 집단이 드러나지 않도록 집계에 최소 인원(k-익명) 기준을 둡니다.</p>
      </Sec>
      <Sec t="7. 문의">
        <p>앱 설정의 버그제보 또는 운영자에게 문의해 주세요.</p>
      </Sec>
    </div>
  );
}
