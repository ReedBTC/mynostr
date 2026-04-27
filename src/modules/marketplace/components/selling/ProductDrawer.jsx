import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { nip19 } from 'nostr-tools'
import { Z } from '../../../../lib/zIndex.js'
import { isSafeUrl, parseDateString } from '../../../../lib/utils.js'
import {
  getCachedRates,
  prefetchRates,
  satsToFiat,
  fiatToSats,
  formatAmount,
} from '../../../../lib/currency.js'
import { deleteProduct } from '../../../../lib/deleteProduct.js'
import { KIND_PRODUCT } from '../../../../lib/gamma.js'
import WatchlistButton from '../watchlist/WatchlistButton.jsx'

/**
 * ProductDrawer — full detail view for one listing, opened from a
 * card click in SellingTab (and reused by Watchlist + Search later).
 *
 * Layout: centered modal with backdrop. Header has close + owner
 * actions (Edit / Delete with two-click confirm). Body shows hero
 * image + thumbnail strip (multi-image), title, byline, price (sats
 * + fiat conversion), markdown description, structured fields
 * (specs, location, tags), and "View on Plebeian / Shopstr" external
 * links plus stub Watchlist + Zap buttons (Phase 3 wiring).
 *
 * Keyboard: Esc closes. Click backdrop closes. Click panel does
 * nothing (stopPropagation).
 */
