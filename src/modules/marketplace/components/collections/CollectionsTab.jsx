import { useEffect, useState } from 'react'
import { useCollections } from '../../../../lib/useCollections.js'
import { isSafeUrl } from '../../../../lib/utils.js'
import { WATCHLIST_D_TAG } from '../../../../lib/gamma.js'
import CollectionView from './CollectionView.jsx'
import CollectionEditModal from './CollectionEditModal.jsx'

/**
 * CollectionsTab — top-level component for the Collections subtab.
 *
 * Two states owned by `selectedDTag`:
 *   • null  → list view: cards for every collection (watchlist pinned
 *             at top), "+ New" button (owner only)
 *   • dTag  → CollectionView for that specific collection
 *
 * On a visitor's profile, the watchlist may not exist as a fetched
 * event yet (no one's added anything to it). We surface a fallback
 * empty card so it's still navigable to demonstrate the affordance.
 * On an owner's page, "+ New" + the auto-create-on-add behavior cover
 * collection creation.
 */
export default function CollectionsTab({ user, sessionUser, isOwner }) {
  const targetPubkey = user?.pubkey || null
  const collectionsHook = useCollections(targetPubkey)
  const { collections, loading, error, reload, createCollection } = collectionsHook

  const [selectedDTag, setSelectedDTag] = useState(null)
  const [createOpen, setCreateOpen] = useState(false)

  // If the selected collection vanishes (deleted, or the hook re-fetched
  // and dropped it), bounce back to the list view. Doing this in an
  // effect keeps the recovery out of the render phase.
  useEffect(() => {
    if (selectedDTag && !collections.some(c => c.decoded.dTag === selectedDTag)) {
      setSelectedDTag(null)
    }
  }, [selectedDTag, collections])

  if (!targetPubkey) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-neutral-500 text-sm">
        No collections to show.
      </div>
    )
  }

  // Detail mode — render the selected collection. If it's not present
  // we fall through to list view; the effect above will null out
  // selectedDTag so the next render is consistent.
  if (selectedDTag) {
    const selected = collections.find(c => c.decoded.dTag === selectedDTag)
    if (selected) {
      return (
        <CollectionView
          collection={selected}
          user={user}
          sessionUser={sessionUser}
          isOwner={isOwner}
          collectionsHook={collectionsHook}
          onBack={() => setSelectedDTag(null)}
        />
      )
    }
  }

  // Make sure the watchlist is always renderable in the list, even if
  // the user has never created one yet. We synthesize a placeholder
  // entry with empty refs; clicking it opens an empty CollectionView
  // that the owner can edit / start adding to.
  const hasWatchlist = collections.some(c => c.decoded.dTag === WATCHLIST_D_TAG)
  const listEntries = hasWatchlist
    ? collections
    : [
        {
          // No event yet — the placeholder will be replaced on first
          // edit/add by the live one from the hook.
          event: null,
          decoded: {
            dTag: WATCHLIST_D_TAG,
            title: 'Watchlist',
            summary: '',
            image: '',
            productRefs: [],
            shippingOptionRefs: [],
            tTags: [],
            _extraTags: [],
          },
        },
        ...collections,
      ]

  async function handleCreate(patch) {
    const r = await createCollection(patch)
    if (r.ok && r.dTag) setSelectedDTag(r.dTag)
    return r
  }

  return (
    <div className="h-full flex flex-col">
      {/* Top bar — count + actions */}
      <div className="flex-shrink-0 px-4 pt-3 pb-2">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
          <div className="text-xs text-neutral-500">
            {loading
              ? 'Loading…'
              : `${listEntries.length} collection${listEntries.length === 1 ? '' : 's'}`}
          </div>
          <div className="flex items-center gap-2">
            {isOwner && (
              <button
                onClick={() => setCreateOpen(true)}
                className="text-xs px-2.5 py-1 rounded border border-purple-800 text-purple-300 hover:text-purple-100 hover:border-purple-600 transition-colors"
              >
                + New collection
              </button>
            )}
            <button
              onClick={reload}
              disabled={loading}
              className="text-xs px-2.5 py-1 rounded border border-neutral-800 text-neutral-500 hover:text-neutral-300 hover:border-neutral-600 transition-colors disabled:opacity-40"
            >
              {loading ? '…' : 'Refresh'}
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-5xl mx-auto px-4 pb-6">
          {error && <p className="text-xs text-red-400 mb-3">{error}</p>}

          {!loading && listEntries.length === 0 && (
            <EmptyState isOwner={isOwner} />
          )}

          {listEntries.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {listEntries.map(c => (
                <CollectionListCard
                  key={c.decoded.dTag}
                  collection={c}
                  onOpen={() => setSelectedDTag(c.decoded.dTag)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {createOpen && (
        <CollectionEditModal
          mode="create"
          onClose={() => setCreateOpen(false)}
          onSave={handleCreate}
        />
      )}
    </div>
  )
}

function CollectionListCard({ collection, onOpen }) {
  const { decoded } = collection
  const isWatchlist = decoded.dTag === WATCHLIST_D_TAG
  const safeCover = decoded.image && isSafeUrl(decoded.image) ? decoded.image : null
  const itemCount = (decoded.productRefs || []).length

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col text-left bg-neutral-900 border border-neutral-800 rounded overflow-hidden hover:border-neutral-600 transition-colors"
    >
      <div className="aspect-[5/2] w-full bg-neutral-800 relative overflow-hidden">
        {safeCover ? (
          <img
            src={safeCover}
            alt=""
            loading="lazy"
            className="w-full h-full object-cover"
            onError={(e) => { e.currentTarget.style.opacity = '0.2' }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-3xl text-neutral-700">
            {isWatchlist ? '☆' : '📦'}
          </div>
        )}
        {isWatchlist && (
          <span className="absolute top-2 left-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-900/70 text-amber-200 border border-amber-700">
            Watchlist
          </span>
        )}
      </div>

      <div className="flex-1 p-2.5 space-y-0.5">
        <h3 className="text-sm font-medium text-neutral-100 line-clamp-1 leading-snug">
          {decoded.title || (isWatchlist ? 'Watchlist' : 'Untitled collection')}
        </h3>
        {decoded.summary && (
          <p className="text-xs text-neutral-500 line-clamp-1">{decoded.summary}</p>
        )}
        <p className="text-xs text-neutral-600">
          {itemCount} item{itemCount === 1 ? '' : 's'}
        </p>
      </div>
    </button>
  )
}

function EmptyState({ isOwner }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <span className="text-4xl mb-3" aria-hidden>📦</span>
      <p className="text-sm text-neutral-300 mb-1">No collections yet</p>
      <p className="text-xs text-neutral-500 max-w-sm">
        {isOwner
          ? 'Click "+ New collection" to create one, or add a listing to your watchlist from any product page.'
          : 'This user hasn\'t created any collections yet.'}
      </p>
    </div>
  )
}
