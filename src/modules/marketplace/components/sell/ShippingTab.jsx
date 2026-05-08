/**
 * ShippingTab — structured shipping for a listing.
 *
 * Two layers, in order of importance to checkout-app interop:
 *
 *   1. Structured shipping options (kind 30406 refs). The seller picks
 *      one or more of their published shipping options; we emit a
 *      `shipping_option` tag per pick on the kind 30402. Third-party
 *      checkout apps (Shopstr, Plebeian, …) read these to compute
 *      delivery quotes at the point of sale.
 *
 *   2. Free-text notes (legacy / forward-compat). Anything typed here
 *      is appended to the listing description under a `## Shipping`
 *      heading, exactly like before. Useful for special cases the
 *      structured fields don't capture ("hand-delivery in NYC only",
 *      "shipping prices vary — DM for quote"), and for round-tripping
 *      listings created before structured options existed.
 *
 * The disclosure pattern keeps the structured path visually obvious
 * for new listings while not penalising sellers who still prefer prose.
 */
import { useState } from 'react'
import { useShippingOptions } from '../../../../lib/useShippingOptions.js'
import { useSessionShippingOptions } from '../../../../lib/sessionShippingOptionsContext.jsx'
import { gradeShippingOption } from '../../../../lib/gammaCompliance.js'
import ShippingOptionEditor from './ShippingOptionEditor.jsx'