export default function ProductDrawer({
  listing,
  isOwner,
  sessionUser,
  onClose,
  onEdit,            // (listing) — kicks "edit in composer" flow
  onDelete,          // (listing) — confirms removal locally after kind-5 publishes
  previewMode = false,  // true = synthetic listing from draft; suppress publish-only UI
}) {
  const { event, decoded } = listing
  const pubkey = event.pubkey
  const dTag   = decoded.dTag

  // Active hero image index — multi-image listings get a thumbnail
  // strip below the hero that swaps which image is shown big.
  const safeImages = useMemo(
    () => (decoded.images || []).filter(i => i?.url && isSafeUrl(i.url)),
    [decoded.images]
  )
  const [heroIdx, setHeroIdx] = useState(0)
  // Reset hero when the listing changes (e.g. user clicks a different
  // card without closing the drawer first — though we don't currently
  // support that flow, defensive in case it changes).
  useEffect(() => { setHeroIdx(0) }, [event.id])

  // Esc to close.
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // ── Render-time helpers ────────────────────────────────────────────
  const cleanHtml = useMemo(() => {
    if (!decoded.content) return ''
    return DOMPurify.sanitize(marked.parse(decoded.content), {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select', 'button'],
      FORBID_ATTR: ['style'],
    })
  }, [decoded.content])

  const dateStr = decoded.publishedAt
    ? new Date(decoded.publishedAt * 1000).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : event.created_at
      ? new Date(event.created_at * 1000).toLocaleDateString('en-US', {
          year: 'numeric', month: 'long', day: 'numeric',
        })
      : ''

  // External viewers — Plebeian uses raw event id (hex), Shopstr uses naddr.
  const plebeianUrl = `https://plebeian.market/products/${event.id}`
  const naddr = useMemo(() => {
    try {
      return nip19.naddrEncode({
        kind: KIND_PRODUCT,
        pubkey,
        identifier: dTag,
      })
    } catch { return null }
  }, [pubkey, dTag])
  const shopstrUrl = naddr ? `https://shopstr.store/listing/${naddr}` : null

  return (
    <div
      className={`fixed inset-0 ${Z.modal} flex items-center justify-center p-2 sm:p-4`}
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`bg-neutral-950 border border-neutral-700 rounded-lg shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden ${Z.modalContent}`}
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <Header
          isOwner={isOwner && !previewMode}
          listing={listing}
          sessionUser={sessionUser}
          onClose={onClose}
          onEdit={onEdit}
          onDelete={onDelete}
          previewMode={previewMode}
        />

        {/* Body — scrollable */}
        <div className="flex-1 overflow-auto">
          <div className="p-4 sm:p-6 space-y-5">

            {/* Hero image */}
            {safeImages.length > 0 && (
              <div>
                <div className="bg-neutral-900 border border-neutral-800 rounded overflow-hidden">
                  <img
                    src={safeImages[heroIdx].url}
                    alt=""
                    className="w-full max-h-[60vh] object-contain bg-neutral-900"
                    onError={(e) => { e.currentTarget.style.opacity = '0.3' }}
                  />
                </div>

                {/* Thumbnail strip — only when there's more than one */}
                {safeImages.length > 1 && (
                  <div className="flex gap-2 mt-2 overflow-x-auto pb-1">
                    {safeImages.map((img, i) => (
                      <button
                        key={img.url}
                        onClick={() => setHeroIdx(i)}
                        className={`flex-shrink-0 w-14 h-14 rounded border overflow-hidden transition-colors ${
                          i === heroIdx
                            ? 'border-purple-500'
                            : 'border-neutral-800 hover:border-neutral-600'
                        }`}
                        aria-label={`Show image ${i + 1}`}
                      >
                        <img src={img.url} alt="" className="w-full h-full object-cover" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Title + price */}
            <div>
              <h1 className="text-xl sm:text-2xl font-semibold text-neutral-100 leading-tight">
                {decoded.title || 'Untitled listing'}
              </h1>
              {decoded.summary && (
                <p className="text-sm text-neutral-400 mt-1.5">{decoded.summary}</p>
              )}
            </div>

            <PriceBlock price={decoded.price} />

            {/* Status / visibility chips — surfaced in body too so
                viewers don't miss a 'sold' state if they scroll past
                the small badge in the header thumb. */}
            <StatusRow decoded={decoded} />

            {/* Description (markdown) */}
            {cleanHtml && (
              <div
                className="prose prose-invert prose-sm max-w-none text-neutral-200 leading-relaxed"
                dangerouslySetInnerHTML={{ __html: cleanHtml }}
              />
            )}

            {/* Structured fields — only shown when present */}
            <StructuredFields decoded={decoded} dateStr={dateStr} />

            {/* External viewers + watchlist + zap stubs — suppressed in
                preview because the listing isn't published yet (no
                event id for the Plebeian URL, no naddr that resolves). */}
            {!previewMode && (
              <ExternalLinks
                plebeianUrl={plebeianUrl}
                shopstrUrl={shopstrUrl}
                isOwner={isOwner}
                listing={listing}
                sessionUser={sessionUser}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Header (close + owner actions) ────────────────────────────────────────

function Header({ isOwner, listing, sessionUser, onClose, onEdit, onDelete, previewMode = false }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting]                 = useState(false)
  const [deleteError, setDeleteError]           = useState('')
  const confirmTimerRef = useRef(null)

  // Auto-reset the delete-confirm after 4s of inactivity, same UX
  // shape as the Sell composer's discard button.
  useEffect(() => {
    if (!confirmingDelete) return
    confirmTimerRef.current = setTimeout(() => setConfirmingDelete(false), 4000)
    return () => clearTimeout(confirmTimerRef.current)
  }, [confirmingDelete])

  async function handleDeleteClick() {
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      return
    }
    // Belt-and-suspenders — the UI only renders the Delete button when
    // isOwner is true (page-level check), and useSelling filters
    // listings by author, so this should already be guaranteed. But
    // a stale state or future refactor could leak through; fail-fast
    // here saves a wasted signature + rejected publish round-trip
    // (NIP-09 deletions are only honored when kind-5 author matches
    // the deleted-event author).
    if (listing.event.pubkey !== sessionUser?.pubkey) {
      setDeleteError('Only the author can delete this listing.')
      setConfirmingDelete(false)
      return
    }
    setConfirmingDelete(false)
    setDeleting(true)
    setDeleteError('')
    try {
      await deleteProduct({
        pubkey: listing.event.pubkey,
        dTag:   listing.decoded.dTag,
      })
      onDelete?.(listing)
    } catch (e) {
      setDeleteError(e?.message || 'Delete failed')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex items-center gap-2 px-3 sm:px-4 py-2.5 border-b border-neutral-800 flex-shrink-0">
      <span className="text-xs text-neutral-500">{previewMode ? 'Preview' : 'Listing'}</span>
      {previewMode && (
        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-900/50 text-amber-300 border border-amber-800">
          Draft
        </span>
      )}

      {/* Owner actions */}
      {isOwner && (
        <div className="flex items-center gap-1.5 ml-auto mr-2">
          <button
            onClick={() => onEdit?.(listing)}
            disabled={deleting}
            className="text-xs px-2.5 py-1 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 transition-colors disabled:opacity-40"
          >
            Edit
          </button>
          <button
            onClick={handleDeleteClick}
            disabled={deleting}
            className={confirmingDelete
              ? 'text-xs px-2.5 py-1 rounded bg-red-600 hover:bg-red-500 text-white font-semibold transition-colors disabled:opacity-40'
              : 'text-xs px-2.5 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-red-400 hover:border-red-700 transition-colors disabled:opacity-40'}
          >
            {deleting ? 'Deleting…' : confirmingDelete ? 'Click to confirm' : 'Delete'}
          </button>
          {deleteError && <span className="text-xs text-red-400 ml-1 truncate max-w-[14ch]">{deleteError}</span>}
        </div>
      )}

      <button
        onClick={onClose}
        className={`${isOwner ? '' : 'ml-auto '}text-neutral-500 hover:text-neutral-200 transition-colors text-lg leading-none flex-shrink-0`}
        aria-label="Close"
      >
        ✕
      </button>
    </div>
  )
}

// ─── Price (sats + fiat conversion, both prominent) ───────────────────────

function PriceBlock({ price }) {
  const [rates, setRates] = useState(() => getCachedRates())
  useEffect(() => {
    let cancelled = false
    prefetchRates().then(() => {
      if (cancelled) return
      const next = getCachedRates()
      if (next) setRates(next)
    })
    return () => { cancelled = true }
  }, [])

  if (!price || !Number.isFinite(price.amount) || price.amount <= 0) {
    return <p className="text-sm text-neutral-500">No price set</p>
  }

  const primaryCurrency = price.currency || 'SATS'
  const primary = formatAmount(price.amount, primaryCurrency)

  let secondary = null
  if (primaryCurrency === 'SATS') {
    const usd = satsToFiat(price.amount, 'USD', rates)
    if (usd !== null) secondary = formatAmount(usd, 'USD')
  } else {
    const sats = fiatToSats(price.amount, primaryCurrency, rates)
    if (sats !== null) secondary = `${formatAmount(sats, 'SATS')} sats`
  }

  return (
    <div className="flex items-baseline gap-3 flex-wrap">
      <span className="text-2xl font-bold text-purple-300">
        {primary}{primaryCurrency === 'SATS' ? ' sats' : ''}
      </span>
      {secondary && (
        <span className="text-sm text-neutral-500">≈ {secondary}</span>
      )}
    </div>
  )
}

// ─── Status / visibility chips ─────────────────────────────────────────────

function StatusRow({ decoded }) {
  const chips = []
  if (decoded.status === 'sold') {
    chips.push({ label: 'Sold', className: 'bg-red-900/60 text-red-100 border-red-700' })
  }
  if (decoded.visibility === 'hidden') {
    chips.push({ label: 'Hidden', className: 'bg-neutral-800 text-neutral-300 border-neutral-600' })
  }
  if (decoded.visibility === 'pre-order') {
    chips.push({ label: 'Pre-order', className: 'bg-amber-900/60 text-amber-100 border-amber-700' })
  }
  if (chips.length === 0) return null
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {chips.map(c => (
        <span key={c.label} className={`text-xs px-2 py-0.5 rounded border ${c.className}`}>
          {c.label}
        </span>
      ))}
    </div>
  )
}

// ─── Structured fields (specs / location / tags / date) ───────────────────

function StructuredFields({ decoded, dateStr }) {
  const hasSpecs    = (decoded.specs || []).length > 0
  const hasTags     = (decoded.tTags || []).length > 0
  const hasLocation = !!decoded.location
  const hasWeight   = !!decoded.weight
  const hasDim      = !!decoded.dim
  const hasStock    = decoded.stock != null

  if (!hasSpecs && !hasTags && !hasLocation && !hasWeight && !hasDim && !hasStock && !dateStr) {
    return null
  }

  return (
    <div className="border-t border-neutral-800 pt-4 space-y-3 text-sm">
      {hasSpecs && (
        <div>
          <h3 className="text-xs uppercase tracking-wider text-neutral-500 mb-1.5">Specs</h3>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
            {decoded.specs.map((s, i) => (
              <div key={i} className="contents">
                <dt className="text-neutral-500">{s.key}</dt>
                <dd className="text-neutral-200">{s.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {(hasLocation || hasWeight || hasDim || hasStock) && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          {hasLocation && <Field label="Location" value={decoded.location} />}
          {hasStock    && <Field label="Stock"    value={String(decoded.stock)} />}
          {hasWeight   && <Field label="Weight"   value={decoded.weight} />}
          {hasDim      && <Field label="Dimensions" value={decoded.dim} />}
        </div>
      )}

      {hasTags && (
        <div className="flex flex-wrap gap-1.5">
          {decoded.tTags.map(t => (
            <span key={t} className="text-xs px-2 py-0.5 rounded bg-neutral-800 text-neutral-300 border border-neutral-700">
              #{t}
            </span>
          ))}
        </div>
      )}

      {dateStr && (
        <div className="text-xs text-neutral-600">Published {dateStr}</div>
      )}
    </div>
  )
}

function Field({ label, value }) {
  return (
    <div>
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="text-sm text-neutral-200">{value}</div>
    </div>
  )
}

// ─── External links + stubbed watchlist + zap ─────────────────────────────

function ExternalLinks({ plebeianUrl, shopstrUrl, isOwner, listing, sessionUser }) {
  return (
    <div className="border-t border-neutral-800 pt-4 space-y-3">
      <div>
        <h3 className="text-xs uppercase tracking-wider text-neutral-500 mb-1.5">View on another marketplace</h3>
        <p className="text-xs text-neutral-500 mb-2">
          MyNostr doesn't include checkout in the alpha. Open this listing
          on a Nostr marketplace client to contact the seller or buy.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <a
            href={plebeianUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-200 hover:border-neutral-500 hover:bg-neutral-900 transition-colors"
          >
            View on Plebeian Market ↗
          </a>
          {shopstrUrl && (
            <a
              href={shopstrUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-200 hover:border-neutral-500 hover:bg-neutral-900 transition-colors"
            >
              View on Shopstr ↗
            </a>
          )}
        </div>
      </div>

      {/* Watchlist + zap row. Watchlist mutates the SESSION user's
          watchlist (not the listing-author's), so the gate is on
          having a signer — not on whether you're "the owner" of the
          page. Lets you watchlist your own listings too, which is a
          minor edge case but harmless. Zap is still Phase-deferred. */}
      {sessionUser?.pubkey && (
        <div className="flex items-center gap-2 flex-wrap">
          <WatchlistButton listing={listing} sessionUser={sessionUser} />
          <button
            disabled
            title="Coming soon"
            className="text-xs px-3 py-1.5 rounded border border-neutral-800 text-neutral-600 cursor-not-allowed"
          >
            ⚡ Zap author
          </button>
        </div>
      )}
    </div>
  )
}
