/**
 * PrePublishRelayCheckModal — pre-publish advisory for marketplace
 * listings. Fires when the user clicks Publish and either:
 *   - Their kind 10002 doesn't include wss://relay.plebeian.market
 *     (cross-marketplace reach, and the listing won't be editable
 *     /deletable on that relay later if it's not in the user's outbox).
 *   - They have no kind 10050 entries (buyers can't DM about the listing
 *     without an inbox relay).
 *
 * Both checks are advisory — the footer's "Publish anyway" closes the
 * modal and continues the publish. Adding the suggested relays inline
 * uses the same useRelayCopier flow the Advanced panel already uses;
 * the +/✓ controls update in place as the user accepts each AddRelay
 * confirmation.
 *
 * The modal renders only the failing sections — if the user has Plebeian
 * but no DM inbox, only the DM section appears (and vice versa). Parent
 * passes those flags after running the checks itself; this component
 * stays presentation-only so the publish flow can stay synchronous
 * once the user dismisses.
 */
import { useEffect } from 'react'
import { Z } from '../../../../lib/zIndex.js'
import { RECOMMENDED_DM_RELAYS } from '../../../../lib/relayInfo.js'
import { useRelayCopier, CopyButton } from '../../../profile/useRelayCopier.jsx'

const PLEBEIAN_RELAY_URL = 'wss://relay.plebeian.market'

export default function PrePublishRelayCheckModal({
  missingPlebeian,
  missingDmRelay,
  onConfirm,
  onCancel,
}) {
  // allowOwn:true — composer is owner-only territory; the default
  // copier mode would gate canCopy off because the viewer IS the
  // viewed user.
  const mainCopier = useRelayCopier({ kind: 'main', allowOwn: true })
  const dmCopier   = useRelayCopier({ kind: 'dm',   allowOwn: true })

  // Esc closes — matches every other modal in the app. Skip while a
  // nested AddRelayConfirm is open; that one owns its own Esc handler
  // and we don't want to double-dismiss.
  useEffect(() => {
    function onKey(e) {
      if (e.key !== 'Escape') return
      if (mainCopier.modalElement || dmCopier.modalElement) return
      onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel, mainCopier.modalElement, dmCopier.modalElement])

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/60 ${Z.modal} flex items-center justify-center p-4`}
        onMouseDown={onCancel}
      >
        <div
          className={`bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-full max-w-md ${Z.modalContent} max-h-[85vh] overflow-y-auto`}
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-neutral-800">
            <h3 className="text-sm font-medium text-neutral-100">Before you publish</h3>
            <button
              type="button"
              onClick={onCancel}
              className="text-neutral-500 hover:text-neutral-200 text-lg leading-none"
              aria-label="Cancel"
            >
              ×
            </button>
          </div>

          <div className="px-4 py-3 space-y-4">
            {missingPlebeian && (
              <section>
                <h4 className="text-xs font-medium text-neutral-200 mb-1.5">
                  Add the Plebeian Market relay
                </h4>
                <p className="text-[11px] text-neutral-500 leading-relaxed mb-2">
                  Plebeian Market and other Nostr marketplace clients read
                  from <span className="font-mono text-neutral-300">relay.plebeian.market</span> first.
                  Adding it to your relay list improves listing reach and
                  ensures future edits / deletes propagate there too.
                </p>
                <div className="flex items-start gap-2 px-2 py-1.5 rounded border border-neutral-800">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-neutral-200">Plebeian Market</div>
                    <div className="text-[10px] text-neutral-600 font-mono truncate">{PLEBEIAN_RELAY_URL}</div>
                  </div>
                  <div className="flex-shrink-0 pt-0.5">
                    <CopyButton url={PLEBEIAN_RELAY_URL} read={true} write={true} {...mainCopier} />
                  </div>
                </div>
              </section>
            )}

            {missingDmRelay && (
              <section>
                <h4 className="text-xs font-medium text-neutral-200 mb-1.5">
                  Set up a DM inbox
                </h4>
                <p className="text-[11px] text-neutral-500 leading-relaxed mb-2">
                  Without a NIP-17 DM relay, buyers can't message you about
                  the listing. Pick at least one — your DM list (kind 10050)
                  is separate from your main relays, so adding here doesn't
                  affect anything else.
                </p>
                <ul className="space-y-1.5">
                  {RECOMMENDED_DM_RELAYS.map(({ url, label, hint }) => (
                    <li
                      key={url}
                      className="flex items-start gap-2 px-2 py-1.5 rounded border border-neutral-800"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-neutral-200">{label}</div>
                        <div className="text-[10px] text-neutral-500">{hint}</div>
                        <div className="text-[10px] text-neutral-600 font-mono truncate">{url}</div>
                      </div>
                      <div className="flex-shrink-0 pt-0.5">
                        <CopyButton url={url} {...dmCopier} />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-neutral-800">
            <button
              type="button"
              onClick={onCancel}
              className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="text-xs px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors"
            >
              Publish anyway
            </button>
          </div>
        </div>
      </div>

      {/* Nested AddRelayConfirm modals owned by useRelayCopier — render
          AFTER our own modal markup so they stack on top via z-[60]. */}
      {mainCopier.modalElement}
      {dmCopier.modalElement}
    </>
  )
}
