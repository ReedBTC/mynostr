import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { nip19 } from 'nostr-tools'
import { Z } from '../../../../lib/zIndex.js'
import { copyToClipboard, titleToSlug } from '../../../../lib/utils.js'
import {
  KIND_PRODUCT,
  buildProductCoord,
} from '../../../../lib/gamma.js'

/**
 * Three-dot action menu for a product card.
 *
 * Items:
 *   • Add to / Remove from watchlist (toggle — only visible when the
 *     session user has a signer)
 *   • Copy naddr
 *   • Copy URL (mynostr.app/{naddr} — our bech32 resolver decodes
 *     and redirects to the canonical seller's marketplace tab)
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
  onOpenSavePicker,
  onEdit,
}) {
  const sessionPubkey = sessionUser?.pubkey || null
  // Show Edit only when the session user authored this listing — kind
  // 30402 is replaceable per (kind, pubkey, dTag), so editing only makes
  // sense for the original author. Mirrors the gate on the drawer's
  // owner-action row.
  const canEdit = !!onEdit && !!sessionPubkey && sessionPubkey === listing.event.pubkey

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
    // Close on outside click. Items inside the menu have onMouseDown
    // stopPropagation so they don't reach this handler. Trigger button
    // is also excluded so a second click on the same trigger doesn't
    // close-then-reopen in one frame.
    function onDocMouseDown(e) {
      if (triggerRef.current?.contains(e.target)) return
      if (e.target.closest('[data-product-actions-menu]')) return
      onClose?.()
    }
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    document.addEventListener('mousedown', onDocMouseDown)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      document.removeEventListener('mousedown', onDocMouseDown)
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

  // Save-to-collection requires a session signer + a valid product coord.
  const canWatchlist = !!sessionPubkey && !!aTag

  async function handleCopy(kind) {
    if (!naddr) return
    // mynostr's bech32 resolver maps /<naddr> for kind 30402 to the
    // seller's marketplace tab (listings have no detail URL — drawer
    // flow). Still better than njump for our own users; cold readers
    // who want the exact listing UI can paste the same naddr into
    // search. Switch over keeps share links consistent with events
    // and articles.
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    const text = kind === 'url' ? `${origin}/${naddr}` : naddr
    const ok = await copyToClipboard(text)
    if (!ok) return
    setCopied(kind)
    setTimeout(() => { setCopied(null); onClose?.() }, 1200)
  }

  // Web Share API — opens the native share sheet on platforms that
  // support it (iOS Safari, Android Chrome, modern desktop). Lets
  // users send a listing to iMessage, WhatsApp, etc. without the
  // copy-then-paste two-step. Only renders the menu item when the
  // browser supports navigator.share to avoid a dead button.
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  async function handleShare() {
    if (!naddr) return
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    const url = `${origin}/${naddr}`
    const title = listing.decoded?.title || 'Marketplace listing'
    try {
      await navigator.share({ title, url })
    } catch {
      // User canceled or share failed — silent. Nothing to recover.
    }
    onClose?.()
  }

  // Download the raw kind-30402 event JSON. Same shape the Sell
  // composer's Multi-JSON Import accepts, so a downloaded listing
  // round-trips back into a draft cleanly. Available to anyone — the
  // event is already public on relays; this is a convenience download.
  function handleExport() {
    try {
      const json = JSON.stringify(listing.event, null, 2)
      const blob = new Blob([json], { type: 'application/json' })
      const url  = URL.createObjectURL(blob)
      const slug = titleToSlug(listing.decoded?.title || listing.decoded?.dTag || 'listing') || 'listing'
      const a = document.createElement('a')
      a.href = url
      a.download = `${slug}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      // Serialization should never fail on a fetched event, but swallow
      // rather than blow up the menu on a freak input.
    }
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
      {/* Owner-only — load the listing into the Sell composer as a
          fresh draft. Same handler the drawer's Edit button calls. */}
      {canEdit && (
        <button
          onClick={() => { onEdit(listing); onClose?.() }}
          className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
        >
          Edit listing…
        </button>
      )}

      {/* Save-to-collection picker — unified entry point. The
          watchlist is just one collection in the picker; users who
          want one-click "save to watchlist" use the WatchlistButton
          on the product drawer instead. */}
      {canWatchlist && (
        <button
          onClick={() => { onOpenSavePicker?.(); onClose?.() }}
          className={`w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors ${canEdit ? 'border-t border-neutral-700' : ''}`}
        >
          Save to collection…
        </button>
      )}

      {/* Native share — only when the browser supports it. Mobile-
          first: iOS Safari + Android Chrome get an OS share sheet
          (iMessage, WhatsApp, etc.); desktop browsers that support
          navigator.share get the OS share dialog. Falls through to
          copy-paste if the browser doesn't support the API. */}
      {naddr && canNativeShare && (
        <>
          {(canEdit || canWatchlist) && <div className="border-t border-neutral-700" />}
          <button
            onClick={handleShare}
            className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
          >
            Share…
          </button>
        </>
      )}

      {/* Copy naddr / URL */}
      {naddr && (
        <>
          {(canWatchlist || canNativeShare) && <div className="border-t border-neutral-700" />}
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

      {/* Export — raw kind-30402 event JSON. Always available; no
          session required. */}
      <div className="border-t border-neutral-700" />
      <button
        onClick={handleExport}
        className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
      >
        Export JSON
      </button>
    </div>
  )

  // Picker is owned by the parent (ProductCard / ProductDrawer) so it
  // survives this menu unmounting on close — see onOpenSavePicker.
  return triggerRef ? createPortal(menuContent, document.body) : menuContent
}
