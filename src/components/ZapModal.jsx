import { useState, useEffect, useRef } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNDK, FALLBACK_RELAYS, signWithTimeout } from '../lib/ndk.js'
import * as nwc from '../lib/nwc.js'
import * as webln from '../lib/webln.js'
import { useWalletStatus } from '../lib/useWalletStatus.js'
import { markZapped, unmarkZapped, markZapPending, clearZapPending } from '../lib/myZapStore.js'
import { allocateMsats } from '../lib/zapSplits.js'
import { payZapSplits } from '../lib/payZapSplits.js'
import { fetchLnurlMeta, fetchLnurlInvoice } from '../lib/lnurl.js'

const PRESETS = [21, 100, 500, 1000, 5000, 10000]
// Catch fat-finger paste accidents before any LNURL/NWC round-trip.
// LNURL minSendable/maxSendable still apply on top of this.
const MAX_SATS = 5_000_000

// NWC takes precedence when both are connected (NWC is the explicit
// connect path; WebLN can re-enable silently from the persisted flag).
function payInvoiceViaActiveWallet(bolt11) {
  if (nwc.isReady())   return nwc.payInvoice(bolt11)
  if (webln.isReady()) return webln.payInvoice(bolt11)
  return Promise.reject(new Error('No wallet connected'))
}
function anyWalletReady() {
  return nwc.isReady() || webln.isReady()
}

// ── Build and sign NIP-57 zap request (kind 9734) ───────────────────────────

async function buildZapRequest({ recipientPubkey, targetEvent, aTag, targetKind, amountMsats, comment }) {
  const ndk = getNDK()
  const ev = new NDKEvent(ndk)
  ev.kind = 9734
  ev.content = comment || ''
  ev.tags = [
    ['p', recipientPubkey],
    ['amount', String(amountMsats)],
    ['relays', ...FALLBACK_RELAYS],
  ]

  // Reference the specific event being zapped
  if (aTag) ev.tags.push(['a', aTag])
  if (targetEvent?.id) ev.tags.push(['e', targetEvent.id])
  if (targetKind) ev.tags.push(['k', String(targetKind)])

  await signWithTimeout(ev)
  return JSON.stringify(ev.rawEvent())
}

// ── Component ───────────────────────────────────────────────────────────────

