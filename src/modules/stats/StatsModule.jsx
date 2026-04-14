/**
 * StatsModule — Module 8 (Week 3)
 * Personal Nostr analytics via Primal cache → relay.nostr.band fallback.
 * Zaps sent/received, likes, reposts, comments, note counts by kind.
 * All charts via Recharts with responsive layout and tooltips.
 */
export default function StatsModule() {
  return <ComingSoon module="Stats" week="3" description="Your personal Nostr analytics — zaps, likes, reposts, note counts over time. Powered by Primal + relay.nostr.band." />
}

function ComingSoon({ module, week, description }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 h-full gap-4 px-8 text-center">
      <span className="text-4xl">📊</span>
      <h2 className="text-lg font-semibold text-neutral-200">{module}</h2>
      <p className="text-sm text-neutral-500 max-w-sm">{description}</p>
      <span className="text-xs text-neutral-700 border border-neutral-800 rounded px-2 py-0.5">Week {week}</span>
    </div>
  )
}
