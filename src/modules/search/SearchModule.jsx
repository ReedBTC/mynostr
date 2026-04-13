/**
 * SearchModule — Module 7 (Week 10–11)
 * Full-text search via Primal cache → relay.nostr.band (NIP-50) fallback.
 * Filter by kind, date range; sort by newest/likes/zaps/reposts.
 * Export results as JSON or formatted markdown. Infinite virtual scroll.
 */
export default function SearchModule() {
  return <ComingSoon module="Search" week="10–11" description="Full-text search across your notes. Filter by kind and date range. Export as JSON or markdown. Infinite virtual scroll." />
}

function ComingSoon({ module, week, description }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 h-full gap-4 px-8 text-center">
      <span className="text-4xl">🔍</span>
      <h2 className="text-lg font-semibold text-neutral-200">{module}</h2>
      <p className="text-sm text-neutral-500 max-w-sm">{description}</p>
      <span className="text-xs text-neutral-700 border border-neutral-800 rounded px-2 py-0.5">Week {week}</span>
    </div>
  )
}
