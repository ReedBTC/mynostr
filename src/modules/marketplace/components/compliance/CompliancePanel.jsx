/**
 * CompliancePanel — full modal listing every gap across the seller's
 * profile + listings, with one-click fixes per row.
 *
 * Layered on top of gammaCompliance's gradeMerchant: every gap the
 * grader returns is rendered as a row with severity dot + label +
 * action. Listings that are spec-complete don't appear here — the
 * panel is a punch list, not an inventory.
 *
 * Profile gaps:
 *   - NO_PAYMENT_PREFERENCE (info) → inline 3-radio set + Save
 *   - INVALID_PAYMENT_PREFERENCE (warning) → same picker, replaces value
 *
 * Listing gaps:
 *   - FREE_TEXT_ONLY_SHIPPING (warning) → opens MigrateShippingModal
 *   - NO_SHIPPING_OPTION (warning)     → opens MigrateShippingModal (empty preview)
 *   - SHIPPING_REF_UNRESOLVED (warning) → opens MigrateShippingModal so the
 *      seller can pick a fresh option, or just dismiss with the
 *      "Drop unresolved" path that's also in the Sell composer's
 *      ShippingTab. Currently we only offer re-pick from this surface;
 *      cleanup-without-replacement lives in the composer to avoid
 *      duplicating the action UI.
 */
import { useMemo, useState } from 'react'
import { publishProfile } from '../../../../lib/publishProfile.js'
import {
  gradeMerchant,
  PAYMENT_PREFERENCE_VALUES,
} from '../../../../lib/gammaCompliance.js'
import MigrateShippingModal from './MigrateShippingModal.jsx'

const SEVERITY_DOT = {
  error:   'bg-rose-500',
  warning: 'bg-amber-500',
  info:    'bg-sky-500',
}
const SEVERITY_LABEL = {
  error:   'Error',
  warning: 'Needs attention',
  info:    'Optional',
}

