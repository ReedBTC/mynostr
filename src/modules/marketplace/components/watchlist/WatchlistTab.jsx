import { useEffect, useState } from 'react'
import { getNDK, connectAndWait } from '../../../../lib/ndk.js'
import { withTimeout, isSafeUrl } from '../../../../lib/utils.js'
import { useWatchlist } from '../../../../lib/useWatchlist.js'
import {
  parseCoord,
  decodeProduct,
  KIND_PRODUCT,
} from '../../../../lib/gamma.js'
import ProductCard from '../selling/ProductCard.jsx'
import ProductDrawer from '../selling/ProductDrawer.jsx'
import WatchlistEditModal from './WatchlistEditModal.jsx'

/**
 * WatchlistTab — renders the viewed user's watchlist (kind 30405 with
 * d:watchlist) as a grid of ProductCards.
 *
 * Resolution flow:
 *   1. useWatchlist gets the productRefs ("30402:pubkey:dtag" strings)
 *   2. Each ref is fetched in parallel from relays for its underlying
 *      kind 30402 event
 *   3. Successfully-resolved products render as ProductCards; refs
 *      whose products are unavailable (deleted, never propagated, or
 *      relay timeout) are counted into a small "N items unavailable"
 *      footer rather than auto-removed from the watchlist — preserving
 *      the user's intent in case they want to clean up manually.
 *
 * The watchlist is the *viewed* user's; "Add to watchlist" elsewhere
 * mutates the session user's. So on someone else's profile this tab
 * is read-only by nature; on your own page, edits made via the
 * ProductDrawer (Remove from watchlist) reflect here on next reload.
 */
