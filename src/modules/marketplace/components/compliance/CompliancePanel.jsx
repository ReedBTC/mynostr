/**
 * CompliancePanel — "Gamma checkout setup" modal.
 *
 * Reframed from a punch-list of compliance violations into a guided
 * 2-step opt-in flow:
 *
 *   Step 1 — How should buyers pay you? (kind 0 payment_preference)
 *   Step 2 — How should buyers' apps quote shipping? (kind 30406s
 *            referenced from each listing)
 *
 * Both steps are shown whether or not they have gaps, so the panel
 * communicates the *shape* of Gamma checkout (two equal opt-in actions),
 * not just what's missing today. Per-listing diagnostics still appear
 * under Step 2 when listings need attention.
 *
 * Severity rendering uses gammaCompliance.effectiveSeverity so soft
 * prompts (no shipping, no payment-pref) on shops that haven't opted
 * in stay info-toned, while broken state (free-text shipping, unresolved
 * refs, invalid values) stays warning regardless of intent.
 */
import { useMemo, useState } from 'react'
import { publishProfile } from '../../../../lib/publishProfile.js'
import {
  gradeMerchant,
  hasOptedIntoGamma,
  effectiveSeverity,
  PAYMENT_PREFERENCE_VALUES,
} from '../../../../lib/gammaCompliance.js'
import MigrateShippingModal from './MigrateShippingModal.jsx'
import WhatIsGammaPopover from './WhatIsGammaPopover.jsx'

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

  const optedIn = useMemo(() => hasOptedIntoGamma({
    profile:         profileEvent,
    shippingOptions,
  }), [profileEvent, shippingOptions])

  // Two opt-in steps. Each step is "complete" when the seller has
  // taken the corresponding positive action. Both must be complete
  // (and listings must be wired up) for the shop to be fully
  // checkout-ready.
  const paymentPrefSet = useMemo(() => {
    const tags = profileEvent?.tags || []
    return tags.some(t => Array.isArray(t) && t[0] === 'payment_preference' && typeof t[1] === 'string' && t[1].trim())
  }, [profileEvent])
  const hasShippingOptions = shippingOptions.length > 0
  const stepsComplete = (paymentPrefSet ? 1 : 0) + (hasShippingOptions ? 1 : 0)

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
          <div className="px-4 py-3 border-b border-neutral-800 flex items-start justify-between flex-shrink-0 gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-neutral-100">
                Gamma checkout setup
              </h2>
              <p className="text-[11px] text-neutral-500 mt-0.5">
                {stepsComplete}/2 setup steps complete
                {verdict.listingCount > 0 && (
                  <> · {verdict.listingReadyCount} of {verdict.listingCount} listing{verdict.listingCount === 1 ? '' : 's'} checkout-ready</>
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-neutral-500 hover:text-neutral-200 flex-shrink-0"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">

            {/* Lead paragraph — explain the optional nature up front */}
            <p className="text-[12px] text-neutral-400 leading-relaxed">
              <span className="font-medium text-neutral-200">Gamma</span> is an
              optional NIP-99 extension that lets third-party marketplace apps
              (like Shopstr and Plebeian Market) quote prices, route payments,
              and calculate shipping for your listings automatically. None of
              it is required — classified-style listings ("DM me to buy") work
              fine without it. <WhatIsGammaPopover />
            </p>

            {/* Step 1 — Payment preference. Always shown so the panel
                communicates "this is a 2-step setup" even when complete. */}
            <StepCard
              number={1}
              title="How should buyers pay you?"
              hint={paymentPrefSet
                ? 'Set — buyers\' apps know how to route payments.'
                : 'Tell buyers\' marketplace apps to route payments to your Lightning address, eCash mints, or fall back to manual DMs.'}
              complete={paymentPrefSet}
            >
              {(profileGaps.length > 0
                ? profileGaps.map((g, i) => (
                  <ProfileGapRow
                    key={`p-${i}`}
                    gap={g}
                    profileEvent={profileEvent}
                    profileLud16={profileLud16}
                    optedIn={optedIn}
                    onChanged={onProfileUpdated}
                  />
                ))
                : (
                  <p className="text-[11px] text-neutral-500 italic">
                    ✓ Payment preference is set on your profile.
                  </p>
                ))}
            </StepCard>

            {/* Step 2 — Shipping options + per-listing wiring. */}
            <StepCard
              number={2}
              title="How should buyers' apps quote shipping?"
              hint={hasShippingOptions
                ? `${shippingOptions.length} shipping option${shippingOptions.length === 1 ? '' : 's'} published — attach to each listing you want checkout-ready.`
                : 'Publish at least one structured shipping option (Shipping tab) and attach it to your listings.'}
              complete={hasShippingOptions && listingsWithGaps.length === 0}
            >
              {listingsWithGaps.length > 0 ? (
                <div className="space-y-2">
                  {listingsWithGaps.map(({ listing, gaps }) => (
                    <ListingGapRow
                      key={listing.event.id}
                      listing={listing}
                      gaps={gaps}
                      optedIn={optedIn}
                      onMigrate={() => setMigrateTarget(listing)}
                    />
                  ))}
                </div>
              ) : hasShippingOptions ? (
                <p className="text-[11px] text-neutral-500 italic">
                  ✓ Every listing is wired up with a shipping option.
                </p>
              ) : (
                <p className="text-[11px] text-neutral-500 italic">
                  No shipping options yet. Open the Shipping tab in My Selling to publish one.
                </p>
              )}
            </StepCard>

            {/* All-clear celebration */}
            {verdict.gaps.length === 0 && stepsComplete === 2 && (
              <div className="text-center py-4 rounded border border-emerald-900/60 bg-emerald-950/20">
                <div className="text-2xl mb-1" aria-hidden>✓</div>
                <p className="text-xs text-emerald-100">
                  Your shop is fully Gamma checkout-ready.
                </p>
                <p className="text-[11px] text-neutral-400 mt-0.5 max-w-sm mx-auto">
                  Buyers in any Gamma marketplace app can complete automated checkout on every listing.
                </p>
              </div>
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

/**
 * Numbered setup step. Always rendered; the `complete` prop controls
 * the muted vs neutral chrome so the panel communicates the shape of
 * Gamma checkout (two steps) regardless of where the seller is in
 * the journey.
 */
function StepCard({ number, title, hint, complete, children }) {
  return (
    <section className={`rounded border ${
      complete ? 'border-emerald-900/40 bg-emerald-950/10' : 'border-neutral-800 bg-neutral-900/30'
    }`}>
      <header className="px-3 py-2.5 border-b border-neutral-800 flex items-start gap-2.5">
        <span className={`mt-0.5 w-5 h-5 rounded-full text-[11px] font-semibold flex items-center justify-center flex-shrink-0 ${
          complete
            ? 'bg-emerald-900/60 text-emerald-100 border border-emerald-700'
            : 'bg-neutral-800 text-neutral-300 border border-neutral-700'
        }`}>
          {complete ? '✓' : number}
        </span>
        <div className="min-w-0">
          <p className="text-xs font-medium text-neutral-100">
            Step {number} — {title}
          </p>
          <p className="text-[11px] text-neutral-500 mt-0.5">{hint}</p>
        </div>
      </header>
      <div className="px-3 py-2.5">{children}</div>
    </section>
  )
}

/**
 * Profile gap row. NO_PAYMENT_PREFERENCE / INVALID_PAYMENT_PREFERENCE
 * both surface an inline 3-radio mini-form so the seller can fix
 * without leaving the panel. Other future profile gaps can fall back
 * to a generic "Open profile editor" deep link.
 */
function ProfileGapRow({ gap, profileEvent, profileLud16, optedIn, onChanged }) {
  const renderedSeverity = effectiveSeverity(gap, optedIn)
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
        <span className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${SEVERITY_DOT[renderedSeverity]}`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-neutral-100">{gap.label}</p>
          <p className="text-[11px] text-neutral-500 mt-0.5">
            {SEVERITY_LABEL[renderedSeverity]} · {gap.fix}
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
function ListingGapRow({ listing, gaps, optedIn, onMigrate }) {
  const title = listing.decoded?.title || '(untitled)'
  // Render severity using the intent-aware helper so a bare classified
  // listing on a non-opted-in shop reads as a soft prompt, not a warning.
  const renderedSeverities = gaps.map(g => effectiveSeverity(g, optedIn))
  const topSeverity = renderedSeverities.includes('error')
    ? 'error'
    : renderedSeverities.includes('warning') ? 'warning' : 'info'

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
