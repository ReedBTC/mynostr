/**
 * MigrateLegacyListingsModal — surfaces detected NIP-15 (kind 30017
 * stalls + kind 30018 products) and hands the seller off to Plebeian
 * Market's migration tool, which already does the NIP-15 → NIP-99
 * conversion well.
 *
 * Why we don't migrate in-app: the conversion is a one-time job for a
 * shrinking population. Plebeian's purpose-built tool covers it; we
 * detect, verify, redirect. The "I've already migrated" path lets the
 * seller permanently silence our banner once they're done over there.
 */
import { useEffect } from 'react'

const PLEBEIAN_MIGRATION_URL = 'https://plebeian.market/dashboard/products/migration-tool'

export default function MigrateLegacyListingsModal({
  candidates,        // parsed kind-30018 products still awaiting handling
  stalls,            // parsed kind-30017 stalls (for grouping context)
  onMarkAllHandled,  // () => void — clears the banner permanently for this seller
  onClose,
}) {
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Group candidates by stall_id so the modal can show stall headers.
  // Products with no resolvable stall fall under a synthetic "Orphan
  // products" group — mostly products whose stall the seller deleted
  // before migrating, or 30018s published without a parent 30017.
  const stallById = new Map(stalls.map(s => [s.id, s]))
  const groups = new Map()
  for (const p of candidates) {
    const key = p.stallId && stallById.has(p.stallId) ? p.stallId : '__orphan__'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(p)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onMouseDown={onClose}
    >
      <div
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 flex-shrink-0">
          <h2 className="text-sm font-semibold text-neutral-100">
            Migrate legacy listings
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-neutral-500 hover:text-neutral-200 text-lg leading-none"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          <div className="text-xs text-neutral-400 space-y-1.5">
            <p>
              Found <span className="text-neutral-200 font-medium">{candidates.length}</span> legacy product{candidates.length === 1 ? '' : 's'}
              {stalls.length > 0 && (
                <> across <span className="text-neutral-200 font-medium">{stalls.length}</span> stall{stalls.length === 1 ? '' : 's'}</>
              )}
              {' '}on your pubkey.
            </p>
            <p>
              MyNostr doesn't migrate these in-app — Plebeian Market has a purpose-built tool that handles the NIP-15 → NIP-99 conversion. It signs in with your existing Nostr key, so the new listings publish under the same identity. Once you're done over there, click <span className="text-neutral-300">"I've already migrated these"</span> to dismiss this banner permanently.
            </p>
          </div>

          {[...groups.entries()].map(([key, products]) => {
            const stall = key === '__orphan__' ? null : stallById.get(key)
            return (
              <section key={key} className="border border-neutral-800 rounded">
                <header className="px-3 py-2 bg-neutral-950/40 border-b border-neutral-800 flex items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-neutral-200 truncate">
                      {stall ? `Stall: ${stall.name}` : 'Orphan products (no parent stall)'}
                    </p>
                    {stall && stall.shipping.length > 0 && (
                      <p className="text-[11px] text-neutral-500 mt-0.5">
                        {stall.shipping.length} shipping zone{stall.shipping.length === 1 ? '' : 's'} — will become {stall.shipping.length} shipping option{stall.shipping.length === 1 ? '' : 's'} in Gamma format
                      </p>
                    )}
                  </div>
                  <span className="text-[11px] text-neutral-500 flex-shrink-0">
                    {products.length} product{products.length === 1 ? '' : 's'}
                  </span>
                </header>
                <ul className="divide-y divide-neutral-800">
                  {products.map(p => (
                    <li key={p.eventId} className="px-3 py-2 flex items-baseline justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-neutral-200 truncate" title={p.name}>{p.name}</p>
                        <p className="text-[11px] text-neutral-500 mt-0.5">
                          {formatPrice(p.price, p.currency)}
                          {p.quantity != null && <> · stock {p.quantity}</>}
                          {p.images.length > 0 && <> · {p.images.length} image{p.images.length === 1 ? '' : 's'}</>}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>

        <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-neutral-800 flex-shrink-0">
          <button
            type="button"
            onClick={() => { onMarkAllHandled?.(); onClose?.() }}
            className="text-[11px] text-neutral-500 hover:text-neutral-300 underline-offset-2 hover:underline transition-colors"
          >
            I've already migrated these — hide this banner
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
            >
              Close
            </button>
            <a
              href={PLEBEIAN_MIGRATION_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors"
            >
              Open Migration Tool on Plebeian ↗
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}

function formatPrice(price, currency) {
  if (!Number.isFinite(price)) return '—'
  const cur = currency || ''
  if (cur === 'SATS' || cur === 'SAT') {
    return `${Math.round(price).toLocaleString()} sats`
  }
  return `${price} ${cur}`.trim()
}