export default function CompliancePanel({
  profileEvent,                 // raw kind 0 NDKEvent (or null)
  listings = [],                // [{ event, decoded }] from useSelling
  shippingOptions = [],         // [{ event, decoded }] from useSessionShippingOptions
  profileLud16,                 // for gating the inline lud16 radio
  onClose,
  onProfileUpdated,             // called after a payment_preference write
  onListingsUpdated,            // called after one or more listings republish
}) {
  // Compute the verdict synchronously from current data — caller is
  // expected to pass the latest snapshots. The panel re-renders when
  // state below changes (after writes).
  const verdict = useMemo(() => gradeMerchant({
    profile:         profileEvent,
    listings:        listings.map(l => l.decoded),
    shippingOptions: shippingOptions.map(o => o.decoded),
  }), [profileEvent, listings, shippingOptions])

  // Listing-level gaps need to know which listing they belong to; the
  // grader returns a `listingIndex` pointer back into the input array.
  const listingsWithGaps = useMemo(() => {
    const byIdx = new Map()
    for (const g of verdict.gaps) {
      if (g.scope !== 'listing') continue
      const arr = byIdx.get(g.listingIndex) || []
      arr.push(g)
      byIdx.set(g.listingIndex, arr)
    }
    return [...byIdx.entries()].map(([idx, gaps]) => ({
      listing: listings[idx],
      gaps,
    })).filter(x => x.listing)
  }, [verdict.gaps, listings])

  const profileGaps = verdict.gaps.filter(g => g.scope === 'profile')

  // Listings that have NO shipping_option ref yet — used by the migrate
  // modal's "apply to all" bulk option. Computed once so a per-row
  // open of the modal can pass siblings without redoing the work.
  const listingsMissingShipping = useMemo(() => {
    return listings.filter(l => {
      const refs = l.decoded?.shippingOptionRefs || []
      return refs.length === 0
    })
  }, [listings])

  const [migrateTarget, setMigrateTarget] = useState(null)  // listing object

  return (
    <>
      <div
        className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 px-4"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
      >
        <div
          className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-md border border-neutral-800 bg-neutral-950"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="px-4 py-3 border-b border-neutral-800 flex items-center justify-between flex-shrink-0">
            <div>
              <h2 className="text-sm font-semibold text-neutral-100">
                Compliance check
              </h2>
              <p className="text-[11px] text-neutral-500 mt-0.5">
                {verdict.score}/100 · {verdict.listingReadyCount} of {verdict.listingCount} listing{verdict.listingCount === 1 ? '' : 's'} checkout-ready
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-neutral-500 hover:text-neutral-200"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">

            {/* All-clear state */}
            {verdict.gaps.length === 0 && (
              <div className="text-center py-10">
                <div className="text-3xl mb-2" aria-hidden>✓</div>
                <p className="text-sm text-neutral-200">
                  Your shop is fully checkout-ready.
                </p>
                <p className="text-[11px] text-neutral-500 mt-1 max-w-sm mx-auto">
                  Every listing has a structured shipping option, your
                  profile signals are set, and third-party marketplace
                  apps will route buyers smoothly through checkout.
                </p>
              </div>
            )}

            {/* Profile section */}
            {profileGaps.length > 0 && (
              <Section title="Your profile">
                {profileGaps.map((g, i) => (
                  <ProfileGapRow
                    key={`p-${i}`}
                    gap={g}
                    profileEvent={profileEvent}
                    profileLud16={profileLud16}
                    onChanged={onProfileUpdated}
                  />
                ))}
              </Section>
            )}

            {/* Per-listing section */}
            {listingsWithGaps.length > 0 && (
              <Section title={`Your listings (${listingsWithGaps.length} ${listingsWithGaps.length === 1 ? 'item needs' : 'items need'} attention)`}>
                {listingsWithGaps.map(({ listing, gaps }) => (
                  <ListingGapRow
                    key={listing.event.id}
                    listing={listing}
                    gaps={gaps}
                    onMigrate={() => setMigrateTarget(listing)}
                  />
                ))}
              </Section>
            )}
          </div>

          {/* Footer */}
          <div className="px-4 py-3 border-t border-neutral-800 flex items-center justify-end flex-shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="text-xs text-neutral-300 hover:text-neutral-100 border border-neutral-700 hover:border-neutral-500 rounded px-3 py-1.5 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>

      {migrateTarget && (
        <MigrateShippingModal
          listing={migrateTarget}
          otherListingsMissing={listingsMissingShipping.filter(l => l.event.id !== migrateTarget.event.id)}
          onClose={() => setMigrateTarget(null)}
          onMigrated={() => {
            setMigrateTarget(null)
            onListingsUpdated?.()
          }}
        />
      )}
    </>
  )
}

function Section({ title, children }) {
  return (
    <section>
      <h3 className="text-[11px] uppercase tracking-wide text-neutral-500 mb-2">
        {title}
      </h3>
      <div className="space-y-2">{children}</div>
    </section>
  )
}

/**
 * Profile gap row. NO_PAYMENT_PREFERENCE / INVALID_PAYMENT_PREFERENCE
 * both surface an inline 3-radio mini-form so the seller can fix
 * without leaving the panel. Other future profile gaps can fall back
 * to a generic "Open profile editor" deep link.
 */