export default function WatchlistTab({ user, sessionUser, isOwner }) {
  const targetPubkey = user?.pubkey || null
  const { productRefs, metadata, loading, error, reload, updateMetadata } = useWatchlist(targetPubkey)

  const [resolved, setResolved] = useState([])     // [{ event, decoded }]
  const [unavailableCount, setUnavailableCount] = useState(0)
  const [resolving, setResolving] = useState(false)
  const [openListing, setOpenListing] = useState(null)
  const [editOpen, setEditOpen] = useState(false)

  useEffect(() => {
    if (!productRefs || productRefs.length === 0) {
      setResolved([])
      setUnavailableCount(0)
      return
    }
    let cancelled = false
    setResolving(true)
    ;(async () => {
      const ndk = getNDK()
      await connectAndWait(ndk, 3000).catch(() => {})

      // Parallel fetch — NDK may dedupe by relay socket, so issuing many
      // small filters is fine. Each fetch is timeout-bounded so a slow
      // relay can't block the whole grid.
      const results = await Promise.all(productRefs.map(async (ref) => {
        const parsed = parseCoord(ref)
        if (!parsed || parsed.kind !== KIND_PRODUCT) return null
        try {
          const events = await withTimeout(
            ndk.fetchEvents({
              kinds:    [KIND_PRODUCT],
              authors:  [parsed.pubkey],
              '#d':     [parsed.dTag],
            }),
            6000,
            'fetch-timeout',
          )
          // Replaceable kind — pick newest by created_at if multiple.
          let latest = null
          for (const ev of events) {
            if (!latest || (ev.created_at || 0) > (latest.created_at || 0)) latest = ev
          }
          if (!latest) return null
          const decoded = decodeProduct(latest)
          if (!decoded) return null
          return { event: latest, decoded }
        } catch {
          return null
        }
      }))
      if (cancelled) return

      const out = results.filter(Boolean)
      const missing = results.length - out.length
      // Order by watchlist insertion order (the order productRefs has
      // them) — we map results 1:1 to refs, so just keep the existing
      // order minus the nulls.
      setResolved(out)
      setUnavailableCount(missing)
      setResolving(false)
    })()
    return () => { cancelled = true }
  }, [productRefs])

  // Re-resolve the open listing from the live array so a remove via the
  // drawer reflects without a re-click. If the listing is no longer in
  // the watchlist (user removed via drawer), close the drawer.
  const liveOpenListing = openListing
    ? resolved.find(l => l.decoded.dTag === openListing.decoded.dTag) || null
    : null

  if (!targetPubkey) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-neutral-500 text-sm">
        No watchlist to show.
      </div>
    )
  }

  const totalLoading = loading || resolving
  const displayTitle = metadata.title || 'Watchlist'
  const safeCover = metadata.image && isSafeUrl(metadata.image) ? metadata.image : null

  return (
    <div className="h-full flex flex-col">
      {/* Top bar — bordered "collection card" containing the optional
          cover banner, title, summary, count, and the Edit/Refresh
          actions. Wrapping the lot in one bordered container makes it
          visually unambiguous that those buttons belong to *this*
          collection, not to the page chrome at large. */}
      <div className="flex-shrink-0 px-4 pt-3 pb-3">
        <div className="max-w-5xl mx-auto border border-neutral-800 rounded-lg overflow-hidden bg-neutral-900/40">
          {safeCover && (
            <img
              src={safeCover}
              alt=""
              className="w-full max-h-32 object-cover bg-neutral-950 block"
              onError={(e) => { e.currentTarget.style.opacity = '0.2' }}
            />
          )}

          <div className="px-3 py-2.5 flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-neutral-200 truncate">{displayTitle}</h2>
              {metadata.summary && (
                <p className="text-xs text-neutral-500 mt-0.5 truncate">{metadata.summary}</p>
              )}
              <p className="text-xs text-neutral-600 mt-0.5">
                {totalLoading
                  ? 'Loading…'
                  : `${resolved.length} item${resolved.length === 1 ? '' : 's'}`}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {isOwner && (
                <button
                  onClick={() => setEditOpen(true)}
                  className="text-xs px-2.5 py-1 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
                >
                  Edit
                </button>
              )}
              <button
                onClick={reload}
                disabled={totalLoading}
                className="text-xs px-2.5 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 transition-colors disabled:opacity-40"
              >
                {totalLoading ? '…' : 'Refresh'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-5xl mx-auto px-4 pb-6">
          {error && (
            <p className="text-xs text-red-400 mb-3">{error}</p>
          )}

          {!totalLoading && resolved.length === 0 && !error && (
            <EmptyState isOwner={isOwner} />
          )}

          {resolved.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {resolved.map(l => (
                <ProductCard
                  key={l.event.id}
                  listing={l}
                  onClick={() => setOpenListing(l)}
                />
              ))}
            </div>
          )}

          {unavailableCount > 0 && (
            <p className="text-xs text-neutral-600 mt-4">
              {unavailableCount} item{unavailableCount === 1 ? '' : 's'} in
              this watchlist couldn't be loaded — the listing may have been
              removed by its author or the relay didn't have a copy.
            </p>
          )}
        </div>
      </div>

      {/* Drawer — same component My Selling uses. The viewed user is NOT
          the listing's author here (watchlist is other people's products),
          so isOwner inside ProductDrawer is false — Edit/Delete suppressed. */}
      {liveOpenListing && (
        <ProductDrawer
          listing={liveOpenListing}
          isOwner={false}
          sessionUser={sessionUser}
          onClose={() => setOpenListing(null)}
        />
      )}

      {/* Edit-metadata modal — owner only. */}
      {editOpen && (
        <WatchlistEditModal
          initialTitle={metadata.title}
          initialSummary={metadata.summary}
          initialImage={metadata.image}
          onClose={() => setEditOpen(false)}
          onSave={updateMetadata}
        />
      )}
    </div>
  )
}

function EmptyState({ isOwner }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <span className="text-4xl mb-3" aria-hidden>☆</span>
      <p className="text-sm text-neutral-300 mb-1">No items in this watchlist</p>
      <p className="text-xs text-neutral-500 max-w-sm">
        {isOwner
          ? 'Open a listing\'s detail view and click "Add to watchlist" to track it.'
          : 'This user hasn\'t added anything to their watchlist yet.'}
      </p>
    </div>
  )
}
