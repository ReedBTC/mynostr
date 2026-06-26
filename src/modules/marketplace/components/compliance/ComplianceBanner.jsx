/**
 * ComplianceBanner — owner-only banner above the My Selling feed,
 * surfacing the seller's Gamma checkout setup state.
 *
 * Tone is intent-aware:
 *   - Shop hasn't opted in to Gamma + only soft gaps → sky chrome,
 *     "Want automated checkout?" prompt. Gamma is optional; classified-
 *     style listings work fine without it.
 *   - Shop has opted in (any 30406 published OR payment_preference
 *     set) AND has any unfinished/broken setup → amber chrome,
 *     "X listings need attention" warning.
 *   - Fully clean (no gaps at all) → hidden. Nothing to show.
 *
 * Severity translation lives in gammaCompliance.effectiveSeverity —
 * the grader stays spec-faithful, the UI is intent-aware.
 */
import { storageKey } from '../../../../lib/brand.js'
import { useState } from 'react'
import { effectiveSeverity } from '../../../../lib/gammaCompliance.js'
import WhatIsGammaPopover from './WhatIsGammaPopover.jsx'

const DISMISS_KEY = storageKey('compliance_banner_dismissed_v1')

export default function ComplianceBanner({ verdict, hasOptedIn, onOpen }) {
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
  })

  if (!verdict || verdict.gaps.length === 0) return null
  if (dismissed) return null

  // Render-time severities given shop intent. Soft prompts (no-shipping,
  // no-payment-pref) on a shop that hasn't opted in stay info; everything
  // else is the grader's natural severity.
  const renderedGaps = verdict.gaps.map(g => ({
    ...g,
    rendered: effectiveSeverity(g, hasOptedIn),
  }))
  const hardCount = renderedGaps.filter(g => g.rendered !== 'info').length
  const isHardState = hardCount > 0

  const handleDismiss = () => {
    setDismissed(true)
    try { sessionStorage.setItem(DISMISS_KEY, '1') } catch {}
  }

  // Two visual states. Copy is meaningfully different — the soft state
  // is an opt-in invitation, the hard state is a punch list. Both
  // intentionally render in neutral chrome (no amber/red): "missing
  // checkout setup" is a soft prompt the seller may legitimately
  // never want to complete (services, classifieds, etc.). The amber
  // alarm is reserved for the per-listing pill where it's actionable.
  const tone = isHardState
    ? { box: 'border-neutral-800 bg-neutral-900/40', icon: '🛒', headline: 'text-neutral-100',
        button: 'border-purple-700 text-purple-200 bg-purple-950/30 hover:bg-purple-900/40 hover:text-purple-100' }
    : { box: 'border-neutral-800 bg-neutral-900/40', icon: '🛒', headline: 'text-neutral-100',
        button: 'border-purple-700 text-purple-200 bg-purple-950/30 hover:bg-purple-900/40 hover:text-purple-100' }

  // Hard-state numbers come from the grader's listingReadyCount math.
  // Soft-state copy doesn't quote numbers — it's a prompt, not a punch list.
  const unreadyCount = verdict.listingCount - verdict.listingReadyCount
  const headline = isHardState
    ? `${unreadyCount} of your ${verdict.listingCount} listing${verdict.listingCount === 1 ? '' : 's'} ${unreadyCount === 1 ? 'needs' : 'need'} additional information to be checkout-ready (Gamma spec)`
    : 'Want your listings to support automated checkout?'

  return (
    <div className={`mb-3 px-3 py-2.5 rounded border flex items-start gap-3 ${tone.box}`}>
      <span className="text-lg leading-none mt-0.5" aria-hidden>{tone.icon}</span>
      <div className="flex-1 min-w-0">
        <p className={`text-xs font-medium ${tone.headline}`}>{headline}</p>
        <p className="text-[11px] text-neutral-400 mt-0.5">
          {isHardState ? (
            <>Open the setup panel to see what each listing needs. <WhatIsGammaPopover /></>
          ) : (
            <>
              <span className="font-medium text-neutral-300">Gamma</span> is an
              optional NIP-99 extension that lets apps like Shopstr and Plebeian
              Market quote prices and route payments for you. Skip it if your
              listings are classifieds (DM-to-buy works fine). <WhatIsGammaPopover />
            </>
          )}
        </p>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <button
          type="button"
          onClick={onOpen}
          className={`text-[11px] px-2.5 py-1 rounded border transition-colors ${tone.button}`}
        >
          {isHardState ? 'Complete setup' : 'Set up checkout'}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          title="Hide for this session"
          className="text-neutral-500 hover:text-neutral-200 px-1"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
