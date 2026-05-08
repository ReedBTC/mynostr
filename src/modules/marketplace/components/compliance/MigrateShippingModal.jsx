/**
 * MigrateShippingModal — flagship migration UX.
 *
 * Walks a seller through making a single listing checkout-ready by either
 * (a) attaching one of their existing kind 30406 shipping options, or
 * (b) creating a new 30406 inline. Either way, on confirm we republish
 * the kind 30402 with a `shipping_option` ref appended and any free-text
 * `## Shipping` markdown stripped out — so a future read by a checkout
 * app sees the structured tag instead of falling back to prose.
 *
 * Cross-client edits stay safe because gamma.js round-trips _extraTags;
 * the encoder/decoder pipeline only mutates the fields we explicitly
 * change here.
 */
import { useMemo, useRef, useState } from 'react'
import { eventToForm } from '../../../../lib/sellForm.js'
import { publishProduct } from '../../../../lib/publishProduct.js'
import { useSessionShippingOptions } from '../../../../lib/sessionShippingOptionsContext.jsx'
import { gradeShippingOption } from '../../../../lib/gammaCompliance.js'
import ShippingOptionEditor from '../sell/ShippingOptionEditor.jsx'

const SHIPPING_MARKER = '\n## Shipping\n\n'

// Soft cap on how many listings a single bulk-apply will republish without
// an explicit confirm. Bulk-apply over this many listings prompts an
// extra "this will publish N events" confirmation. Picked at 20 because
// 20 publishes × 600ms pacing ≈ 12 seconds — past that, the lack of a
// progress affordance starts feeling broken.
const BULK_APPLY_SOFT_CAP = 20

/**
 * @param {object} props
 * @param {object} props.listing — { event, decoded } from useSelling.
 * @param {Array<object>} [props.otherListingsMissing] — other listings the
 *   seller owns that also have no shipping_option. When present and the
 *   seller checks the bulk-apply box, we republish each with the chosen
 *   ref attached. Paced ~600ms/event to be relay-friendly.
 * @param {() => void} props.onClose
 * @param {(coord: string) => void} [props.onMigrated] — fired with the
 *   coord that was attached, so the caller can refresh derived state.
 */
