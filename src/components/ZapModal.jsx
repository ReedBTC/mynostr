import { useState, useEffect, useRef } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNDK, FALLBACK_RELAYS, signWithTimeout } from '../lib/ndk.js'

const PRESETS = [21, 100, 500, 1000, 5000, 10000]

// ── LNURL helpers ───────────────────────────────────────────────────────────

async function resolveLud16(lud16) {
  const [name, domain] = lud16.split('@')
  if (!name || !domain) throw new Error('Invalid lightning address')
  const res = await fetch(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`)
  if (!res.ok) throw new Error('Lightning address not reachable')
  const data = await res.json()
  if (data.status === 'ERROR') throw new Error(data.reason || 'LNURL error')
  return data // { callback, minSendable, maxSendable, commentAllowed, allowsNostr, nostrPubkey }
}

async function fetchInvoice(callback, amountMsats, comment, zapRequestJson) {
  const url = new URL(callback)
  url.searchParams.set('amount', String(amountMsats))
  if (comment?.trim()) url.searchParams.set('comment', comment.trim())
  // NIP-57: attach signed zap request event
  if (zapRequestJson) url.searchParams.set('nostr', zapRequestJson)
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error('Could not get invoice')
  const data = await res.json()
  if (data.status === 'ERROR') throw new Error(data.reason || 'Invoice error')
  if (!data.pr) throw new Error('No invoice returned')
  return data.pr
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
  onClose,
}) {
  const effectiveTargetEvent = targetEvent || articleEvent || null
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
  const pollRef = useRef(null)

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
            setPaid(true)
          }
          // Also match by description hash — just accept any zap to this recipient in this window
          const desc = ev.tags?.find(t => t[0] === 'description')?.[1]
          if (desc) {
            try {
              const zapReq = JSON.parse(desc)
              const amountTag = zapReq.tags?.find(t => t[0] === 'amount')?.[1]
              if (amountTag === String(amount * 1000)) setPaid(true)
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
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [invoice, paid, isNip57, recipientPubkey, amount])

  async function handleGetInvoice() {
    if (!amount || amount <= 0) return
    setLoading(true)
    setError('')
    try {
      const info    = await resolveLud16(lud16)
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

      const pr = await fetchInvoice(info.callback, msats, comment, zapRequestJson)
      setInvoice(pr)
      setStep('invoice')
    } catch (e) {
      setError(e.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  async function handleOpenWallet() {
    // Try WebLN first (Alby, etc.) — instant pay + confirmation
    if (window.webln) {
      try {
        await window.webln.enable()
        await window.webln.sendPayment(invoice)
        setPaid(true)
        return
      } catch {
        // User cancelled or WebLN failed — fall through to lightning: URI
      }
    }
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
                  onChange={e => setAmount(Math.max(1, Number(e.target.value) || 0))}
                  min={1}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-amber-600 placeholder-neutral-600"
                  placeholder="Custom amount in sats"
                />
              </div>

              {/* Comment */}
              <div>
                <label className="block text-xs text-neutral-500 mb-2">Note (optional)</label>
                <input
                  type="text"
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  maxLength={144}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-neutral-600 placeholder-neutral-600"
                  placeholder="Great article!"
                  onKeyDown={e => e.key === 'Enter' && handleGetInvoice()}
                />
              </div>

              {error && <p className="text-xs text-red-400 bg-red-900/20 border border-red-900/40 rounded px-3 py-2">{error}</p>}

              <button
                onClick={handleGetInvoice}
                disabled={loading || !amount || amount <= 0}
                className="w-full py-2.5 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-sm text-white font-medium transition-colors"
              >
                {loading ? 'Getting invoice…' : `Get Invoice · ${(amount || 0).toLocaleString()} sats`}
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

              <button onClick={() => setPaid(true)}
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