function ProfileGapRow({ gap, profileEvent, profileLud16, onChanged }) {
  const fixable =
    gap.code === 'NO_PAYMENT_PREFERENCE' ||
    gap.code === 'INVALID_PAYMENT_PREFERENCE'

  const [picked, setPicked] = useState(() => {
    const tag = (profileEvent?.tags || []).find(t => Array.isArray(t) && t[0] === 'payment_preference')
    const v = String(tag?.[1] || '').toLowerCase()
    return PAYMENT_PREFERENCE_VALUES.includes(v) && v !== 'manual' ? v : ''
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [savedFlash, setSavedFlash] = useState(false)

  async function handleSave() {
    if (!profileEvent?.pubkey) {
      setError('Profile not loaded yet — try again in a moment.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const tagsToRemove = ['payment_preference']
      const tagSet = picked ? [['payment_preference', picked]] : []
      await publishProfile({ pubkey: profileEvent.pubkey, edits: {}, tagSet, tagsToRemove })
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1500)
      onChanged?.()
    } catch (e) {
      setError(e?.message || 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-3 py-2.5 rounded border border-neutral-800 bg-neutral-900/40">
      <div className="flex items-start gap-2">
        <span className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${SEVERITY_DOT[gap.severity]}`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-neutral-100">{gap.label}</p>
          <p className="text-[11px] text-neutral-500 mt-0.5">
            {SEVERITY_LABEL[gap.severity]} · {gap.fix}
          </p>
        </div>
      </div>

      {fixable && (
        <div className="mt-3 pl-4 space-y-2">
          <div className="space-y-1">
            <PrefRadio
              checked={picked === ''}
              onChange={() => setPicked('')}
              label="Manual"
              hint="Buyers DM you; you send a payment request. Default."
            />
            <PrefRadio
              checked={picked === 'lud16'}
              onChange={() => setPicked('lud16')}
              disabled={!profileLud16}
              label="Lightning address"
              hint={profileLud16 ? `Auto-route to ${profileLud16}` : 'Add a Lightning address in your profile first.'}
            />
            <PrefRadio
              checked={picked === 'ecash'}
              onChange={() => setPicked('ecash')}
              label="eCash"
              hint="Pays via your trusted Cashu mints (kind 10019)."
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            {error && <span className="text-[11px] text-red-400 mr-auto">{error}</span>}
            {savedFlash && <span className="text-[11px] text-emerald-400 mr-auto">✓ Saved</span>}
            <button
              type="button"
              onClick={handleSave}
              disabled={busy}
              className="text-[11px] px-2.5 py-1 rounded border border-purple-700 text-purple-200 bg-purple-950/30 hover:bg-purple-900/40 hover:text-purple-100 transition-colors disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save preference'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function PrefRadio({ checked, onChange, disabled, label, hint }) {
  return (
    <label className={`flex items-start gap-2 px-2.5 py-1.5 rounded border ${
      checked
        ? 'border-purple-700 bg-purple-950/20'
        : 'border-neutral-800 hover:border-neutral-700'
    } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} transition-colors`}>
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="mt-0.5 accent-purple-600"
      />
      <span className="flex-1 min-w-0">
        <span className="text-xs text-neutral-200 block">{label}</span>
        <span className="text-[11px] text-neutral-500 block mt-0.5">{hint}</span>
      </span>
    </label>
  )
}

/**
 * Per-listing gap row. Bundles every gap on the listing into one card
 * so a listing with both NO_SHIPPING_OPTION and (hypothetical future)
 * INVALID_TYPE_FORM gets one fix flow rather than two stacked rows.
 */
function ListingGapRow({ listing, gaps, onMigrate }) {
  const title = listing.decoded?.title || '(untitled)'
  const topSeverity = gaps.some(g => g.severity === 'error')
    ? 'error'
    : gaps.some(g => g.severity === 'warning') ? 'warning' : 'info'

  // Currently every listing-side gap routes through MigrateShippingModal.
  // If/when we add gaps that don't (e.g. invalid type.form), branch here.
  const migrationCodes = new Set([
    'FREE_TEXT_ONLY_SHIPPING',
    'NO_SHIPPING_OPTION',
    'SHIPPING_REF_UNRESOLVED',
  ])
  const canMigrate = gaps.some(g => migrationCodes.has(g.code))

  return (
    <div className="px-3 py-2.5 rounded border border-neutral-800 bg-neutral-900/40 flex items-start gap-2">
      <span className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${SEVERITY_DOT[topSeverity]}`} />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-neutral-100 truncate">{title}</p>
        <ul className="text-[11px] text-neutral-400 mt-0.5 space-y-0.5">
          {gaps.map((g, i) => <li key={i}>· {g.label}</li>)}
        </ul>
      </div>
      {canMigrate && (
        <button
          type="button"
          onClick={onMigrate}
          className="text-[11px] px-2.5 py-1 rounded border border-purple-700 text-purple-200 bg-purple-950/30 hover:bg-purple-900/40 hover:text-purple-100 transition-colors flex-shrink-0"
        >
          Migrate
        </button>
      )}
    </div>
  )
}
