/**
 * WotModule — Module 9 (Week 13)
 * Web of Trust score from multiple public algos (Coracle, Nos, etc.).
 * Shows score, rank, what each algo considers, and concrete improvement tips.
 * Stretch goal: follow graph visualizer.
 */
export default function WotModule() {
  return <ComingSoon module="Web of Trust" week="13" description="Your WoT score from multiple public algorithms. See what affects your score and get concrete tips to improve it." />
}

function ComingSoon({ module, week, description }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 h-full gap-4 px-8 text-center">
      <span className="text-4xl">🌐</span>
      <h2 className="text-lg font-semibold text-neutral-200">{module}</h2>
      <p className="text-sm text-neutral-500 max-w-sm">{description}</p>
      <span className="text-xs text-neutral-700 border border-neutral-800 rounded px-2 py-0.5">Week {week}</span>
    </div>
  )
}
