import { useEffect, useState } from 'react'
import { Z } from '../../../../lib/zIndex.js'
import { isSafeUrl } from '../../../../lib/utils.js'
import {
  WATCHLIST_D_TAG,
  buildProductCoord,
} from '../../../../lib/gamma.js'
import { useSessionCollections } from '../../../../lib/sessionCollectionsContext.jsx'
import CollectionEditModal from './CollectionEditModal.jsx'

/**
 * AddToCollectionModal — multi-select picker that lets the user toggle
 * a product's membership across all their collections at once.
 *
 * Differs from the simpler watchlist toggle in `ProductActionsMenu`:
 *   • Watchlist toggle is the one-click quick action (always visible).
 *   • This picker is for "I want to organize this into a specific
 *     named collection beyond just the watchlist."
 *
 * Each row is a checkbox-ish toggle. Clicking flips membership for
 * that collection (add or remove via useCollections.addToCollection /
 * removeFromCollection). Multiple toggles may be queued; we let the
 * hook serialize them via its `pending` flag — UI shows a spinner
 * while any one is in flight, but the user can keep clicking and the
 * actions fire as the previous ones complete.
 *
 * "+ New collection" at the bottom opens CollectionEditModal in
 * create mode, then auto-toggles the new collection on (so the user
 * doesn't have to create-then-click-toggle).
 */
export default function AddToCollectionModal({
  listing,
  // sessionUser is accepted for API symmetry with the other collection
  // surfaces, but the modal reads everything from SessionCollectionsContext.
  // eslint-disable-next-line no-unused-vars
  sessionUser,
  onClose,
}) {
  // Read from the context — provided by MarketplaceModule, shared by
  // every collection-mutation surface, so the picker opens against
  // already-loaded data instead of firing a fresh ndk.fetchEvents
  // round-trip on every open. ctx is null only when the modal is
  // somehow rendered outside the marketplace; in that case we render
  // a friendly empty state.
  const ctx = useSessionCollections()
  const {
    collections,
    loading,
    error,
    pending,
    containingCollections,
    addToCollection,
    removeFromCollection,
    createCollection,
  } = ctx || {
    collections: [],
    loading: false,
    error: null,
    pending: false,
    containingCollections: () => [],
    addToCollection: async () => ({ ok: false, error: 'No session collections context' }),
    removeFromCollection: async () => ({ ok: false, error: 'No session collections context' }),
    createCollection: async () => ({ ok: false, error: 'No session collections context' }),
  }

  const aTag = buildProductCoord(listing.event.pubkey, listing.decoded.dTag)
  const memberOf = aTag ? containingCollections(aTag) : []
  const memberSet = new Set(memberOf)

  const [createOpen, setCreateOpen] = useState(false)

  // Esc closes (when not in flight).
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape' && !pending) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, pending])

  async function toggle(dTag) {
    if (!aTag) return
    if (memberSet.has(dTag)) {
      await removeFromCollection(dTag, aTag)
    } else {
      await addToCollection(dTag, aTag)
    }
  }

  // Sort: watchlist always first, then by created_at (already sorted
  // by the hook).
  const sorted = [...collections].sort((a, b) => {
    if (a.decoded.dTag === WATCHLIST_D_TAG) return -1
    if (b.decoded.dTag === WATCHLIST_D_TAG) return 1
    return 0
  })

  // Synthesize a watchlist row if the user hasn't created one yet —
  // toggling it on triggers auto-create via addToCollection's
  // existing fallback logic.
  const hasWatchlist = sorted.some(c => c.decoded.dTag === WATCHLIST_D_TAG)
  const rows = hasWatchlist
    ? sorted
    : [
        {
          event: null,
          decoded: {
            dTag: WATCHLIST_D_TAG,
            title: 'Watchlist',
            summary: '',
            image: '',
            productRefs: [],
          },
        },
        ...sorted,
      ]

  async function handleCreate(patch) {
    const r = await createCollection({ ...patch, productRefs: aTag ? [aTag] : [] })
    return r
  }

  return (
    <div
      className={`fixed inset-0 ${Z.modal} flex items-center justify-center p-4`}
      onMouseDown={pending ? undefined : onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col overflow-hidden ${Z.modalContent}`}
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 flex-shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-neutral-200">Save to collection</h2>
            <p className="text-[10px] text-neutral-500 truncate max-w-[24ch]">
              {listing.decoded.title || 'Untitled listing'}
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={pending}
            className="text-neutral-500 hover:text-neutral-200 transition-colors text-xl leading-none disabled:opacity-40 p-1.5 -m-1.5"
            aria-label="Close"
          >✕</button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-auto">
          {loading && (
            <p className="text-xs text-neutral-500 px-4 py-6 text-center">Loading collections…</p>
          )}
          {error && (
            <p className="text-xs text-red-400 px-4 py-6">{error}</p>
          )}

          {!loading && !error && (
            <ul className="divide-y divide-neutral-800">
              {rows.map(c => {
                const dTag = c.decoded.dTag
                const isMember = memberSet.has(dTag)
                const isWatchlist = dTag === WATCHLIST_D_TAG
                const cover = c.decoded.image && isSafeUrl(c.decoded.image) ? c.decoded.image : null
                return (
                  <li key={dTag}>
                    <button
                      onClick={() => toggle(dTag)}
                      disabled={pending}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-neutral-800/60 transition-colors disabled:opacity-50 text-left"
                    >
                      {/* Selection indicator — checkmark when member,
                          empty box otherwise. Visually distinct from
                          a real checkbox so the user understands
                          clicking flips it. */}
                      <div className={`flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                        isMember
                          ? 'bg-purple-600 border-purple-600 text-white'
                          : 'border-neutral-600'
                      }`}>
                        {isMember && (
                          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="3">
                            <path d="M3 8.5L6.5 12L13 5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </div>

                      {/* Cover thumb */}
                      <div className="flex-shrink-0 w-9 h-9 rounded bg-neutral-800 border border-neutral-700 overflow-hidden flex items-center justify-center text-neutral-600">
                        {cover ? (
                          <img src={cover} alt="" className="w-full h-full object-cover"
                            onError={(e) => { e.currentTarget.style.display = 'none' }} />
                        ) : (
                          <span className="text-sm" aria-hidden>{isWatchlist ? '☆' : '📦'}</span>
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-neutral-200 truncate">
                          {c.decoded.title || (isWatchlist ? 'Watchlist' : 'Untitled')}
                          {isWatchlist && (
                            <span className="ml-1.5 text-[9px] uppercase tracking-wide text-amber-400/70">
                              default
                            </span>
                          )}
                        </p>
                        {c.decoded.summary && (
                          <p className="text-[10px] text-neutral-500 truncate">{c.decoded.summary}</p>
                        )}
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* Footer — New collection action */}
        <div className="flex-shrink-0 px-4 py-3 border-t border-neutral-800 flex items-center justify-between gap-2">
          <button
            onClick={() => setCreateOpen(true)}
            disabled={pending}
            className="text-xs px-3 py-1.5 rounded border border-purple-800 text-purple-300 hover:text-purple-100 hover:border-purple-600 transition-colors disabled:opacity-40"
          >
            + New collection
          </button>
          <button
            onClick={onClose}
            disabled={pending}
            className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 transition-colors disabled:opacity-40"
          >
            Done
          </button>
        </div>
      </div>

      {createOpen && (
        <CollectionEditModal
          mode="create"
          nested
          onClose={() => setCreateOpen(false)}
          onSave={handleCreate}
        />
      )}
    </div>
  )
}
