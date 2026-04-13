/**
 * BrowseModule — Module 6 (Week 9)
 * Lightweight browser for curated note kinds:
 * bookmarks (10003), highlights (9802), collaborative lists (30000),
 * and community posts (kind 1 filtered by community relay).
 */
export default function BrowseModule() {
  return <ComingSoon module="Browse" week="9" description="Browse your bookmarks, highlights, and collaborative lists. A utility for finding content to reference, repost, or save." />
}

function ComingSoon({ module, week, description }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 h-full gap-4 px-8 text-center">
      <span className="text-4xl">🗂️</span>
      <h2 className="text-lg font-semibold text-neutral-200">{module}</h2>
      <p className="text-sm text-neutral-500 max-w-sm">{description}</p>
      <span className="text-xs text-neutral-700 border border-neutral-800 rounded px-2 py-0.5">Week {week}</span>
    </div>
  )
}
