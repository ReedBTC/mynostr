import { SUPPLEMENTAL_PUBLISH_RELAYS } from '../../../../lib/marketplaceRelays.js'
import { useRelayCopier, CopyButton } from '../../../profile/useRelayCopier.jsx'

/**
 * MarketplaceRelaySuggestions — inside the Sell composer's Advanced
 * panel.
 *
 * Curated marketplace relays with a ✓ when the user already has them in
 * their kind 10002 list, or a + button to add the relay to their list
 * (publishes a fresh 10002 with the URL appended).
 *
 * Adding to 10002 (vs supplementing per-publish) is deliberately the
 * better path: every future publish, edit, and delete naturally reaches
 * those relays without per-event opt-in. Critically, kind 5 deletions
 * propagate correctly, so listings remain unpublishable from any client
 * that respects NIP-09.
 *
 * Paid relays render an additional "Sign up ↗" link plus a "Paid" pill
 * — without payment, writes silently fail, and surfacing the signup
 * URL inline saves users from a confusing dead-end.
 */
export default function MarketplaceRelaySuggestions() {
  // allowOwn:true — composer is owner-only, so the user IS viewing
  // their own page; the default copier mode would gate canCopy off.
  const copier = useRelayCopier({ kind: 'main', allowOwn: true })

  return (
    <div className="mt-3 pt-3 border-t border-neutral-800">
      <div className="mb-2.5">
        <p className="text-xs text-neutral-300 font-medium">Marketplace relays</p>
        <p className="text-[10px] text-neutral-500 leading-relaxed">
          Add these to your relay list to improve listing reach for
          marketplace clients. <span className="text-green-400">✓</span> means it's
          already in your list. Click <span className="text-neutral-300">+</span> to
          add — your future publishes, edits, and deletes will all
          reach the relay too.
        </p>
      </div>

      <ul className="space-y-1.5">
        {SUPPLEMENTAL_PUBLISH_RELAYS.map(({ url, label, hint, paid, signupUrl }) => (
          <li
            key={url}
            className="flex items-start gap-2 px-2 py-1.5 rounded border border-neutral-800"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs text-neutral-200">{label}</span>
                {paid && (
                  <span className="text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-800/60">
                    Paid
                  </span>
                )}
              </div>
              <div className="text-[10px] text-neutral-500">{hint}</div>
              <div className="text-[10px] text-neutral-600 font-mono truncate">{url}</div>
              {paid && signupUrl && (
                <a
                  href={signupUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-purple-400 hover:text-purple-300 underline mt-0.5 inline-block"
                >
                  Sign up / pay ↗
                </a>
              )}
            </div>

            <div className="flex-shrink-0 pt-0.5">
              <CopyButton url={url} read={true} write={true} {...copier} />
            </div>
          </li>
        ))}
      </ul>

      {copier.modalElement}
    </div>
  )
}