export default function ShippingTab({ form, updateForm, pubkey }) {
  // Read from the shared session context so options created in the
  // Marketplace → Shipping tab show up here without a refresh, and
  // vice versa. The composer is owner-only, so the session pubkey is
  // always the right pubkey here. Falls back to a null-pubkey hook on
  // the (very rare) cold-mount path where the provider hasn't installed.
  const sessionShipping = useSessionShippingOptions()
  const standalone = useShippingOptions(null)
  const {
    options, loading, error, pending,
    createOption,
  } = sessionShipping || standalone

  const [editingNew, setEditingNew] = useState(false)
  const [notesOpen,  setNotesOpen]  = useState(!!form.shippingNotes)

  // Set of currently-selected option refs ("30406:pubkey:dtag"). Backed
  // by form.shippingOptionRefs, which is what the encoder reads on
  // publish; this Set is just for fast lookup in the render path.
  const selectedRefs = new Set(
    (form.shippingOptionRefs || []).map(r => r?.ref).filter(Boolean)
  )

  function toggleOption(ref) {
    if (!ref) return
    const current = form.shippingOptionRefs || []
    const isSelected = current.some(r => r?.ref === ref)
    const next = isSelected
      ? current.filter(r => r?.ref !== ref)
      : [...current, { ref, extraCost: null }]
    updateForm({ shippingOptionRefs: next })
  }

  // Detect refs the seller selected previously that we can't currently
  // resolve to one of their loaded options — typically because the
  // option was archived, or the relays haven't returned it yet. Show
  // these as ghost chips so the seller can see the listing has a ref
  // pointing somewhere unloaded, rather than silently appearing to have
  // no shipping selected.
  const knownCoords = new Set(
    options.map(o => `30406:${o.decoded.pubkey || pubkey}:${o.decoded.dTag}`)
  )
  const orphanRefs = (form.shippingOptionRefs || [])
    .map(r => r?.ref)
    .filter(ref => ref && !knownCoords.has(ref))

  async function handleCreateInline(formInput) {
    const r = await createOption(formInput)
    if (r?.ok) {
      // Auto-attach the just-created option to this listing — saves the
      // seller a separate "now go check the box" step. Same pattern
      // articles' "+ New tag" inline create uses.
      const ref = `30406:${pubkey}:${r.dTag}`
      const next = [...(form.shippingOptionRefs || []), { ref, extraCost: null }]
      updateForm({ shippingOptionRefs: next })
      setEditingNew(false)
    }
    return r
  }

  return (
    <div className="space-y-5 max-w-2xl">

      {/* ── Structured options ── */}
      <div>
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <label className="text-xs font-medium text-neutral-300">
            Shipping options
          </label>
          <button
            type="button"
            onClick={() => setEditingNew(true)}
            disabled={!pubkey || pending}
            className="text-[11px] px-2 py-0.5 rounded border border-purple-700 text-purple-200 bg-purple-950/30 hover:bg-purple-900/40 hover:text-purple-100 focus:outline-none focus:ring-1 focus:ring-purple-600 transition-colors disabled:opacity-40"
          >
            + New option
          </button>
        </div>

        <p className="text-[11px] text-neutral-500 mb-2">
          Pick one or more of your reusable shipping options. Checkout
          apps (Shopstr, Plebeian, …) use these to quote shipping
          automatically. Manage your full catalog under Marketplace →
          Shipping.
        </p>

        {!pubkey && (
          <p className="text-[11px] text-amber-400">
            Sign in to manage shipping options.
          </p>
        )}

        {pubkey && loading && (
          <p className="text-[11px] text-neutral-600">Loading your options…</p>
        )}

        {pubkey && error && (
          <p className="text-[11px] text-red-400">{error}</p>
        )}

        {pubkey && !loading && !error && options.length === 0 && (
          <div className="px-3 py-3 rounded border border-dashed border-neutral-800 text-center">
            <p className="text-[11px] text-neutral-500 mb-2">
              No shipping options yet.
            </p>
            <button
              type="button"
              onClick={() => setEditingNew(true)}
              className="text-[11px] px-2.5 py-1 rounded border border-purple-700 text-purple-200 bg-purple-950/30 hover:bg-purple-900/40 hover:text-purple-100 transition-colors"
            >
              + Create your first option
            </button>
          </div>
        )}

        {options.length > 0 && (
          <div className="space-y-1.5">
            {options.map(({ decoded }) => {
              const ref = `30406:${decoded.pubkey || pubkey}:${decoded.dTag}`
              return (
                <OptionRow
                  key={decoded.dTag}
                  decoded={decoded}
                  selected={selectedRefs.has(ref)}
                  onToggle={() => toggleOption(ref)}
                />
              )
            })}
          </div>
        )}

        {orphanRefs.length > 0 && (
          <div className="mt-2 px-3 py-2 rounded border border-amber-900/60 bg-amber-950/20">
            <p className="text-[11px] text-amber-200 mb-1">
              {orphanRefs.length} attached option{orphanRefs.length === 1 ? '' : 's'}
              {' '}can't be resolved right now (archived, or your relays
              haven't returned it yet).
            </p>
            <div className="flex flex-wrap gap-1.5">
              {orphanRefs.map(ref => (
                <span
                  key={ref}
                  className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-amber-900/60 text-amber-300 bg-amber-950/30"
                  title={ref}
                >
                  {ref.split(':').pop()}
                </span>
              ))}
              <button
                type="button"
                onClick={() => updateForm({
                  shippingOptionRefs: (form.shippingOptionRefs || []).filter(
                    r => r?.ref && knownCoords.has(r.ref)
                  ),
                })}
                className="text-[10px] px-1.5 py-0.5 rounded border border-amber-900/60 text-amber-200 hover:bg-amber-900/30 transition-colors"
              >
                Drop unresolved
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Free-text notes (collapsed by default) ── */}
      <div className="border-t border-neutral-800 pt-4">
        <button
          type="button"
          onClick={() => setNotesOpen(o => !o)}
          className="text-[11px] text-neutral-400 hover:text-neutral-200 transition-colors flex items-center gap-1"
          aria-expanded={notesOpen}
        >
          <span className={`inline-block transition-transform ${notesOpen ? 'rotate-90' : ''}`}>›</span>
          <span>{notesOpen ? 'Hide notes' : 'Add notes (optional)'}</span>
        </button>

        {notesOpen && (
          <div className="mt-2">
            <textarea
              value={form.shippingNotes || ''}
              onChange={(e) => updateForm({ shippingNotes: e.target.value })}
              rows={4}
              placeholder={'Free hand-delivery in NYC.\nDM for international shipping quote.'}
              className="w-full px-3 py-2 text-sm rounded border border-neutral-800 bg-neutral-900 text-neutral-100 outline-none focus:border-purple-600 transition-colors resize-y"
            />
            <p className="text-[11px] text-neutral-600 mt-1.5">
              Appended to your description under a "Shipping" heading.
              Use for cases the structured options don't cover. Most
              listings should pick a structured option instead — it's
              what checkout apps actually read.
            </p>
          </div>
        )}
      </div>

      {editingNew && (
        <ShippingOptionEditor
          initial={null}
          pending={pending}
          onSave={handleCreateInline}
          onClose={() => setEditingNew(false)}
        />
      )}
    </div>
  )
}

/**
 * One option row — checkbox-style toggle. Clicking anywhere on the row
 * toggles selection (the whole div is the affordance) so users don't
 * have to aim for a small checkbox on touch.
 */
function OptionRow({ decoded, selected, onToggle }) {
  const grade = gradeShippingOption(decoded)
  const priceText = (() => {
    if (decoded.price?.amount == null) return 'No price'
    const cur = (decoded.price.currency || 'SATS').toUpperCase()
    return `${decoded.price.amount.toLocaleString()} ${cur}`
  })()
  const countriesText = (decoded.countries || []).slice(0, 5).join(', ')
  const moreCountries = Math.max(0, (decoded.countries || []).length - 5)

  return (
    <button
      type="button"
      onClick={onToggle}
      className={`w-full text-left px-3 py-2 rounded border transition-colors flex items-start gap-2.5 ${
        selected
          ? 'border-purple-700 bg-purple-950/25 hover:bg-purple-900/30'
          : 'border-neutral-800 bg-neutral-900/40 hover:border-neutral-700'
      }`}
      aria-pressed={selected}
    >
      <span
        className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
          selected
            ? 'border-purple-500 bg-purple-700 text-white'
            : 'border-neutral-700'
        }`}
        aria-hidden
      >
        {selected && (
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 8l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="flex-1 min-w-0">
        <span className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm text-neutral-100 font-medium truncate">
            {decoded.title || '(untitled)'}
          </span>
          {decoded.service && (
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-300">
              {decoded.service}
            </span>
          )}
          {!grade.ready && (
            <span
              className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-950/40 text-amber-300 border border-amber-900/60"
              title={grade.gaps.map(g => g.label).join(' · ')}
            >
              Needs review
            </span>
          )}
        </span>
        <span className="block text-[11px] text-neutral-400 mt-0.5">
          {priceText}
          {countriesText && (
            <span className="text-neutral-600"> · {countriesText}</span>
          )}
          {moreCountries > 0 && (
            <span className="text-neutral-600"> +{moreCountries}</span>
          )}
        </span>
      </span>
    </button>
  )
}
