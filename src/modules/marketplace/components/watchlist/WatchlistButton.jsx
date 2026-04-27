import { useSessionCollections } from '../../../../lib/sessionCollectionsContext.jsx'
import { buildProductCoord, WATCHLIST_D_TAG } from '../../../../lib/gamma.js'

/**
 * WatchlistButton — toggles a product in/out of the session user's
 * d:watchlist collection.
 *
 * Reads from SessionCollectionsContext (provided by MarketplaceModule)
 * so every WatchlistButton on a product feed shares one fetch instead
 * of firing N parallel queries on render.
 *
 * Hidden when no session pubkey or no provider available — read-only
 * sessions can't sign a kind 30405 mutation, so the button would be
 * a footgun.
 */
export default function WatchlistButton({ listing, sessionUser }) {
  const sessionPubkey = sessionUser?.pubkey || null
  const ctx = useSessionCollections()

  if (!sessionPubkey || !ctx) return null

  const { containingCollections, addToCollection, removeFromCollection, pending } = ctx
  const aTag = buildProductCoord(listing.event.pubkey, listing.decoded.dTag)
  if (!aTag) return null

  const inList = containingCollections(aTag).includes(WATCHLIST_D_TAG)

  async function handleClick() {
    if (pending) return
    if (inList) await removeFromCollection(WATCHLIST_D_TAG, aTag)
    else        await addToCollection(WATCHLIST_D_TAG, aTag)
  }

  return (
    <button
      onClick={handleClick}
      disabled={pending}
      title={inList ? 'Remove from watchlist' : 'Add to watchlist'}
      className={`text-xs px-3 py-1.5 rounded border transition-colors disabled:opacity-40 ${
        inList
          ? 'border-amber-700 text-amber-300 hover:border-amber-600 hover:text-amber-200 bg-amber-950/30'
          : 'border-neutral-700 text-neutral-300 hover:border-neutral-500 hover:text-white'
      }`}
    >
      {pending
        ? '…'
        : inList
          ? '★ On your watchlist'
          : '☆ Add to watchlist'}
    </button>
  )
}
