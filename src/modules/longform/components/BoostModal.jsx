import { useState, useEffect, useRef } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import {
  PROJECT_OWNER_NPUB,
  FALLBACK_LUD16,
  resolveRecipientLud16,
  fetchLnurlMeta,
  fetchLnurlInvoice,
  bolt11PaymentHash,
  generateBurnerKeypair,
  publishDonationBoostagram,
  pollVerify,
} from '../lib/boostagram.js'

const POLL_INTERVAL_MS = 2500
const PRESETS = [21, 210, 2100, 21000]

export default function BoostModal({ user, onClose, readOnly }) {
  const [amount, setAmount] = useState('21')
  const [message, setMessage] = useState('')

  // Recipient resolution
  const [recipientLud16, setRecipientLud16] = useState(null)
  const [lnurlMeta, setLnurlMeta] = useState(null)
  const [initError, setInitError] = useState('')

  // Invoice + event state
  const [invoice, setInvoice] = useState('')
  const [eventId, setEventId] = useState('')
  const [verifyUrl, setVerifyUrl] = useState(null)

  const [anonymous, setAnonymous] = useState(!!readOnly)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [paid, setPaid] = useState(false)

  const stopPollRef = useRef(null)
  const donorNpub = user?.npub || ''
  const profile = user?.profile

  // Resolve project owner's lud16 from their kind 0 profile on mount
  useEffect(() => {
    async function init() {
      let lud16 = FALLBACK_LUD16
      try {
        lud16 = await resolveRecipientLud16(PROJECT_OWNER_NPUB)
      } catch {
        // Kind 0 fetch failed or npub not yet configured — use hardcoded fallback
      }
      try {
        const meta = await fetchLnurlMeta(lud16)
        setRecipientLud16(lud16)
        setLnurlMeta(meta)
      } catch (e) {
        setInitError(`Couldn't reach lightning address: ${e.message}`)
      }
    }
    init()
  }, [])

  // Start polling once we have an invoice + verify URL
  useEffect(() => {
    if (!verifyUrl || !invoice || paid) return
    stopPollRef.current = pollVerify(verifyUrl, POLL_INTERVAL_MS, () => setPaid(true))
    return () => stopPollRef.current?.()
  }, [verifyUrl, invoice])

  useEffect(() => {
    if (paid) stopPollRef.current?.()
  }, [paid])

  useEffect(() => {
    function handleKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  async function handleGenerate() {
    setError('')
    const sats = parseInt(amount, 10)
    if (!sats || sats < 1) { setError('Enter a valid amount.'); return }
    if (!lnurlMeta) { setError('Lightning address not ready — try again.'); return }

    const minSats = Math.ceil((lnurlMeta.minSendable || 1000) / 1000)
    const maxSats = Math.floor((lnurlMeta.maxSendable || 1_000_000_000) / 1000)
    if (sats < minSats || sats > maxSats) {
      setError(`Amount must be between ${minSats.toLocaleString()} and ${maxSats.toLocaleString()} sats.`)
      return
    }

    // LNURL comment carries human-readable context (separate from the Nostr event)
    const commentParts = ['[nostrmd boost]']
    if (message.trim()) commentParts.push(message.trim())
    const comment = commentParts.join(' — ')
    const maxLen = lnurlMeta.commentAllowed || 0
    const trimmedComment = maxLen > 0 ? comment.slice(0, maxLen) : comment

    setLoading(true)
    try {
      // 1. Fetch invoice
      const { pr, verify } = await fetchLnurlInvoice(lnurlMeta.callback, sats * 1000, trimmedComment)

      // 2. Extract payment hash — links the kind 30078 event to this specific invoice
      const paymentHash = bolt11PaymentHash(pr) || crypto.randomUUID().replace(/-/g, '')

      // 3. Generate burner keypair, publish kind 30078, then immediately let sk fall out of scope
      const { sk: burnerSk } = generateBurnerKeypair()
      try {
        const { eventId: eid } = await publishDonationBoostagram({
          burnerSk,
          paymentHash,
          donorNpub: anonymous ? '' : donorNpub,
          recipientLud16: recipientLud16 || FALLBACK_LUD16,
          amountMsats: sats * 1000,
          message: message.trim(),
          pageUrl: window.location.origin + window.location.pathname,
        })

        setInvoice(pr)
        setEventId(eid)
        setVerifyUrl(verify)
      } finally {
        burnerSk.fill(0)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(invoice).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  function handleReset() {
    stopPollRef.current?.()
    setInvoice('')
    setEventId('')
    setVerifyUrl(null)
    setPaid(false)
    setError('')
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/70 z-20" onClick={onClose} aria-hidden="true" />

      <div className="fixed inset-0 z-30 flex items-center justify-center p-6" role="dialog" aria-label="Send us a Boost">
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg w-full max-w-sm flex flex-col">

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800">
            <h2 className="text-sm font-semibold text-neutral-200">⚡ Send us a Boost</h2>
            <button onClick={onClose} className="text-neutral-500 hover:text-neutral-300 transition-colors text-lg leading-none" aria-label="Close">✕</button>
          </div>

          <div className="px-6 py-5 space-y-4">
            {initError && (
              <p className="text-xs text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2">{initError}</p>
            )}

            {/* ── Form ── */}
            {!invoice && (
              <>
                <p className="text-xs text-neutral-500">
                  Support NostrMD with a lightning payment.{' '}
                  {recipientLud16 && <span className="text-neutral-600 font-mono">{recipientLud16}</span>}
                </p>

                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">Amount (sats)</label>
                  <div className="flex gap-1.5 mb-2">
                    {PRESETS.map(p => (
                      <button
                        key={p}
                        onClick={() => setAmount(String(p))}
                        className={`flex-1 text-xs py-1 rounded border transition-colors ${
                          amount === String(p)
                            ? 'border-amber-600 text-amber-400 bg-amber-950/30'
                            : 'border-neutral-700 text-neutral-500 hover:border-neutral-600 hover:text-neutral-300'
                        }`}
                      >
                        {p.toLocaleString()}
                      </button>
                    ))}
                  </div>
                  <input
                    type="number"
                    min="1"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-neutral-500"
                    placeholder="Custom amount"
                  />
                </div>

                {/* Boost as toggle */}
                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">Boost as</label>
                  <div className="flex rounded-md overflow-hidden border border-neutral-700 text-xs">
                    <button
                      onClick={() => setAnonymous(false)}
                      disabled={readOnly}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 transition-colors ${
                        readOnly
                          ? 'bg-neutral-900 text-neutral-700 cursor-not-allowed opacity-40'
                          : !anonymous ? 'bg-neutral-700 text-neutral-100' : 'bg-neutral-800 text-neutral-500 hover:text-neutral-300'
                      }`}
                    >
                      {profile?.image && (
                        <img src={profile.image} alt="" className="w-4 h-4 rounded-full object-cover" onError={e => { e.target.style.display = 'none' }} />
                      )}
                      <span className="truncate max-w-[140px]">
                        {profile?.displayName || profile?.name || 'Your npub'}
                      </span>
                    </button>
                    <button
                      onClick={() => setAnonymous(true)}
                      className={`flex-1 py-2 px-3 border-l border-neutral-700 transition-colors ${
                        anonymous ? 'bg-neutral-700 text-neutral-100' : 'bg-neutral-800 text-neutral-500 hover:text-neutral-300'
                      }`}
                    >
                      Anon
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">Message (optional)</label>
                  <input
                    type="text"
                    value={message}
                    onChange={e => setMessage(e.target.value)}
                    maxLength={140}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-neutral-100 focus:outline-none focus:border-neutral-500"
                    placeholder="Leave a note with your boost"
                  />
                </div>

                {error && <p className="text-xs text-red-400">{error}</p>}

                <button
                  onClick={handleGenerate}
                  disabled={loading || !!initError || !lnurlMeta}
                  className="w-full py-2 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
                >
                  {loading ? 'Preparing boost…' : !lnurlMeta && !initError ? 'Connecting…' : 'Boost ⚡'}
                </button>
              </>
            )}

            {/* ── QR / waiting ── */}
            {invoice && !paid && (
              <>
                <div className="flex justify-center py-2">
                  <div className="bg-white p-3 rounded-lg">
                    <QRCodeSVG value={`lightning:${invoice.toUpperCase()}`} size={200} />
                  </div>
                </div>

                <p className="text-xs text-neutral-500 text-center">
                  Scan with any lightning wallet · {parseInt(amount, 10).toLocaleString()} sats
                </p>

                {verifyUrl && (
                  <p className="text-xs text-neutral-600 text-center flex items-center justify-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-600 animate-pulse" />
                    Waiting for payment…
                  </p>
                )}

                <button
                  onClick={handleCopy}
                  className="w-full py-2 rounded border border-neutral-700 text-xs text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 transition-colors font-mono truncate px-3"
                  title={invoice}
                >
                  {copied ? '✓ Copied invoice' : invoice.slice(0, 32) + '…'}
                </button>

                <button onClick={handleReset} className="w-full py-1.5 text-xs text-neutral-600 hover:text-neutral-400 transition-colors">
                  ← Different amount
                </button>
              </>
            )}

            {/* ── Paid confirmation ── */}
            {paid && (
              <div className="flex flex-col items-center gap-4 py-4 text-center">
                <div className="w-14 h-14 rounded-full bg-green-950 border border-green-700 flex items-center justify-center text-2xl">
                  ✓
                </div>
                <div>
                  <p className="text-base font-semibold text-green-400">
                    {parseInt(amount, 10).toLocaleString()} sats received!
                  </p>
                  <p className="text-xs text-neutral-500 mt-1">
                    Thanks for the boost ⚡ It helps keep NostrMD going.
                  </p>
                </div>
                {eventId && (
                  <p className="text-xs text-neutral-700 font-mono break-all">
                    receipt: {eventId.slice(0, 16)}…
                  </p>
                )}
                <button
                  onClick={onClose}
                  className="mt-1 px-6 py-2 rounded bg-green-800 hover:bg-green-700 text-sm text-green-200 transition-colors"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