export default function MigrateShippingModal({
  listing, otherListingsMissing = [], onClose, onMigrated,
}) {
  const sessionShipping = useSessionShippingOptions()
  const options = sessionShipping?.options || []

  // Parse the listing once on mount — eventToForm splits off the
  // `## Shipping` section so we can preview it and know what to strip
  // on republish. The full form is also what we'll round-trip through
  // publishProduct after we attach the ref.
  const parsedForm = useMemo(() => eventToForm(listing.event), [listing.event])
  const parsedShippingPreview = parsedForm?.shippingNotes || ''

  // Refs the listing currently carries that don't resolve to any of
  // the seller's loaded shipping options. Save semantics REPLACE the
  // listing's set with `pickedRefs`, so any unresolved refs not
  // re-checked here will be silently dropped on publish — surface
  // that explicitly so the seller doesn't get caught out.
  const orphanRefs = useMemo(() => {
    const known = new Set(
      options.map(o => `30406:${o.decoded.pubkey}:${o.decoded.dTag}`)
    )
    return (listing.decoded?.shippingOptionRefs || [])
      .map(r => r?.ref)
      .filter(ref => ref && !known.has(ref))
  }, [listing.decoded, options])

  // Mode: either pick existing options or create a new one. Default to
  // picking when at least one option exists; otherwise jump straight to
  // create.
  const [mode, setMode] = useState(options.length > 0 ? 'pick' : 'create')

  // Multi-select: a listing can carry any number of shipping_option refs
  // (e.g. "US Standard" + "Local Pickup"), so checkboxes — not radios.
  // Initial selection: any of the listing's currently-attached refs that
  // resolve to known options. Falls back to the first spec-complete
  // option as a sensible default for free-text-only migrations.
  const [pickedRefs, setPickedRefs] = useState(() => {
    const knownCoords = new Set(
      options.map(o => `30406:${o.decoded.pubkey}:${o.decoded.dTag}`)
    )
    const existing = (listing.decoded?.shippingOptionRefs || [])
      .map(r => r?.ref)
      .filter(ref => ref && knownCoords.has(ref))
    if (existing.length > 0) return new Set(existing)
    if (options.length === 0) return new Set()
    const ready = options.find(o => gradeShippingOption(o.decoded).ready)
    const target = ready || options[0]
    return new Set([`30406:${target.decoded.pubkey}:${target.decoded.dTag}`])
  })

  function toggleRef(ref) {
    setPickedRefs(prev => {
      const next = new Set(prev)
      if (next.has(ref)) next.delete(ref)
      else next.add(ref)
      return next
    })
  }

  // Bulk apply is **opt-in**, not opt-out. The seller clicked "Migrate"
  // on one specific listing — they may have different shipping in mind
  // for other listings. Defaulting on would silently republish every
  // listing on a single button-click, which surprised people.
  const [bulkApply, setBulkApply] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' })

  // Cancellation flag for the bulk loop. Mutable ref (not state) because
  // we need the in-flight loop iteration to read the latest value
  // synchronously without re-rendering. Reset at the start of each run.
  const cancelledRef = useRef(false)

  // Republish a single listing with the picked refs as its complete
  // shipping_option set + ## Shipping markdown stripped. Replace
  // (rather than append) is the right semantic here:
  //   - Free-text-only listings have no existing refs → replace == append
  //   - Listings with valid existing refs were pre-checked → re-saving
  //     same set is a no-op shape change
  //   - Listings with unresolved refs (SHIPPING_REF_UNRESOLVED) get
  //     cleanly cut over to the user's current selection — exactly the
  //     cleanup we want from this surface
  // _extraTags round-trip preserves anything else cross-client clients
  // wrote on the listing.
  async function republishWithRefs(targetListing, refCoords) {
    const form = eventToForm(targetListing.event)
    if (!form) return { ok: false, error: 'Could not parse listing' }
    form.shippingOptionRefs = refCoords.map(ref => ({ ref, extraCost: null }))
    form.shippingNotes = ''
    try {
      await publishProduct(form)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e?.message || 'Publish failed' }
    }
  }

  async function handleMigrate() {
    if (pickedRefs.size === 0) {
      setError('Pick or create at least one shipping option first.')
      return
    }
    const refsArray = [...pickedRefs]
    // Single listing first so the seller sees fast feedback.
    const targets = bulkApply
      ? [listing, ...otherListingsMissing]
      : [listing]

    // Soft-cap warning for very large bulk runs. 20+ listings × 600ms
    // pacing means the seller is locked into a 12-second-plus operation
    // they probably triggered intentionally — but a one-line confirm
    // covers the rare misclick. Use confirm() rather than another
    // modal layer for now.
    if (targets.length > BULK_APPLY_SOFT_CAP) {
      const ok = typeof window !== 'undefined' && window.confirm
        ? window.confirm(
            `This will republish ${targets.length} listings, taking about ` +
            `${Math.ceil((targets.length * 0.6) / 5) * 5} seconds. Continue?`
          )
        : true
      if (!ok) return
    }

    setError('')
    setBusy(true)
    cancelledRef.current = false
    try {
      setProgress({ done: 0, total: targets.length, current: '' })

      let succeeded = 0
      let cancelledAt = -1
      const errors = []
      for (let i = 0; i < targets.length; i++) {
        if (cancelledRef.current) {
          cancelledAt = i
          break
        }
        const t = targets[i]
        setProgress({
          done: i,
          total: targets.length,
          current: t.decoded?.title || '(untitled)',
        })
        const r = await republishWithRefs(t, refsArray)
        if (r.ok) succeeded++
        else errors.push(`${t.decoded?.title || 'listing'}: ${r.error}`)
        // 600ms pacing between publishes when bulk so we don't smash
        // strict relays. Skip the last gap. Also bail mid-pace if the
        // seller hit Cancel — keeps the response snappy.
        if (i < targets.length - 1 && targets.length > 1) {
          await new Promise(res => setTimeout(res, 600))
        }
      }

      setProgress({ done: targets.length, total: targets.length, current: '' })

      if (cancelledAt >= 0) {
        // Partial-state recovery message — the seller knows exactly what
        // landed and what didn't, so they can re-open the migrate flow
        // for a smaller batch if they want.
        setError(
          `Cancelled after updating ${succeeded} of ${targets.length} listings. ` +
          `The remaining ${targets.length - cancelledAt} are unchanged.`
        )
        // Still call onMigrated so the parent re-fetches and reflects
        // whatever did publish — UX > strict success/fail dichotomy.
        if (succeeded > 0) onMigrated?.(refsArray)
      } else if (errors.length === 0) {
        onMigrated?.(refsArray)
        onClose?.()
      } else if (succeeded > 0) {
        setError(
          `Updated ${succeeded} of ${targets.length} listings. ` +
          `Failed: ${errors.slice(0, 2).join(' · ')}` +
          (errors.length > 2 ? ` (+${errors.length - 2} more)` : '')
        )
      } else {
        setError(errors[0] || 'Migration failed.')
      }
    } finally {
      setBusy(false)
      cancelledRef.current = false
    }
  }

  function handleCancelBulk() {
    cancelledRef.current = true
  }

  // ── Inline-create path ─────────────────────────────────────────────
  // When the seller picks "create new," we render ShippingOptionEditor
  // as a stacked sub-modal. On save, the new option auto-selects in the
  // picker — but we DON'T migrate yet; the seller still gets a "Migrate"
  // confirmation so they can review the picked option before we mutate
  // their published listing.
  const [showEditor, setShowEditor] = useState(options.length === 0)

  async function handleCreateOption(form) {
    if (!sessionShipping) return { ok: false, error: 'Session not ready' }
    const r = await sessionShipping.createOption(form)
    if (r?.ok) {
      const newRef = `30406:${listing.event.pubkey}:${r.dTag}`
      // Add to the picked set rather than replace — the seller may
      // have already ticked an existing option and is creating a
      // second one (e.g. "Local Pickup" alongside "US Standard").
      setPickedRefs(prev => new Set([...prev, newRef]))
      setMode('pick')
      setShowEditor(false)
    }
    return r
  }

  return (
    <>
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
              Make checkout-ready
            </h2>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="text-neutral-500 hover:text-neutral-200 disabled:opacity-40"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className="px-4 py-4 space-y-4">
            <div>
              <p className="text-[11px] text-neutral-500 mb-1">Listing</p>
              <p className="text-sm text-neutral-200 font-medium truncate">
                {listing.decoded?.title || '(untitled)'}
              </p>
            </div>

            {parsedShippingPreview && (
              <div>
                <p className="text-[11px] text-neutral-500 mb-1">
                  Your existing shipping notes (will be replaced by the
                  structured option below)
                </p>
                <div className="px-3 py-2 rounded border border-neutral-800 bg-neutral-900/60 text-[12px] text-neutral-400 whitespace-pre-wrap max-h-32 overflow-y-auto">
                  {parsedShippingPreview}
                </div>
              </div>
            )}

            {orphanRefs.length > 0 && (
              <div className="px-3 py-2 rounded border border-amber-900/60 bg-amber-950/20">
                <p className="text-[11px] text-amber-200 mb-1">
                  This listing has {orphanRefs.length} attached shipping option
                  {orphanRefs.length === 1 ? '' : 's'} that {orphanRefs.length === 1 ? "doesn't" : "don't"} resolve
                  to your current catalog (archived, or not returned by your
                  relays). Saving here will <strong>replace</strong> the
                  listing's shipping with whatever you tick below — the
                  unresolved {orphanRefs.length === 1 ? 'one' : 'ones'} will be dropped.
                </p>
                <div className="flex flex-wrap gap-1 mt-1">
                  {orphanRefs.map(ref => (
                    <span
                      key={ref}
                      className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-amber-900/60 text-amber-300 bg-amber-950/30"
                      title={ref}
                    >
                      {ref.split(':').pop()}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Pick / create toggle — shown only when options exist; if
                the seller has none, we drop straight into the editor. */}
            {options.length > 0 && (
              <div className="flex items-center gap-1 text-xs">
                <button
                  type="button"
                  onClick={() => setMode('pick')}
                  className={`px-2.5 py-1 rounded border transition-colors ${
                    mode === 'pick'
                      ? 'border-purple-700 bg-purple-950/40 text-purple-100'
                      : 'border-neutral-800 text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  Pick existing
                </button>
                <button
                  type="button"
                  onClick={() => { setMode('create'); setShowEditor(true) }}
                  className={`px-2.5 py-1 rounded border transition-colors ${
                    mode === 'create'
                      ? 'border-purple-700 bg-purple-950/40 text-purple-100'
                      : 'border-neutral-800 text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  Create new
                </button>
              </div>
            )}

            {mode === 'pick' && options.length > 0 && (
              <div>
                <p className="text-[11px] text-neutral-500 mb-2">
                  Tick every option this listing should offer. Buyers see
                  all of them at checkout (e.g. "US Standard" plus "Local
                  Pickup").
                </p>
                <div className="space-y-1.5">
                  {options.map(({ decoded }) => {
                    const ref = `30406:${decoded.pubkey}:${decoded.dTag}`
                    const grade = gradeShippingOption(decoded)
                    const checked = pickedRefs.has(ref)
                    return (
                      <label
                        key={decoded.dTag}
                        className={`flex items-start gap-2 px-3 py-2 rounded border cursor-pointer transition-colors ${
                          checked
                            ? 'border-purple-700 bg-purple-950/25'
                            : 'border-neutral-800 hover:border-neutral-700'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleRef(ref)}
                          className="mt-1 accent-purple-600"
                        />
                        <span className="flex-1 min-w-0">
                          <span className="text-sm text-neutral-100 font-medium block truncate">
                            {decoded.title || '(untitled)'}
                            {decoded.service && (
                              <span className="ml-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-300">
                                {decoded.service}
                              </span>
                            )}
                            {!grade.ready && (
                              <span
                                className="ml-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-950/40 text-amber-300 border border-amber-900/60"
                                title={grade.gaps.map(g => g.label).join(' · ')}
                              >
                                Needs review
                              </span>
                            )}
                          </span>
                          <span className="text-[11px] text-neutral-400 block">
                            {decoded.price?.amount != null
                              ? `${decoded.price.amount.toLocaleString()} ${(decoded.price.currency || 'SATS').toUpperCase()}`
                              : 'No price'}
                            {(decoded.countries || []).length > 0 && (
                              <span className="text-neutral-600">
                                {' '}· {(decoded.countries || []).slice(0, 5).join(', ')}
                                {(decoded.countries || []).length > 5 && ` +${(decoded.countries || []).length - 5}`}
                              </span>
                            )}
                          </span>
                        </span>
                      </label>
                    )
                  })}
                </div>
              </div>
            )}

            {mode === 'create' && !showEditor && (
              <button
                type="button"
                onClick={() => setShowEditor(true)}
                className="w-full text-xs px-3 py-2 rounded border border-purple-700 text-purple-200 bg-purple-950/30 hover:bg-purple-900/40 hover:text-purple-100 transition-colors"
              >
                + Open shipping option form
              </button>
            )}

            {/* Bulk-apply opt-in. Only shown when there are siblings to
                apply to AND the seller has picked something. Defaults
                ON because the marketing pitch is "fix all your listings
                at once" — but the seller can opt out for any reason. */}
            {pickedRefs.size > 0 && otherListingsMissing.length > 0 && (
              <label className="flex items-start gap-2 text-xs cursor-pointer text-neutral-300">
                <input
                  type="checkbox"
                  checked={bulkApply}
                  onChange={e => setBulkApply(e.target.checked)}
                  className="mt-0.5 accent-purple-600"
                />
                <span>
                  Also attach {pickedRefs.size === 1 ? 'this option' : `these ${pickedRefs.size} options`}
                  {' '}to my other {otherListingsMissing.length}
                  {' '}listing{otherListingsMissing.length === 1 ? '' : 's'} that
                  {' '}{otherListingsMissing.length === 1 ? "doesn't have" : "don't have"} a shipping option yet.
                  <span className="block text-[11px] text-neutral-500 mt-0.5">
                    Each republishes once at ~0.6s spacing to be relay-friendly.
                  </span>
                </span>
              </label>
            )}

            {busy && progress.total > 1 && (
              <div className="text-xs text-neutral-400 border border-neutral-800 rounded px-3 py-2">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <span className="flex-shrink-0">Publishing… {progress.done} / {progress.total}</span>
                  {progress.current && (
                    <span className="text-[11px] text-neutral-500 truncate flex-1 min-w-0">
                      {progress.current}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={handleCancelBulk}
                    disabled={cancelledRef.current}
                    title="Stop after the current publish"
                    className="text-[11px] px-2 py-0.5 rounded border border-neutral-700 text-neutral-300 hover:text-rose-200 hover:border-rose-700 transition-colors flex-shrink-0 disabled:opacity-50"
                  >
                    {cancelledRef.current ? 'Cancelling…' : 'Cancel'}
                  </button>
                </div>
                <div className="h-1 rounded bg-neutral-800 overflow-hidden">
                  <div
                    className="h-full bg-purple-600 transition-all"
                    style={{ width: `${(progress.done / progress.total) * 100}%` }}
                  />
                </div>
              </div>
            )}

            {error && (
              <p className="text-xs text-red-400 border border-red-900 rounded px-3 py-2">
                {error}
              </p>
            )}
          </div>

          <div className="px-4 py-3 border-t border-neutral-800 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="text-xs text-neutral-400 hover:text-neutral-200 border border-neutral-700 hover:border-neutral-500 rounded px-3 py-1.5 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleMigrate}
              disabled={busy || pickedRefs.size === 0}
              className="text-xs text-purple-200 bg-purple-800 hover:bg-purple-700 rounded px-3 py-1.5 transition-colors disabled:opacity-50"
            >
              {busy
                ? (progress.total > 1 ? 'Publishing…' : 'Migrating…')
                : (bulkApply && otherListingsMissing.length > 0
                   ? `Migrate ${1 + otherListingsMissing.length} listings`
                   : 'Migrate listing')}
            </button>
          </div>
        </div>
      </div>

      {showEditor && (
        <ShippingOptionEditor
          initial={null}
          pending={sessionShipping?.pending}
          onSave={handleCreateOption}
          onClose={() => {
            setShowEditor(false)
            // If the seller closes the editor without saving and we have
            // no options at all, fall back to no-op picker — they can
            // still close the parent modal.
            if (options.length === 0) setMode('pick')
          }}
        />
      )}
    </>
  )
}
