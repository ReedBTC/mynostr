import { useMemo, useState } from 'react'
import { useSelling } from '../../../../lib/useSelling.js'
import ProductCard from './ProductCard.jsx'
import ProductDrawer from './ProductDrawer.jsx'

/**
 * SellingTab — feed of the viewed user's kind 30402 listings.
 *
 * Visible to everyone. Owners (viewing their own page) get extra
 * controls inside the ProductDrawer (Edit / Delete); visitors get the
 * external view links + watchlist + zap.
 *
 * Hidden listings are filtered out of the visitor view but visible
 * to owners — same pattern Articles uses for unpublished/hidden
 * states. Sold listings stay visible (with a "Sold" badge); they're
 * part of the seller's history.
 */
export default function SellingTab({
  user,             // viewed user (whose listings we're showing)
  sessionUser,      // signed-in user (or null)
  isOwner,
  onEdit,           // (decoded) — kicks "edit in composer" flow
}) {
  const pubkey = user?.pubkey || null
  const { listings, loading, error, removeLocal, reload } = useSelling(pubkey)

  const visible = useMemo(() => {
    if (isOwner) return listings
    return listings.filter(l => l.decoded.visibility !== 'hidden')
  }, [listings, isOwner])

  const [openListing, setOpenListing] = useState(null)
  // Re-resolve the open listing from the live array so a re-fetch /
  // optimistic update reflects in the drawer without re-clicking.
  const liveOpenListing = useMemo(() => {
    if (!openListing) return null
    return listings.find(l => l.decoded.dTag === openListing.decoded.dTag) || null
  }, [openListing, listings])

  function handleDelete(listing) {
    removeLocal(listing.decoded.dTag)
    setOpenListing(null)
  }

  function handleEdit(listing) {
    onEdit?.(listing)
    setOpenListing(null)
  }

  if (!pubkey) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-neutral-500 text-sm">
        No listings to show.
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Top bar — count + reload button. Reload manually verifies
          relay state after a publish so the user doesn't have to
          tab away and back. */}
      <div className="flex-shrink-0 px-4 pt-3 pb-2">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
          <div className="text-xs text-neutral-500">
            {loading ? 'Loading…' : `${visible.length} listing${visible.length === 1 ? '' : 's'}`}
          </div>
          <button
            onClick={reload}
            disabled={loading}
            className="text-xs px-2.5 py-1 rounded border border-neutral-800 text-neutral-500 hover:text-neutral-300 hover:border-neutral-600 transition-colors disabled:opacity-40"
          >
            {loading ? '…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-5xl mx-auto px-4 pb-6">

          {error && (
            <p className="text-xs text-red-400 mb-3">{error}</p>
          )}

          {!loading && visible.length === 0 && !error && (
            <EmptyState isOwner={isOwner} />
          )}

          {visible.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {visible.map(l => (
                <ProductCard
                  key={l.event.id}
                  listing={l}
                  onClick={() => setOpenListing(l)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {liveOpenListing && (
        <ProductDrawer
          listing={liveOpenListing}
          isOwner={isOwner}
          sessionUser={sessionUser}
          onClose={() => setOpenListing(null)}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />
      )}
    </div>
  )
}

function EmptyState({ isOwner }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <span className="text-4xl mb-3" aria-hidden>🛒</span>
      <p className="text-sm text-neutral-300 mb-1">No listings yet</p>
      <p className="text-xs text-neutral-500 max-w-sm">
        {isOwner
          ? 'Click the Sell tab to publish your first listing.'
          : 'Nothing for sale here right now.'}
      </p>
    </div>
  )
}
