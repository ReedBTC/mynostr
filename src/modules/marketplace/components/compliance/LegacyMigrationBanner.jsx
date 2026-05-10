/**
 * LegacyMigrationBanner — owner-only one-time prompt that appears when
 * the seller has unhandled NIP-15 (legacy marketplace) listings.
 *
 * Distinct from ComplianceBanner deliberately:
 *   - Compliance check = ongoing concern, amber/warning chrome.
 *   - Legacy migration = one-time cleanup, sky/info chrome.
 *
 * The banner shows whenever `count > 0`. Permanent suppression only
 * happens through the modal (per-item "Ignore forever" radios) or by
 * completing the migration — there's no "don't show again" affordance
 * here, because doing so would bypass the deliberate per-item review.
 *
 * Session dismiss: clicking ✕ hides for the current tab session via
 * sessionStorage. Same key is shared across all sellers since this is
 * UI-state, not per-pubkey data — switching accounts in the same tab
 * starts fresh, which is the right behavior (different seller, the
 * dismiss doesn't apply).
 */
import { useState } from 'react'

const DISMISS_KEY = 'mynostr_legacy_banner_dismissed_v1'

export default function LegacyMigrationBanner({ count, onOpen }) {
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
  })

  if (!count || count <= 0) return null
  if (dismissed) return null

  function handleDismiss() {
    setDismissed(true)
    try { sessionStorage.setItem(DISMISS_KEY, '1') } catch {}
  }

  return (
    <div className="mb-3 px-3 py-2.5 rounded border border-sky-900/60 bg-sky-950/20 flex items-start gap-3">
      <span className="text-lg leading-none mt-0.5" aria-hidden>📦</span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-sky-100">
          You have {count} legacy listing{count === 1 ? '' : 's'} from older marketplace clients
        </p>
        <p className="text-[11px] text-neutral-400 mt-0.5">
          Migrate them to the modern NIP-99 / Gamma format so they're checkout-ready in apps like Shopstr and Plebeian Market.
        </p>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <button
          type="button"
          onClick={onOpen}
          className="text-[11px] px-2.5 py-1 rounded border border-sky-700 bg-sky-900/30 text-sky-100 hover:bg-sky-900/50 transition-colors"
        >
          Migrate Old Listings
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          title="Hide for this session"
          aria-label="Dismiss"
          className="text-neutral-500 hover:text-neutral-200 px-1"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
