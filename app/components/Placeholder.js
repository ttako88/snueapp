// "준비 중" 임시 화면. icon/title/desc만 바꿔서 여러 화면에 재사용.
export default function Placeholder({ icon, title, desc }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="text-5xl">{icon}</span>
      <h2 className="text-xl font-bold text-[#0c4470]">{title}</h2>
      <p className="text-sm text-[#0c4470]/50">{desc}</p>
    </div>
  );
}