export default function ZapModal({
  lud16,
  recipientPubkey,
  recipientName,
  targetEvent,
  articleEvent, // legacy alias — longform callers still pass this
  aTag,
  targetKind = '30023',
  user,
  zapSplits,    // NIP-57.5 splits parsed from the target event's tags
  onClose,
}) {
  const effectiveTargetEvent = targetEvent || articleEvent || null
  const walletStatus          = useWalletStatus()
  const [step,    setStep]    = useState('amount')  // 'amount' | 'invoice'
  const [amount,  setAmount]  = useState(21)
  const [comment, setComment] = useState('')
  const [invoice, setInvoice] = useState('')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const [copied,  setCopied]  = useState(false)
  const [isNip57, setIsNip57] = useState(false)
  const [paid,    setPaid]    = useState(false)
  const subRef = useRef(null)

  // Single success path — flips the modal to the "Zap sent!" view AND
  // records the zap in the session-wide store so every zap button across
  // the app picks up the "already zapped" styling without waiting for
  // the relay round-trip on the kind 9735 receipt. Idempotent.
  function recordZapSuccess() {
    setPaid(true)
    markZapped({
      eventId:     effectiveTargetEvent?.id || null,
      addressable: aTag || null,
    })
  }

  // Listen for kind 9735 zap receipt on relays (NIP-57 path)
  // Also poll the LNURL verify endpoint as fallback (works for plain invoices too)
  useEffect(() => {
    if (!invoice || paid) return

    // Relay subscription for zap receipts
    if (isNip57 && recipientPubkey) {
      try {
        const ndk = getNDK()
        const sub = ndk.subscribe(
          { kinds: [9735], '#p': [recipientPubkey], since: Math.floor(Date.now() / 1000) - 30 },
          { closeOnEose: false }
        )
        sub.on('event', (ev) => {
          // Check if this receipt's bolt11 matches our invoice
          const bolt11 = ev.tags?.find(t => t[0] === 'bolt11')?.[1]
          if (bolt11 && invoice.toLowerCase().startsWith(bolt11.toLowerCase().slice(0, 20))) {
            recordZapSuccess()
          }
          // Also match by description hash — just accept any zap to this recipient in this window
          const desc = ev.tags?.find(t => t[0] === 'description')?.[1]
          if (desc) {
            try {
              const zapReq = JSON.parse(desc)
              const amountTag = zapReq.tags?.find(t => t[0] === 'amount')?.[1]
              if (amountTag === String(amount * 1000)) recordZapSuccess()
            } catch {}
          }
        })
        subRef.current = sub
      } catch {}
    }

    // Polling fallback: check WebLN or just auto-close after wallet open
    // Many wallets don't have verify URLs, so we also check via a simple timer
    // after the user clicks "Open in Wallet"
    return () => {
      if (subRef.current) {
        try { subRef.current.stop() } catch {}
        subRef.current = null
      }
    }
  }, [invoice, paid, isNip57, recipientPubkey, amount])

  const hasSplits = Array.isArray(zapSplits) && zapSplits.length > 0

  async function handleGetInvoice() {
    if (!amount || amount <= 0) return
    if (amount > MAX_SATS) {
      setError(`Maximum amount: ${MAX_SATS.toLocaleString()} sats`)
      return
    }
    setLoading(true)
    setError('')

    // Splits + connected wallet: the orchestrator runs the whole multi-leg
    // pipeline (resolve each lud16, sign per-leg zap-requests, fetch
    // invoices, pay sequentially). Same close-immediately + optimistic
    // mark UX as a single-recipient zap — the button glows + pulses on
    // the *target* event's button until every leg has settled. Per-leg
    // failures are silent (best-effort). A total bust (every leg fails)
    // reverts the optimistic mark.
    if (hasSplits && anyWalletReady()) {
      const target = {
        eventId:     effectiveTargetEvent?.id || null,
        addressable: aTag || null,
      }
      const allocations = allocateMsats(amount * 1000, zapSplits)
      // markZapPending FIRST so markZapped's pending-check defers
      // persistence — a tab close mid-NWC-pay won't leave a stale
      // localStorage entry; clearZapPending commits on success or
      // unmarkZapped + clearZapPending cleans up on failure.
      markZapPending(target)
      markZapped(target)
      onClose()
      ;(async () => {
        const t0 = Date.now()
        console.info(`[mynostr-nwc] zap split: ${allocations.length} legs, ${amount} sats total`)
        try {
          const result = await payZapSplits({
            splits:      zapSplits,
            allocations,
            targetEvent: effectiveTargetEvent,
            aTag,
            targetKind,
            comment:     comment.trim(),
          })
          const paidLegs = result.legs.filter(l => l.status === 'paid').length
          console.info(`[mynostr-nwc] zap split: ${paidLegs}/${result.legs.length} legs paid in ${Date.now() - t0}ms`)
          if (!result.anySucceeded) unmarkZapped(target)
        } catch (e) {
          // payZapSplits is documented as never-throws; defense-in-depth.
          console.warn('[mynostr-nwc] split orchestrator threw:', e?.message || e)
          unmarkZapped(target)
        } finally {
          clearZapPending(target)
        }
      })()
      return
    }

    try {
      const info    = await fetchLnurlMeta(lud16)
      const msats   = amount * 1000
      const minSats = Math.ceil(info.minSendable / 1000)
      const maxSats = Math.floor(info.maxSendable / 1000)
      if (amount < minSats) throw new Error(`Minimum amount: ${minSats} sats`)
      if (amount > maxSats) throw new Error(`Maximum amount: ${maxSats.toLocaleString()} sats`)

      // NIP-57: if the LNURL server supports Nostr zaps, build a zap request
      let zapRequestJson = null
      if (info.allowsNostr && info.nostrPubkey && user?.pubkey) {
        try {
          zapRequestJson = await buildZapRequest({
            recipientPubkey,
            targetEvent: effectiveTargetEvent,
            aTag,
            targetKind,
            amountMsats: msats,
            comment: comment.trim(),
          })
          setIsNip57(true)
        } catch (e) {
          // Fall back to plain LNURL-pay if zap request fails
          if (import.meta.env.DEV) console.warn('NIP-57 zap request failed, falling back to plain invoice:', e)
        }
      }

      const { pr } = await fetchLnurlInvoice(info.callback, msats, comment.trim(), zapRequestJson)
      setInvoice(pr)

      // Wallet connected (NWC or WebLN) — close the modal immediately,
      // optimistically mark the target zapped (button glows), flip
      // pendingZap (button pulses), and run payInvoice in the background.
      // When the preimage lands the pulse stops and the lit-up state
      // stays. If payment fails we revert the optimistic mark — the user
      // sees the button un-zap itself, matching the "no half-promised
      // UI" rule we use for likes.
      if (anyWalletReady()) {
        const target = {
          eventId:     effectiveTargetEvent?.id || null,
          addressable: aTag || null,
        }
        // markZapPending FIRST — see splits branch for rationale.
        markZapPending(target)
        markZapped(target)
        onClose()
        ;(async () => {
          const t0 = Date.now()
          console.info('[mynostr-zap] payInvoice: sending request (background)')
          try {
            await payInvoiceViaActiveWallet(pr)
            console.info(`[mynostr-zap] payInvoice: settled in ${Date.now() - t0}ms`)
          } catch (e) {
            const msg = String(e?.message || e)
            console.warn(`[mynostr-zap] payInvoice failed after ${Date.now() - t0}ms:`, msg)
            unmarkZapped(target)
          } finally {
            clearZapPending(target)
          }
        })()
        return
      }

      setStep('invoice')
    } catch (e) {
      setError(e.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  function handleOpenWallet() {
    // Hand off to the OS / browser's `lightning:` handler. We deliberately
    // don't probe window.webln here: a user who has WebLN would have
    // connected it via the wallet modal and we'd never have reached the
    // QR step. A user who reaches this step (no wallet connected and
    // wants to pay externally) deserves their `lightning:` handler — not
    // a silent extension prompt that conflicts with their phone-scan
    // intent.
    window.open(`lightning:${invoice}`, '_blank')
  }

  function handleCopy() {
    navigator.clipboard.writeText(invoice)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onMouseDown={onClose}
      onClick={e => e.stopPropagation()}>
      <div className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-full max-w-sm"
        onMouseDown={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-200">
            Zap {recipientName && !/^[a-f0-9]{8,}$/i.test(recipientName) ? recipientName : lud16}
          </h2>
          <button onClick={onClose}
            className="text-neutral-500 hover:text-neutral-300 transition-colors text-lg leading-none">
            ✕
          </button>
        </div>

        <div className="p-4">
          {step === 'amount' ? (
            <div className="space-y-4">
              {/* Preset amounts */}
              <div>
                <label className="block text-xs text-neutral-500 mb-2">Amount (sats)</label>
                <div className="flex gap-1.5 flex-wrap mb-3">
                  {PRESETS.map(a => (
                    <button key={a} onClick={() => setAmount(a)}
                      className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                        amount === a
                          ? 'border-amber-600 bg-amber-900/30 text-amber-300'
                          : 'border-neutral-700 text-neutral-500 hover:border-neutral-500 hover:text-neutral-300'
                      }`}>
                      {a.toLocaleString()}
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  value={amount}
                  onChange={e => setAmount(Math.min(MAX_SATS, Math.max(1, Number(e.target.value) || 0)))}
                  min={1}
                  max={MAX_SATS}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-amber-600 placeholder-neutral-600"
                  placeholder="Custom amount in sats"
                />
              </div>

              {/* Comment — auto-resizes up to ~6 rows. LNURL servers cap
                  via commentAllowed; we keep a generous client-side max
                  so a long note isn't silently truncated mid-edit. */}
              <div>
                <label className="block text-xs text-neutral-500 mb-2">Note (optional)</label>
                <textarea
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  maxLength={500}
                  rows={1}
                  ref={(el) => {
                    if (!el) return
                    el.style.height = 'auto'
                    el.style.height = `${Math.min(el.scrollHeight, 144)}px`
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleGetInvoice()
                    }
                  }}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-neutral-600 placeholder-neutral-600 resize-none overflow-y-auto"
                  placeholder="Great article!"
                />
              </div>

              {error && <p className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 rounded px-3 py-2">{error}</p>}

              {hasSplits && (
                <div className="text-[11px] rounded border border-neutral-800 px-2.5 py-2 space-y-1">
                  <p className="text-neutral-400 flex items-center gap-1.5">
                    <span aria-hidden>🔀</span>
                    <span>
                      This {targetKind === '30023' ? 'article' : 'note'} splits zaps {zapSplits.length} ways
                      <span className="text-neutral-600"> · {zapSplits.map(s => `${s.pct}%`).join(' / ')}</span>
                    </span>
                  </p>
                  {!walletStatus?.connected && (
                    <p className="text-amber-400/90 leading-snug">
                      Connect a Lightning wallet to honor the split. Without one, your zap goes 100% to the author.
                    </p>
                  )}
                </div>
              )}

              {walletStatus?.connected && (
                <p className="text-[11px] text-neutral-500 flex items-center gap-1.5">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" aria-hidden="true" />
                  <span className="truncate">
                    {hasSplits
                      ? `Pays each split recipient via ${walletStatus.alias || 'your connected wallet'}`
                      : `Pays via your connected wallet${walletStatus.alias ? ` · ${walletStatus.alias}` : ''}`}
                  </span>
                </p>
              )}

              <button
                onClick={handleGetInvoice}
                disabled={loading || !amount || amount <= 0}
                className="w-full py-2.5 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-sm text-white font-medium transition-colors"
              >
                {loading
                  ? 'Getting invoice…'
                  : walletStatus?.connected
                    ? `Send Zap · ${(amount || 0).toLocaleString()} sats`
                    : `Get Invoice · ${(amount || 0).toLocaleString()} sats`}
              </button>
            </div>
          ) : paid ? (
            <div className="space-y-4 py-4">
              {/* Paid confirmation */}
              <div className="flex justify-center">
                <div className="w-20 h-20 rounded-full bg-green-900/30 border-2 border-green-500 flex items-center justify-center">
                  <svg className="w-10 h-10 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              </div>
              <p className="text-center text-sm font-medium text-green-400">
                Zap sent!
              </p>
              <p className="text-center text-xs text-neutral-500">
                {(amount || 0).toLocaleString()} sats to {recipientName && !/^[a-f0-9]{8,}$/i.test(recipientName) ? recipientName : lud16}
              </p>
              <button onClick={onClose}
                className="w-full py-2.5 rounded bg-green-600 hover:bg-green-500 text-sm text-white font-medium transition-colors">
                Done
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {/* QR Code */}
              <div className="flex justify-center bg-white rounded-lg p-4">
                <QRCodeSVG
                  value={invoice.toUpperCase()}
                  size={216}
                  level="L"
                />
              </div>

              <p className="text-center text-xs text-neutral-500">
                Scan with any Lightning wallet
                {isNip57 && <span className="text-amber-600"> · NIP-57 zap</span>}
              </p>

              {/* Truncated invoice */}
              <div className="bg-neutral-800 rounded px-3 py-2 font-mono text-xs text-neutral-600 break-all line-clamp-2">
                {invoice.slice(0, 80)}…
              </div>

              <div className="flex gap-2">
                <button onClick={handleCopy}
                  className="flex-1 py-2 rounded border border-neutral-700 text-xs text-neutral-300 hover:bg-neutral-800 transition-colors">
                  {copied ? '✓ Copied!' : 'Copy Invoice'}
                </button>
                <button onClick={handleOpenWallet}
                  className="flex-1 py-2 rounded bg-amber-600 hover:bg-amber-500 text-xs text-white font-medium transition-colors">
                  Open in Wallet
                </button>
              </div>

              <button onClick={() => recordZapSuccess()}
                className="w-full text-xs text-neutral-500 hover:text-green-400 transition-colors py-1">
                I already paid this
              </button>

              <button onClick={() => { setStep('amount'); setInvoice(''); setIsNip57(false); setPaid(false) }}
                className="w-full text-xs text-neutral-600 hover:text-neutral-400 transition-colors py-1">
                ← Change amount
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
