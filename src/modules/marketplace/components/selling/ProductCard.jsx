import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { nip19 } from 'nostr-tools'
import { isSafeUrl } from '../../../../lib/utils.js'
import {
  getCachedRates,
  prefetchRates,
  satsToFiat,
  fiatToSats,
  formatAmount,
} from '../../../../lib/currency.js'
import ProductActionsMenu from './ProductActionsMenu.jsx'
import AddToCollectionModal from '../collections/AddToCollectionModal.jsx'

/**
 * ProductCard — feed entry for one listing.
 *
 * Shows the cover image, title, price (sats + fiat conversion), and
 * status/visibility badges. Click anywhere on the card opens the
 * product drawer (handler passed in by parent).
 *
 * Visibility/status rendering rules:
 *   • status='sold'        → "Sold" badge, dimmed thumbnail
 *   • visibility='hidden'  → "Hidden" badge (only visible when owner;
 *                             non-owner users won't see this card at all
 *                             since hidden listings stay out of feeds)
 *   • visibility='pre-order' → "Pre-order" badge
 *   • otherwise (active + on-sale) → no badge
 */
export default function ProductCard({ listing, sessionUser, profile, complianceGrade, hasOptedIntoGamma = false, onClick, onEdit, onAuthorClick, onOpenCompliance }) {
  const { decoded } = listing
  const cover = decoded.images?.[0]?.url
  const safeCover = cover && isSafeUrl(cover) ? cover : null

  const sold       = decoded.status === 'sold'
  const hidden     = decoded.visibility === 'hidden'
  const preorder   = decoded.visibility === 'pre-order'

  const navigate = useNavigate()
  const { npub: currentUrlNpub } = useParams()
  // Author identity for the seller row. profile may be undefined
  // briefly (batch fetch in flight); fallback shows the truncated
  // pubkey so the row never looks empty.
  const authorPubkey  = listing.event.pubkey
  const authorName    = profile?.display_name?.trim() || profile?.name?.trim() || ''
  const authorPicture = profile?.picture && isSafeUrl(profile.picture) ? profile.picture : null

  function handleAuthorClick(e) {
    e.stopPropagation()
    if (onAuthorClick) {
      onAuthorClick(authorPubkey, profile)
      return
    }
    // Default: navigate to the logged-in user's marketplace search
    // with this seller pinned. Lands the user on their own profile/
    // marketplace context (where their own filters and saved state
    // live) rather than dropping them into the seller's read-only
    // profile page. Falls back to the current URL's npub for not-
    // logged-in viewers so they at least stay on whatever profile
    // they were browsing.
    try {
      const sellerNpub = nip19.npubEncode(authorPubkey)
      const baseNpub = sessionUser?.pubkey
        ? nip19.npubEncode(sessionUser.pubkey)
        : (currentUrlNpub || sellerNpub)
      navigate(`/${baseNpub}/marketplace/search?seller=${sellerNpub}`, { replace: true })
    } catch {
      // Bad pubkey shouldn't reach here from a fetched event; no-op.
    }
  }

  // Menu trigger ref + open state. Card outer is a div (not a button)
  // so the menu trigger can sit as a sibling — nesting buttons is
  // invalid HTML and the article cards use this same split pattern.
  const menuTriggerRef = useRef(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // Picker is owned here (not in the menu) so closing the menu after
  // the user clicks "Save to collection…" doesn't unmount it.
  const [pickerOpen, setPickerOpen] = useState(false)

  return (
    <div
      className={`group relative flex flex-col bg-neutral-900 border border-neutral-800 rounded overflow-hidden hover:border-neutral-600 transition-colors ${
        sold ? 'opacity-70' : ''
      }`}
    >
      {/* Main click target — wraps cover + body. Menu button sits
          outside this so click events on the menu don't bubble into
          opening the drawer. */}
      <button
        type="button"
        onClick={onClick}
        className="flex flex-col text-left w-full"
      >
        <div className="aspect-square w-full bg-neutral-800 relative overflow-hidden">
          {safeCover ? (
            <img
              src={safeCover}
              alt=""
              loading="lazy"
              className={`w-full h-full object-cover transition-opacity ${sold ? 'grayscale' : ''}`}
              onError={(e) => { e.currentTarget.style.opacity = '0.2' }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-3xl text-neutral-700">
              🛒
            </div>
          )}

        </div>

        {/* Body */}
        <div className="flex-1 p-2.5 space-y-1">
          <h3 className="text-sm font-medium text-neutral-100 line-clamp-2 leading-snug">
            {decoded.title || 'Untitled listing'}
          </h3>
          <PriceLine price={decoded.price} />
          <StockLine stock={decoded.stock} />
        </div>
      </button>

      {/* Badge stack — sibling of the outer card button so ComplianceDot
          can be a real button (button-in-button is invalid HTML).
          pointer-events-none on the wrapper means the static badge spans
          don't intercept the card click; ComplianceDot re-enables
          pointer events on itself so it remains clickable. */}
      <div className="absolute top-2 left-2 flex flex-col gap-1 items-start pointer-events-none">
        {sold && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-900/80 text-red-100 border border-red-700">
            Sold
          </span>
        )}
        {!sold && hidden && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-neutral-800/90 text-neutral-300 border border-neutral-600">
            Hidden
          </span>
        )}
        {!sold && !hidden && preorder && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-900/80 text-amber-100 border border-amber-700">
            Pre-order
          </span>
        )}
        {complianceGrade && (
          <ComplianceDot
            grade={complianceGrade}
            hasOptedIntoGamma={hasOptedIntoGamma}
            onOpenCompliance={onOpenCompliance}
          />
        )}
      </div>

      {/* Seller row — sibling of the main button (avoids nested
          buttons). Click filters search to this seller in SearchTab,
          or navigates to their profile elsewhere (default). */}
      <button
        type="button"
        onClick={handleAuthorClick}
        className="flex items-center gap-1.5 px-2.5 py-1.5 border-t border-neutral-800/80 hover:bg-neutral-800/60 transition-colors text-left"
        title={onAuthorClick ? 'Filter by this seller' : 'View seller profile'}
      >
        <div className="w-5 h-5 rounded-full bg-neutral-800 border border-neutral-700 overflow-hidden flex-shrink-0 flex items-center justify-center text-[10px] text-neutral-600">
          {authorPicture ? (
            <img
              src={authorPicture}
              alt=""
              className="w-full h-full object-cover"
              referrerPolicy="no-referrer"
              onError={e => { e.currentTarget.style.display = 'none' }}
            />
          ) : (
            <span aria-hidden>👤</span>
          )}
        </div>
        <span className="text-[11px] text-neutral-400 truncate flex-1 min-w-0">
          {authorName || `${authorPubkey.slice(0, 8)}…`}
        </span>
      </button>

      {/* Three-dot menu trigger — absolutely positioned over the cover's
          top-right. stopPropagation so click doesn't fall through to
          the main button (which would open the drawer). */}
      <div
        ref={menuTriggerRef}
        className="absolute top-1.5 right-1.5"
        onMouseDown={e => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={e => { e.stopPropagation(); setMenuOpen(o => !o) }}
          title="Actions"
          aria-label="Product actions"
          // Larger tap target on mobile (~32×32) to clear Apple HIG's
          // 44pt-ish floor; tighten back to p-1 on md+ so it doesn't
          // dominate the card on desktop.
          className="p-2 md:p-1 rounded text-neutral-200 bg-neutral-900/70 hover:bg-neutral-800 hover:text-neutral-100 transition-colors backdrop-blur-sm border border-neutral-700/60"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <circle cx="3"  cy="8" r="1.4" />
            <circle cx="8"  cy="8" r="1.4" />
            <circle cx="13" cy="8" r="1.4" />
          </svg>
        </button>
        {/* Lazy-mount the menu — keeping it always mounted means
            ProductActionsMenu's useCollections fires per-card on
            every feed render (10-20 simultaneous fetches when the
            grid first paints, which thrashes relays). Mounting only
            when open keeps the fetch storm out of the critical path. */}
        {menuOpen && (
          <ProductActionsMenu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            listing={listing}
            sessionUser={sessionUser}
            triggerRef={menuTriggerRef}
            onOpenSavePicker={() => setPickerOpen(true)}
            onEdit={onEdit}
          />
        )}
      </div>

      {pickerOpen && (
        <AddToCollectionModal
          listing={listing}
          sessionUser={sessionUser}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
}

/**
 * Compact price line: primary side bold, equivalent in muted text.
 * `price` is the gamma decoded shape: { amount, currency }.
 */
function PriceLine({ price }) {
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
    return <p className="text-xs text-neutral-500">No price set</p>
  }

  const primaryAmount   = price.amount
  const primaryCurrency = price.currency || 'SATS'
  const primary = formatAmount(primaryAmount, primaryCurrency)

  // Equivalent in the *other* unit. SATS-priced → show fiat (USD by
  // default for the conversion display); fiat-priced → show sats.
  let equivalent = null
  if (primaryCurrency === 'SATS') {
    const usd = satsToFiat(primaryAmount, 'USD', rates)
    if (usd !== null) equivalent = `≈ ${formatAmount(usd, 'USD')}`
  } else {
    const sats = fiatToSats(primaryAmount, primaryCurrency, rates)
    if (sats !== null) equivalent = `≈ ${formatAmount(sats, 'SATS')} sats`
  }

  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-sm font-semibold text-purple-300">{primary}{primaryCurrency === 'SATS' ? ' sats' : ''}</span>
      {equivalent && <span className="text-[10px] text-neutral-500">{equivalent}</span>}
    </div>
  )
}

/**
 * Stock indicator on the gallery card. NIP-99 `stock` is optional —
 * sellers leave it blank when the count isn't meaningful (digital
 * goods, services, "ask me"). Render rules:
 *   - null/undefined  → render nothing (no signal worth taking up space)
 *   - 0               → "Out of stock" in muted red so the card visibly
 *                        downgrades without needing the seller to flip
 *                        status=sold
 *   - 1-3             → "X in stock" in amber as a low-stock signal
 *   - 4+              → "X in stock" in muted neutral
 *
 * Mirrors what the drawer already renders under "Stock", so a card
 * preview matches the detail view.
 */
function StockLine({ stock }) {
  if (!Number.isFinite(stock)) return null
  if (stock === 0) {
    return (
      <div className="text-[10px] font-medium text-rose-400/90">Out of stock</div>
    )
  }
  const lowStock = stock <= 3
  return (
    <div className={`text-[10px] tabular-nums ${lowStock ? 'text-amber-400/90' : 'text-neutral-500'}`}>
      {stock.toLocaleString()} in stock
    </div>
  )
}

/**
 * Owner-only Gamma readiness pill. Intent-aware — only shows when there's
 * something meaningful to surface:
 *
 *   - Listing IS checkout-ready (no warning/error gaps) → "✓ Checkout-ready"
 *     pill in green. Positive signal: this listing supports automated
 *     checkout in Gamma marketplace apps.
 *   - Listing has a hard gap (broken data: free-text shipping marker,
 *     unresolved ref) → amber "Needs attention" pill regardless of shop
 *     intent. Hard gaps mean the seller showed intent but didn't finish
 *     or has corrupted data.
 *   - Listing is missing shipping AND the shop opted in via the other
 *     signal (has 30406s, or has payment_preference set) → amber
 *     "Add shipping" pill. Same idea: the OTHER half of the Gamma setup
 *     is missing.
 *   - Listing is missing shipping AND the shop hasn't opted in at all →
 *     no pill. Classified-style ("DM me") is a perfectly valid NIP-99
 *     use case; we don't flag it.
 *
 * Visitor-side cards never receive a `complianceGrade` prop, so this
 * component is owner-only by construction — no extra gate needed.
 */
function ComplianceDot({ grade, hasOptedIntoGamma, onOpenCompliance }) {
  // Codes always treated as hard regardless of shop intent.
  const HARD_CODES = new Set(['FREE_TEXT_ONLY_SHIPPING', 'SHIPPING_REF_UNRESOLVED'])
  const hasHardCode = grade.gaps.some(g => HARD_CODES.has(g.code))
  const hasErrors   = grade.gaps.some(g => g.severity === 'error')
  const isMissingShipping = grade.gaps.some(g => g.code === 'NO_SHIPPING_OPTION')

  if (grade.ready) {
    // Ready pill is informational — no review needed, render as a span
    // so it doesn't compete with the card click for attention.
    return (
      <span
        className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-emerald-900/80 text-emerald-100 border-emerald-700 pointer-events-auto"
        title="Supports automated checkout in Gamma marketplace apps."
      >
        ✓ Checkout-ready
      </span>
    )
  }

  if (hasErrors || hasHardCode || (isMissingShipping && hasOptedIntoGamma)) {
    const tooltip = grade.gaps.length > 0
      ? `${grade.gaps.map(g => g.label).join(' · ')} · Click to review`
      : 'Open the Gamma checkout setup panel for details.'
    // Click opens the compliance panel scrolled to this listing's row.
    // stopPropagation so the click doesn't bubble to the card's outer
    // button (which would open the product drawer instead).
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onOpenCompliance?.()
        }}
        title={tooltip}
        className="text-[10px] font-medium px-1.5 py-0.5 rounded border bg-amber-900/80 text-amber-100 border-amber-700 hover:bg-amber-900 hover:border-amber-600 transition-colors pointer-events-auto"
      >
        Review Listing
      </button>
    )
  }

  // Soft state on a not-opted-in shop — DM-only is fine, no pill.
  return null
}
