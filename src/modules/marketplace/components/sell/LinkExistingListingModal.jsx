import { useEffect, useState } from 'react'
import { nip19 } from 'nostr-tools'
import { Z } from '../../../../lib/zIndex.js'
import { isSafeUrl } from '../../../../lib/utils.js'
import { formatAmount } from '../../../../lib/currency.js'
import { useSelling } from '../../../../lib/useSelling.js'
import { KIND_PRODUCT } from '../../../../lib/gamma.js'

/**
 * LinkExistingListingModal — pick one of the session user's already-
 * published kind-30402 listings to link the current draft to. Linking
 * sets the draft's `dTag` to the chosen listing's dTag, which means
 * publishing the draft will replace that listing on Nostr (kind 30402
 * is replaceable per (kind, pubkey, dTag)).
 *
 * Two entry points:
 *   • Pick from the user's listings — fetched on mount via useSelling.
 *   • Paste an naddr — escape hatch for listings the fetch missed
 *     (e.g., on private relays not in the default pool).
 *
 * The modal does NOT fetch the linked listing's content into the
 * draft — that's the "Edit listing" flow on the listing card itself.
 * Linking is a pure identity-attachment: keep the draft's content,
 * adopt the existing listing's dTag.
 */
export default function LinkExistingListingModal({ sessionUser, currentDTag = '', onSelect, onClose }) {
  const sessionPubkey = sessionUser?.pubkey || null
  const { listings, loading, error } = useSelling(sessionPubkey)

  const [naddrInput, setNaddrInput] = useState('')
  const [naddrError, setNaddrError] = useState('')

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleNaddrSubmit(e) {
    e.preventDefault()
    setNaddrError('')
    const input = naddrInput.trim()
    if (!input) return
    try {
      const decoded = nip19.decode(input)
      if (decoded.type === 'naddr') {
        if (decoded.data.kind !== KIND_PRODUCT) {
          setNaddrError(`Not a kind 30402 listing (got kind ${decoded.data.kind}).`)
          return
        }
        if (decoded.data.pubkey !== sessionPubkey) {
          setNaddrError('That naddr belongs to a different author. You can only replace your own listings.')
          return
        }
        onSelect({ dTag: decoded.data.identifier, title: '' })
        return
      }
      setNaddrError('Paste a kind-30402 naddr1… string.')
    } catch {
      setNaddrError('Could not decode that as an naddr.')
    }
  }

  return (
    <div
      className={`fixed inset-0 ${Z.modal} bg-black/60 flex items-center justify-center p-4`}
      onMouseDown={onClose}
    >
      <div
        className={`bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col overflow-hidden ${Z.modalContent}`}
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 flex-shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-neutral-200">Link to existing listing</h2>
            <p className="text-[11px] text-neutral-500 mt-0.5">
              Choose a published listing whose Nostr identity this draft should adopt. Publishing the draft will replace that listing.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-200 transition-colors text-xl leading-none p-1.5 -m-1.5"
            aria-label="Close"
          >✕</button>
        </div>

        {/* naddr paste — escape hatch */}
        <form
          onSubmit={handleNaddrSubmit}
          className="flex items-center gap-2 px-4 py-3 border-b border-neutral-800 flex-shrink-0"
        >
          <input
            type="text"
            value={naddrInput}
            onChange={(e) => { setNaddrInput(e.target.value); if (naddrError) setNaddrError('') }}
            placeholder="Paste an naddr1…"
            className="flex-1 bg-neutral-950 border border-neutral-800 rounded px-2.5 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500"
          />
          <button
            type="submit"
            disabled={!naddrInput.trim()}
            className="text-xs px-2.5 py-1.5 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 transition-colors disabled:opacity-40"
          >
            Link
          </button>
        </form>
        {naddrError && (
          <p className="text-xs text-red-400 px-4 pt-2">{naddrError}</p>
        )}

        {/* List of user's listings */}
        <div className="flex-1 overflow-auto">
          {!sessionPubkey && (
            <p className="text-xs text-neutral-500 px-4 py-6 text-center">
              Sign in to see your listings.
            </p>
          )}
          {sessionPubkey && loading && (
            <p className="text-xs text-neutral-500 px-4 py-6 text-center">Loading your listings…</p>
          )}
          {sessionPubkey && error && (
            <p className="text-xs text-red-400 px-4 py-6">{error}</p>
          )}
          {sessionPubkey && !loading && !error && listings.length === 0 && (
            <p className="text-xs text-neutral-500 px-4 py-6 text-center">
              No published listings found. Use the naddr field above for a listing on a private relay, or cancel and publish this draft as a new listing.
            </p>
          )}
          {sessionPubkey && !loading && !error && listings.length > 0 && (
            <ul className="divide-y divide-neutral-800">
              {listings.map(l => (
                <ListingRow
                  key={l.event.id}
                  listing={l}
                  isCurrent={!!currentDTag && l.decoded.dTag === currentDTag}
                  onPick={() => onSelect({ dTag: l.decoded.dTag, title: l.decoded.title || '' })}
                />
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-4 py-3 border-t border-neutral-800 flex justify-end">
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function ListingRow({ listing, isCurrent = false, onPick }) {
  const { decoded } = listing
  const cover = decoded.images?.[0]?.url
  const safeCover = cover && isSafeUrl(cover) ? cover : null
  const price = decoded.price?.amount && Number.isFinite(decoded.price.amount) && decoded.price.amount > 0
    ? formatAmount(decoded.price.amount, decoded.price.currency || 'SATS')
    : ''

  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className={`w-full flex items-start gap-3 px-4 py-2.5 transition-colors text-left ${
          isCurrent
            ? 'bg-blue-950/25 hover:bg-blue-950/40'
            : 'hover:bg-neutral-800/60'
        }`}
      >
        <div className="flex-shrink-0 w-10 h-10 rounded bg-neutral-800 border border-neutral-700 overflow-hidden flex items-center justify-center text-neutral-600">
          {safeCover ? (
            <img src={safeCover} alt="" className="w-full h-full object-cover"
              onError={(e) => { e.currentTarget.style.display = 'none' }} />
          ) : (
            <span className="text-sm" aria-hidden>🛒</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-xs text-neutral-200 truncate flex-1 min-w-0">
              {decoded.title || 'Untitled listing'}
            </p>
            {isCurrent && (
              <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-900/60 text-blue-200 border border-blue-800 flex-shrink-0">
                Currently linked
              </span>
            )}
          </div>
          {price && (
            <p className="text-[10px] text-neutral-500 mt-0.5 truncate">{price}</p>
          )}
          <p className="text-[10px] text-neutral-600 mt-0.5 font-mono truncate">
            d:{decoded.dTag}
          </p>
        </div>
      </button>
    </li>
  )
}
