/**
 * ShippingOptionEditor — modal for create/edit of a kind 30406 shipping
 * option. Closes the create gap that's been blocking Phase 2 (the Sell
 * composer's free-text shipping textarea has no structured backing).
 *
 * Field set (Phase 2a — minimum to be checkout-ready in Shopstr / Plebeian):
 *   - title (required)
 *   - price.amount + price.currency (required for checkout pricing)
 *   - countries: comma-separated ISO 3166-1 alpha-2 codes (required for
 *     "ships to my country" filtering)
 *   - service: one of standard | express | overnight | pickup (spec enum,
 *     see docs/gamma-spec-snapshot.md §3)
 *   - carrier (optional) — free text
 *   - regions  (optional) — comma-separated, free text
 *
 * Power-user fields the spec defines (duration, weight-min/max, dim-min/
 * max, price-weight/volume/distance) are intentionally absent here —
 * gamma.js round-trips them via _extraTags so editing in MyNostr won't
 * strip a tag a Shopstr power user wrote, but we don't surface them in
 * the form yet. Add when there's signal sellers want them.
 */
import { useEffect, useRef, useState } from 'react'
import { SERVICE_VALUES } from '../../../../lib/gammaCompliance.js'

const ISO_ALPHA2_RE = /^[A-Z]{2}$/

