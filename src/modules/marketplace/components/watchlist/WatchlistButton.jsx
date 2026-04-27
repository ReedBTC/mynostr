import { useWatchlist } from '../../../../lib/useWatchlist.js'
import { buildProductCoord } from '../../../../lib/gamma.js'

/**
 * WatchlistButton — toggles a product in/out of the session user's
 * kind 30405 watchlist (d:watchlist).
 *
 * Hidden when there's no session user / no signer (read-only sessions
 * can't sign a kind 30405 mutation, so the button would be a footgun).
 *
 * The hook is scoped to the session user's pubkey — adding/removing
 * always mutates *your* watchlist, regardless of which page or
 * product you're looking at. That's the right semantic for a personal
 * tracking list: when on Bob's product, "Add to watchlist" adds Bob's
 * product to Reed's watchlist (not Bob's).
 */
export default function WatchlistButton({ listing, sessionUser }) {
  const sessionPubkey = sessionUser?.pubkey || null
  const { has, add, remove, pending } = useWatchlist(sessionPubkey)

  if (!sessionPubkey) return null

  const aTag = buildProductCoord(listing.event.pubkey, listing.decoded.dTag)
  if (!aTag) return null

  const inList = has(aTag)

  async function handleClick() {
    if (pending) return
    if (inList) await remove(aTag)
    else        await add(aTag)
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
