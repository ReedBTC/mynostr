/**
 * NotesFeed — shared list shell for the My Notes / Bookmarks / Search tabs.
 *
 * All feeds render identically: a vertical list of NoteCards with a sentinel
 * at the bottom that the useInfiniteFeed hook observes to trigger the next
 * page. Callers pass items + profiles + feed state; this component is dumb.
 */
import NoteCard from './NoteCard.jsx'

export default function NotesFeed({
  items,
  profiles,
  loading,
  initialLoading,
  error,
  done,
  sentinelRef,
  emptyMessage = 'No notes to show yet.',
  header = null,
  onReload,
  inBookmarksFeed = false,
  onNoteClick,
  selectMode = false,
  selectedIds,
  onToggleSelect,
}) {
  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden">
      <div className="max-w-xl mx-auto px-4 py-4">
        {header}

        {initialLoading && items.length === 0 && (
          <div className="py-10 text-center">
            <span className="inline-block w-5 h-5 border-2 border-neutral-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-xs text-neutral-500 mt-2">Loading notes…</p>
          </div>
        )}

        {!initialLoading && error && items.length === 0 && (
          <div className="py-10 text-center">
            <p className="text-xs text-red-400 mb-2">{error}</p>
            {onReload && (
              <button
                onClick={onReload}
                className="text-[11px] text-purple-400 hover:text-purple-300 underline"
              >
                Try again
              </button>
            )}
          </div>
        )}

        {!initialLoading && !error && items.length === 0 && (
          <div className="py-10 text-center">
            <p className="text-xs text-neutral-500">{emptyMessage}</p>
          </div>
        )}

        {items.length > 0 && (
          <ul className="space-y-3">
            {items.map(note => (
              <li key={note.id}>
                <NoteCard
                  note={note}
                  profile={profiles.get(note.pubkey)}
                  inBookmarksFeed={inBookmarksFeed}
                  onNoteClick={onNoteClick}
                  selectable={selectMode}
                  selected={selectMode && !!selectedIds?.has(note.id)}
                  onToggleSelect={onToggleSelect}
                />
              </li>
            ))}
          </ul>
        )}

        {/* Sentinel — observed by useInfiniteFeed to trigger page N+1 */}
        {!done && items.length > 0 && (
          <div ref={sentinelRef} className="py-4 text-center">
            {loading ? (
              <span className="inline-block w-4 h-4 border-2 border-neutral-500 border-t-transparent rounded-full animate-spin" />
            ) : (
              <span className="text-[10px] text-neutral-600">Scroll for more…</span>
            )}
          </div>
        )}

        {done && items.length > 0 && (
          <div className="py-6 text-center">
            <p className="text-[10px] text-neutral-600">You've reached the end.</p>
          </div>
        )}
      </div>
    </div>
  )
}