// Plain-text → array helper. Splits on commas/whitespace, uppercases for
// country codes. Empty string → []. Defensive against accidental garbage
// (numbers, lowercase) so the rendered chips reflect what'll publish.
function parseCountryList(text) {
  return String(text || '')
    .split(/[,\s]+/)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
}
function parseRegionList(text) {
  return String(text || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

export default function ShippingOptionEditor({
  initial,                // { dTag?, title?, price?, countries?, regions?, service?, carrier? }
  pending,
  onSave,                 // (form) => Promise<{ ok, error? }>
  onArchive,              // optional — only shown in edit mode
  onClose,
}) {
  const isEdit = !!initial?.dTag

  const [title, setTitle] = useState(initial?.title || '')
  const [priceAmount, setPriceAmount] = useState(
    initial?.price?.amount != null ? String(initial.price.amount) : ''
  )
  const [priceCurrency, setPriceCurrency] = useState(
    (initial?.price?.currency || 'SATS').toUpperCase()
  )
  const [countriesText, setCountriesText] = useState(
    (initial?.countries || []).join(', ')
  )
  const [regionsText, setRegionsText] = useState(
    (initial?.regions || []).join(', ')
  )
  const [service, setService] = useState(
    initial?.service || ''
  )
  const [carrier, setCarrier] = useState(initial?.carrier || '')

  const [error, setError]       = useState('')
  const [confirmingArchive, setConfirmingArchive] = useState(false)

  // Focus the title input on mount so the keyboard flow is one
  // continuous chain (matches the calendar / collection editors).
  const titleRef = useRef(null)
  useEffect(() => { titleRef.current?.focus() }, [])

  // Parsed previews — render the chips as the user types so they can
  // see the publish-shape, not just their raw text.
  const countriesParsed = parseCountryList(countriesText)
  const regionsParsed   = parseRegionList(regionsText)

  // Validation: required spec fields + ISO format on countries. Service
  // and currency come from controlled selects, so they can't be invalid
  // unless the user submits before picking — surfaced as field-level
  // helper text rather than a form-level error.
  function validate() {
    const problems = []
    if (!title.trim()) problems.push('Title is required')
    if (!service) problems.push('Pick a service type')
    const amount = Number(priceAmount)
    if (priceAmount && (!Number.isFinite(amount) || amount < 0)) {
      problems.push('Price must be a non-negative number')
    }
    if (countriesParsed.length === 0) {
      problems.push('Add at least one country (ISO 2-letter codes, e.g. US, GB, DE)')
    } else {
      const bad = countriesParsed.filter(c => !ISO_ALPHA2_RE.test(c))
      if (bad.length > 0) {
        problems.push(`Country codes must be 2 uppercase letters: ${bad.join(', ')}`)
      }
    }
    return problems
  }

  async function handleSave() {
    const problems = validate()
    if (problems.length) { setError(problems.join(' · ')); return }
    setError('')

    const amount = priceAmount.trim() === '' ? null : Number(priceAmount)
    const r = await onSave({
      ...initial,                // preserve _extraTags / location / geohash / tTags from edit-target
      title: title.trim(),
      price: { amount, currency: priceCurrency || 'SATS' },
      countries: countriesParsed,
      regions:   regionsParsed,
      service,
      carrier:   carrier.trim(),
    })
    if (!r?.ok) setError(r?.error || 'Save failed.')
  }

  async function handleArchive() {
    if (!onArchive || !initial?.dTag) return
    setError('')
    const r = await onArchive(initial.dTag)
    if (!r?.ok) {
      setError(r?.error || 'Archive failed.')
      setConfirmingArchive(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-neutral-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-100">
            {isEdit ? 'Edit shipping option' : 'New shipping option'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="text-neutral-500 hover:text-neutral-200 disabled:opacity-40"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <form
          onSubmit={e => { e.preventDefault(); handleSave() }}
          className="px-4 py-4 space-y-4"
        >
          <Field label="Title" hint="Shown on listing checkout pages — e.g. 'US Standard'.">
            <input
              ref={titleRef}
              type="search"
              value={title}
              onChange={e => setTitle(e.target.value)}
              maxLength={80}
              className={inputCls}
              placeholder="US Standard"
            />
          </Field>

          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Field label="Price" hint="Base shipping cost. Leave empty for 'free' or 'contact for quote'.">
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={priceAmount}
                onChange={e => setPriceAmount(e.target.value)}
                className={inputCls}
                placeholder="0"
              />
            </Field>
            <Field label="Currency">
              <select
                value={priceCurrency}
                onChange={e => setPriceCurrency(e.target.value.toUpperCase())}
                className={`${inputCls} pr-8`}
              >
                <option value="SATS">SATS</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
                <option value="CAD">CAD</option>
                <option value="AUD">AUD</option>
              </select>
            </Field>
          </div>

          <Field
            label="Ships to (countries)"
            hint="ISO 2-letter codes, comma-separated. E.g. US, GB, DE. Use just one if you only ship domestically."
          >
            <input
              type="search"
              value={countriesText}
              onChange={e => setCountriesText(e.target.value)}
              className={`${inputCls} font-mono uppercase`}
              placeholder="US, CA, GB"
            />
            {countriesParsed.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {countriesParsed.map(c => (
                  <span
                    key={c}
                    className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                      ISO_ALPHA2_RE.test(c)
                        ? 'border-neutral-700 text-neutral-300 bg-neutral-900'
                        : 'border-amber-700 text-amber-300 bg-amber-950/30'
                    }`}
                  >
                    {c}
                  </span>
                ))}
              </div>
            )}
          </Field>

          <Field
            label="Service"
            hint="Spec-mandated category. Maps to the 'estimated speed' UI most checkout flows render."
          >
            <select
              value={service}
              onChange={e => setService(e.target.value)}
              className={`${inputCls} pr-8`}
            >
              <option value="">— Pick one —</option>
              {SERVICE_VALUES.map(v => (
                <option key={v} value={v}>
                  {v.charAt(0).toUpperCase() + v.slice(1)}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Carrier (optional)"
            hint="Free text. E.g. USPS, DHL, FedEx."
          >
            <input
              type="search"
              value={carrier}
              onChange={e => setCarrier(e.target.value)}
              maxLength={60}
              className={inputCls}
              placeholder="USPS"
            />
          </Field>

          <Field
            label="Regions (optional)"
            hint="Sub-country regions if the option only covers part of a country. Comma-separated, free text."
          >
            <input
              type="search"
              value={regionsText}
              onChange={e => setRegionsText(e.target.value)}
              className={inputCls}
              placeholder="CA, NY, TX"
            />
          </Field>

          {error && (
            <p className="text-xs text-red-400 border border-red-900 rounded px-3 py-2">
              {error}
            </p>
          )}

          {confirmingArchive && (
            <div className="border border-rose-900/60 bg-rose-950/25 rounded-md px-3 py-2 text-[11px] text-rose-200">
              Archive this option? Existing listings that link to it keep
              their reference — third-party checkout apps will fall back to
              manual checkout once the archive propagates. You can't undo
              this from MyNostr.
            </div>
          )}

          {/* Footer: archive (edit mode only) on the left, cancel/save on the right. */}
          <div className="flex items-center justify-between pt-2 border-t border-neutral-800">
            <div>
              {isEdit && onArchive && (
                confirmingArchive ? (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setConfirmingArchive(false)}
                      disabled={pending}
                      className="text-[11px] px-2 py-1 rounded border border-neutral-700 text-neutral-300 hover:border-neutral-500 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleArchive}
                      disabled={pending}
                      className="text-[11px] px-2 py-1 rounded border border-rose-700 bg-rose-950/40 text-rose-200 hover:bg-rose-900/60 disabled:opacity-50"
                    >
                      {pending ? 'Archiving…' : 'Confirm archive'}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmingArchive(true)}
                    disabled={pending}
                    className="text-[11px] text-rose-400 hover:text-rose-200 transition-colors disabled:opacity-50"
                  >
                    Archive
                  </button>
                )
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={pending}
                className="text-xs text-neutral-400 hover:text-neutral-200 border border-neutral-700 hover:border-neutral-500 rounded px-3 py-1.5 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={pending}
                className="text-xs text-purple-200 bg-purple-800 hover:bg-purple-700 rounded px-3 py-1.5 transition-colors disabled:opacity-50"
              >
                {pending ? 'Saving…' : (isEdit ? 'Save' : 'Create')}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

const inputCls =
  'w-full bg-neutral-900 border border-neutral-700 focus:border-purple-600 rounded px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 outline-none'

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="text-xs text-neutral-400 block mb-1">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-neutral-600 block mt-1">{hint}</span>}
    </label>
  )
}
