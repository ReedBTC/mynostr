import { useEffect, useState } from 'react'
import { isSafeUrl } from '../../../../lib/utils.js'
import {
  getCachedRates,
  prefetchRates,
  satsToFiat,
  fiatToSats,
  formatAmount,
} from '../../../../lib/currency.js'

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
export default function ProductCard({ listing, onClick }) {
  const { decoded } = listing
  const cover = decoded.images?.[0]?.url
  const safeCover = cover && isSafeUrl(cover) ? cover : null

  const sold       = decoded.status === 'sold'
  const hidden     = decoded.visibility === 'hidden'
  const preorder   = decoded.visibility === 'pre-order'

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative flex flex-col text-left bg-neutral-900 border border-neutral-800 rounded overflow-hidden hover:border-neutral-600 transition-colors ${
        sold ? 'opacity-70' : ''
      }`}
    >
      {/* Cover */}
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

        {/* Badges — top-left, stacked */}
        <div className="absolute top-2 left-2 flex flex-col gap-1 items-start">
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
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 p-2.5 space-y-1">
        <h3 className="text-sm font-medium text-neutral-100 line-clamp-2 leading-snug">
          {decoded.title || 'Untitled listing'}
        </h3>
        <PriceLine price={decoded.price} />
      </div>
    </button>
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
