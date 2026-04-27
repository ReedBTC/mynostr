import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { nip19 } from 'nostr-tools'
import { Z } from '../../../../lib/zIndex.js'
import { copyToClipboard } from '../../../../lib/utils.js'
import {
  KIND_PRODUCT,
  buildProductCoord,
} from '../../../../lib/gamma.js'
import { useWatchlist } from '../../../../lib/useWatchlist.js'

/**
 * Three-dot action menu for a product card.
 *
 * Items:
 *   • Add to / Remove from watchlist (toggle — only visible when the
 *     session user has a signer)
 *   • Copy naddr
 *   • Copy URL (njump.me/{naddr})
 *   • View on Plebeian Market — uses raw event.id, opens new tab
 *   • View on Shopstr        — uses naddr, opens new tab
 *
 * Portaled positioning with bottom-flip behavior (so a card near the
 * viewport bottom doesn't have its menu clipped). Same pattern as
 * ArticleActionsMenu — see comments there for the full reasoning.
 *
 * The watchlist hook here is scoped to the SESSION user so the toggle
 * mutates *your* watchlist regardless of which user's product feed
 * you're looking at.
 */
export default function ProductActionsMenu({
  open,
  onClose,
  listing,
  sessionUser,
  triggerRef,
}) {
  const sessionPubkey = sessionUser?.pubkey || null
  const { has, add, remove, pending } = useWatchlist(sessionPubkey)

  const [menuPos, setMenuPos] = useState(null)
  const [copied,  setCopied]  = useState(null)  // 'naddr' | 'url' | null

  // Compute portal position with bottom-flip (matches ArticleActionsMenu).
  useEffect(() => {
    if (!open || !triggerRef?.current) { setMenuPos(null); return }
    const rect = triggerRef.current.getBoundingClientRect()
    const ESTIMATED_HEIGHT = 240
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    const flipAbove  = spaceBelow < ESTIMATED_HEIGHT && spaceAbove > spaceBelow
    const maxHeight  = Math.max(120, (flipAbove ? spaceAbove : spaceBelow) - 8)
    setMenuPos(flipAbove
      ? { bottom: window.innerHeight - rect.top + 4, right: window.innerWidth - rect.right, maxHeight }
      : { top: rect.bottom + 4, right: window.innerWidth - rect.right, maxHeight })
    function dismiss() { onClose?.() }
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [open, triggerRef, onClose])

  if (!open) return null
  if (triggerRef && !menuPos) return null

  const eventId = listing.event.id
  const aTag    = buildProductCoord(listing.event.pubkey, listing.decoded.dTag)
  const naddr   = (() => {
    try {
      return nip19.naddrEncode({
        kind:       KIND_PRODUCT,
        pubkey:     listing.event.pubkey,
        identifier: listing.decoded.dTag,
      })
    } catch { return null }
  })()

  const inWatchlist  = aTag ? has(aTag) : false
  const canWatchlist = !!sessionPubkey && !!aTag

  async function handleCopy(kind) {
    if (!naddr) return
    const text = kind === 'url' ? `https://njump.me/${naddr}` : naddr
    const ok = await copyToClipboard(text)
    if (!ok) return
    setCopied(kind)
    setTimeout(() => { setCopied(null); onClose?.() }, 1200)
  }

  async function handleWatchlistToggle() {
    if (!canWatchlist || pending) return
    if (inWatchlist) await remove(aTag)
    else             await add(aTag)
    onClose?.()
  }

  const menuContent = (
    <div
      data-product-actions-menu="true"
      className={
        triggerRef
          ? `fixed bg-neutral-800 border border-neutral-700 rounded shadow-xl ${Z.portaledMenu} w-[220px] overflow-y-auto`
          : `absolute right-0 top-full mt-1 bg-neutral-800 border border-neutral-700 rounded shadow-xl z-30 w-[220px] overflow-y-auto`
      }
      style={triggerRef ? menuPos : undefined}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      {/* Watchlist toggle — only when there's a session signer to use */}
      {canWatchlist && (
        <button
          onClick={handleWatchlistToggle}
          disabled={pending}
          className={`w-full text-left px-3 py-2 text-xs transition-colors disabled:opacity-50 ${
            inWatchlist
              ? 'text-amber-300 hover:bg-amber-950/30'
              : 'text-neutral-300 hover:bg-neutral-700'
          }`}
        >
          {pending
            ? '…'
            : inWatchlist
              ? '★ Remove from watchlist'
              : '☆ Add to watchlist'}
        </button>
      )}

      {/* Copy naddr / URL */}
      {naddr && (
        <>
          {canWatchlist && <div className="border-t border-neutral-700" />}
          <button
            onClick={() => handleCopy('naddr')}
            className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
          >
            {copied === 'naddr' ? '✓ Copied!' : 'Copy naddr'}
          </button>
          <button
            onClick={() => handleCopy('url')}
            className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
          >
            {copied === 'url' ? '✓ Copied!' : 'Copy URL'}
          </button>
        </>
      )}

      {/* External views */}
      {(eventId || naddr) && <div className="border-t border-neutral-700" />}
      {eventId && (
        <a
          href={`https://plebeian.market/products/${eventId}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => onClose?.()}
          className="block w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
        >
          View on Plebeian Market ↗
        </a>
      )}
      {naddr && (
        <a
          href={`https://shopstr.store/listing/${naddr}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => onClose?.()}
          className="block w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
        >
          View on Shopstr ↗
        </a>
      )}
    </div>
  )

  return triggerRef ? createPortal(menuContent, document.body) : menuContent
}
