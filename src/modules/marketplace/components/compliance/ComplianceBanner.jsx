/**
 * ComplianceBanner — owner-only banner above the My Selling feed when
 * the seller's shop has any Gamma compliance gaps. Pure presentation:
 * the parent (SellingTab) owns the profile fetch + verdict so the
 * banner, the header score chip, and the per-card dots all stay in
 * sync without each re-fetching the same kind 0.
 *
 * Render rules:
 *   - Hidden when `verdict.gaps` is empty (a fully checkout-ready shop).
 *   - Hidden after per-session dismiss (sessionStorage).
 *
 * Score-based copy:
 *   - Error/warning gaps: urgent ("X listings aren't checkout-ready").
 *   - Info-only gaps:     opportunistic ("Tip: …").
 */
import { useState } from 'react'

const DISMISS_KEY = 'mynostr_compliance_banner_dismissed_v1'

export default function ComplianceBanner({ verdict, onOpen }) {
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
  })

  if (!verdict || verdict.gaps.length === 0) return null
  if (dismissed) return null

  const errors   = verdict.gaps.filter(g => g.severity === 'error').length
  const warnings = verdict.gaps.filter(g => g.severity === 'warning').length
  const hasActionable = errors + warnings > 0

  // Copy swaps based on what the seller is actually facing. Numbers
  // match what the panel will list when opened.
  const headline = hasActionable
    ? `${verdict.listingCount - verdict.listingReadyCount} of your ${verdict.listingCount} listing${verdict.listingCount === 1 ? '' : 's'} ${verdict.listingCount - verdict.listingReadyCount === 1 ? "isn't" : "aren't"} checkout-ready`
    : 'Your shop is checkout-ready'
  const subline = hasActionable
    ? 'Marketplace apps (Shopstr, Plebeian, …) need a structured shipping option to quote checkout.'
    : 'Optional: tighten your profile signals so buyers know how to pay.'

  function handleDismiss() {
    setDismissed(true)
    try { sessionStorage.setItem(DISMISS_KEY, '1') } catch {}
  }

  return (
    <div className={`mb-3 px-3 py-2.5 rounded border flex items-start gap-3 ${
      hasActionable
        ? 'border-amber-900/60 bg-amber-950/20'
        : 'border-sky-900/60 bg-sky-950/15'
    }`}>
      <span className="text-lg leading-none mt-0.5" aria-hidden>
        {hasActionable ? '⚠' : '💡'}
      </span>
      <div className="flex-1 min-w-0">
        <p className={`text-xs font-medium ${hasActionable ? 'text-amber-100' : 'text-sky-100'}`}>
          {headline}
        </p>
        <p className="text-[11px] text-neutral-400 mt-0.5">
          {subline}
        </p>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <button
          type="button"
          onClick={onOpen}
          className={`text-[11px] px-2.5 py-1 rounded border transition-colors ${
            hasActionable
              ? 'border-amber-700 text-amber-100 bg-amber-900/30 hover:bg-amber-900/50'
              : 'border-sky-700 text-sky-100 bg-sky-900/20 hover:bg-sky-900/40'
          }`}
        >
          Review
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
