/**
 * ShippingOptionsTab — owner-only catalog of reusable kind 30406 shipping
 * options. Sellers create options here, then attach them to listings via
 * the Sell composer's Shipping section (Phase 2b).
 *
 * Layout mirrors CalendarsTab: full-width card rows with title + price +
 * countries summary + service badge, and an Edit modal that doubles as
 * Archive. Empty state nudges first-option creation; non-empty state
 * exposes a top-right "+ New" affordance.
 *
 * Visibility: tab is owner-only at the routing layer (MarketplaceModule).
 * This component still defensively renders a "no access" empty state for
 * the safety belt on direct deep-links from a stale share.
 */
import { useState } from 'react'
import { useShippingOptions } from '../../../../lib/useShippingOptions.js'
import { useSessionShippingOptions } from '../../../../lib/sessionShippingOptionsContext.jsx'
import { gradeShippingOption } from '../../../../lib/gammaCompliance.js'
import ShippingOptionEditor from './ShippingOptionEditor.jsx'

export default function ShippingOptionsTab({ user, isOwner }) {
  // For owners we read from the shared session context so creating an
  // option here is immediately visible in the Sell composer's Shipping
  // tab (and vice versa). Visitor branch falls back to a stand-alone
  // hook with a null pubkey — yields an empty list, no fetches.
  const sessionShipping = useSessionShippingOptions()
  const standalone = useShippingOptions(null)
  const {
    options, loading, error, pending, reload,
    createOption, updateOption, archiveOption,
  } = (isOwner && sessionShipping) ? sessionShipping : standalone

  const [editTarget, setEditTarget] = useState(null)  // decoded option or { __new: true }

  if (!isOwner) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-neutral-500 text-sm px-6 text-center">
        Shipping options are owner-only.
      </div>
    )
  }

  async function handleCreate(form) {
    const r = await createOption(form)
    if (r?.ok) setEditTarget(null)
    return r
  }

  async function handleUpdate(form) {
    if (!editTarget?.dTag) return { ok: false, error: 'No target' }
    const r = await updateOption(editTarget.dTag, form)
    if (r?.ok) setEditTarget(null)
    return r
  }

  async function handleArchive(dTag) {
    const r = await archiveOption(dTag)
    if (r?.ok) setEditTarget(null)
    return r
  }

  return (
    <div className="h-full flex flex-col">
      {/* Top bar — count + new + reload. Same shape as SellingTab. */}
      <div className="flex-shrink-0 px-4 pt-3 pb-2">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <div className="text-xs text-neutral-500">
            {loading
              ? 'Loading…'
              : `${options.length} shipping option${options.length === 1 ? '' : 's'}`}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={reload}
              disabled={loading}
              className="text-xs px-2.5 py-1 rounded border border-neutral-800 text-neutral-500 hover:text-neutral-300 hover:border-neutral-600 transition-colors disabled:opacity-40"
            >
              {loading ? '…' : 'Refresh'}
            </button>
            <button
              type="button"
              onClick={() => setEditTarget({ __new: true })}
              disabled={pending}
              className="text-xs px-2.5 py-1 rounded border border-purple-700 text-purple-200 bg-purple-950/30 hover:bg-purple-900/40 hover:text-purple-100 focus:outline-none focus:ring-1 focus:ring-purple-600 transition-colors disabled:opacity-50"
            >
              + New option
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-3xl mx-auto px-4 pb-6">
          {error && (
            <p className="text-xs text-red-400 mb-3">{error}</p>
          )}

          {!loading && options.length === 0 && !error && (
            <EmptyState onCreate={() => setEditTarget({ __new: true })} />
          )}

          {options.length > 0 && (
            <div className="space-y-2">
              {options.map(({ decoded }) => (
                <OptionRow
                  key={decoded.dTag}
                  decoded={decoded}
                  onEdit={() => setEditTarget(decoded)}
                />
              ))}
            </div>
          )}

          <p className="text-[11px] text-neutral-600 mt-6 max-w-prose">
            Reusable shipping options live as kind 30406 events on Nostr.
            Listings attach them by reference, so a single option can
            cover many products. Renaming an option is safe — listings
            link by stable ID, not by title.
          </p>
        </div>
      </div>

      {editTarget && (
        <ShippingOptionEditor
          initial={editTarget.__new ? null : editTarget}
          pending={pending}
          onSave={editTarget.__new ? handleCreate : handleUpdate}
          onArchive={editTarget.__new ? null : handleArchive}
          onClose={() => setEditTarget(null)}
        />
      )}
    </div>
  )
}

/**
 * Single row — title + price + service badge + countries + compliance
 * dot. Click anywhere to edit. The dot is small but informative: green
 * = ready, amber = something missing the spec wants. Tooltip explains.
 */
function OptionRow({ decoded, onEdit }) {
  const grade = gradeShippingOption(decoded)
  const dotColor = grade.ready ? 'bg-emerald-500' : 'bg-amber-500'
  const dotTitle = grade.ready
    ? 'Spec-complete'
    : grade.gaps.map(g => g.label).join(' · ')

  const priceText = (() => {
    if (decoded.price?.amount == null) return 'No price'
    const cur = (decoded.price.currency || 'SATS').toUpperCase()
    return `${decoded.price.amount.toLocaleString()} ${cur}`
  })()

  const countriesText = (decoded.countries || []).slice(0, 6).join(', ')
  const moreCountries = Math.max(0, (decoded.countries || []).length - 6)

  return (
    <button
      type="button"
      onClick={onEdit}
      className="w-full text-left px-3 py-3 rounded border border-neutral-800 bg-neutral-950 hover:border-neutral-700 hover:bg-neutral-900/60 transition-colors group"
    >
      <div className="flex items-start gap-3">
        <span
          className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`}
          title={dotTitle}
          aria-label={dotTitle}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm text-neutral-100 font-medium truncate">
              {decoded.title || '(untitled)'}
            </span>
            {decoded.service && (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-300">
                {decoded.service}
              </span>
            )}
            {decoded.carrier && (
              <span className="text-[11px] text-neutral-500">{decoded.carrier}</span>
            )}
          </div>
          <div className="text-[11px] text-neutral-400 mt-0.5">
            {priceText}
            {countriesText && (
              <span className="text-neutral-600"> · {countriesText}</span>
            )}
            {moreCountries > 0 && (
              <span className="text-neutral-600"> +{moreCountries}</span>
            )}
          </div>
        </div>
        <span className="text-neutral-600 group-hover:text-neutral-400 text-xs transition-colors">
          Edit →
        </span>
      </div>
    </button>
  )
}

function EmptyState({ onCreate }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <span className="text-4xl mb-3" aria-hidden>📦</span>
      <p className="text-sm text-neutral-300 mb-1">No shipping options yet</p>
      <p className="text-xs text-neutral-500 max-w-sm mb-4">
        Add a reusable option here, then attach it to your listings.
        Third-party marketplace apps (Shopstr, Plebeian, Cypher) use these
        to compute shipping quotes at checkout.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="text-xs px-3 py-1.5 rounded border border-purple-700 text-purple-200 bg-purple-950/30 hover:bg-purple-900/40 hover:text-purple-100 focus:outline-none focus:ring-1 focus:ring-purple-600 transition-colors"
      >
        + New shipping option
      </button>
    </div>
  )
}
