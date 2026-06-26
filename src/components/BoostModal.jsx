import { SITE_URL, APP_NAME } from '../lib/brand.js'
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
  publishBoostShareNote,
  pollVerify,
} from '../lib/boostagram.js'
import { isSafeUrl } from '../lib/utils.js'
import * as nwc from '../lib/nwc.js'
import * as webln from '../lib/webln.js'
import { useWalletStatus } from '../lib/useWalletStatus.js'

const POLL_INTERVAL_MS = 2500
const PRESETS = [21, 210, 2100, 21000]

// NWC takes precedence when both are connected (NWC is the explicit
// connect path; WebLN can re-enable silently from the persisted flag).
// Mirrors the dispatcher in ZapModal so a WebLN-only user gets the same
// auto-pay experience the green "Pays via your connected wallet" hint
// promises.
function payInvoiceViaActiveWallet(bolt11) {
  if (nwc.isReady())   return nwc.payInvoice(bolt11)
  if (webln.isReady()) return webln.payInvoice(bolt11)
  return Promise.reject(new Error('No wallet connected'))
}
function anyWalletReady() {
  return nwc.isReady() || webln.isReady()
}

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
  // payment_hash from the bolt11. Used for the optional LUD-21 preimage
  // cross-check during verify polling. May be empty if the bolt11
  // decoder couldn't extract it (malformed invoice) — in which case
  // the cross-check is skipped.
  const [paymentHash, setPaymentHash] = useState('')
  // Whether the kind 30078 metadata event actually reached at least one
  // boostagram relay. Surfaced in the success view so users know if
  // their boost will be visible to bots watching the metadata stream.
  const [metaPublished, setMetaPublished] = useState(true)

  const [anonymous, setAnonymous] = useState(!!readOnly)
  const [loading, setLoading] = useState(false)
  // Mid-flow loading sub-state: tells the user *what* we're waiting on.
  // Especially useful during the signer round-trip in attributed mode —
  // a NIP-07 / bunker prompt may pop up in another window/app and the
  // user wouldn't otherwise know to look for it.
  const [loadingStep, setLoadingStep] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [paid, setPaid] = useState(false)

  // ── NWC auto-pay state ──
  // When the user has a connected NWC wallet, the form is hidden the
  // moment they click Boost — `nwcSending` covers the whole pipeline
  // (fetch invoice → sign + publish 30078 → payInvoice) so a single
  // steady "Sending boost…" view replaces the form's transient loading
  // hints. On preimage we flip to the success view; on failure we
  // reveal the QR fallback so the LNURL invoice + 30078 we already
  // published aren't wasted.
  const walletStatus = useWalletStatus()
  const [nwcSending, setNwcSending] = useState(false)
  const [nwcNotice, setNwcNotice] = useState('')

  // Share-to-feed (optional kind 1 note) — only available when the donor
  // has a real Nostr signer (not anonymous, not read-only). Auto-clears
  // when anonymous flips on so we don't carry a stale opt-in into a
  // mode that can't honor it.
  const [shareToFeed, setShareToFeed] = useState(false)
  const [shareAttempted, setShareAttempted] = useState(false)
  const [sharePublished, setSharePublished] = useState(false)
  const [shareError, setShareError] = useState('')

  const stopPollRef = useRef(null)
  const donorNpub = user?.npub || ''
  const profile = user?.profile

  // Whether the donor has a usable signer for the kind 1 share.
  const canShareToFeed = !anonymous && !readOnly && !!donorNpub

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

  // Start polling once we have an invoice + verify URL. When `paid` flips
  // true, the effect re-runs with the early-return path and the previous
  // run's cleanup (the pollVerify cancel function) fires — that's what
  // stops the polling. Including `paid` in the deps means the previous
  // separate "stop on paid" effect is unnecessary; this single effect
  // handles both start and stop.
  //
  // `paymentHash` is passed through so pollVerify can perform the
  // optional LUD-21 preimage cross-check (rejects servers that lie
  // about settled status).
  useEffect(() => {
    if (!verifyUrl || !invoice || paid) return
    stopPollRef.current = pollVerify(
      verifyUrl,
      POLL_INTERVAL_MS,
      () => setPaid(true),
      paymentHash || null,
    )
    return () => stopPollRef.current?.()
  }, [verifyUrl, invoice, paid, paymentHash])

  // Force shareToFeed off when anonymous flips on — the two are mutually
  // exclusive (sharing requires a real signer; anonymous mode means
  // intentionally not using one).
  useEffect(() => {
    if (anonymous && shareToFeed) setShareToFeed(false)
  }, [anonymous, shareToFeed])

  // Publish the kind 1 share note once payment confirms — only if the
  // donor opted in, has a signer, and we haven't already attempted.
  // Failures are non-fatal: the boost succeeded; the share is best-effort.
  useEffect(() => {
    if (!paid || !shareToFeed || shareAttempted) return
    if (!canShareToFeed) return
    setShareAttempted(true)
    let cancelled = false
    ;(async () => {
      try {
        const r = await publishBoostShareNote({
          message: message.trim(),
          recipientNpub: PROJECT_OWNER_NPUB,
          // Hardcoded prod URL — kind 1's published to followers should
          // direct them to the live site, not the env we authored from.
          pageUrl: SITE_URL,
          amountSats: parseInt(amount, 10) || 0,
        })
        if (cancelled) return
        if (r.published) setSharePublished(true)
        else setShareError('Couldn\'t reach your relays.')
      } catch (e) {
        if (cancelled) return
        setShareError(e?.message || 'Failed to publish to your feed.')
      }
    })()
    return () => { cancelled = true }
  }, [paid, shareToFeed, shareAttempted, canShareToFeed, message, amount])

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
    const commentParts = ['[mynostr boost]']
    if (message.trim()) commentParts.push(message.trim())
    const comment = commentParts.join(' — ')
    const maxLen = lnurlMeta.commentAllowed || 0
    const trimmedComment = maxLen > 0 ? comment.slice(0, maxLen) : comment

    // Pin the auto-pay branch up-front so all downstream UI decisions are
    // consistent. With a wallet (NWC or WebLN) connected, flip to the
    // unified "Sending…" view BEFORE any async work — otherwise the form's
    // stage labels ('Fetching invoice…', 'Approve in your signer app…')
    // flash for ~100–500ms each on a fast NIP-07 signer, which reads as
    // choppy.
    const walletConnected = anyWalletReady()
    if (walletConnected) {
      setNwcSending(true)
    } else {
      setLoading(true)
      setLoadingStep('Fetching invoice…')
    }

    try {
      // 1. Fetch invoice
      const { pr, verify } = await fetchLnurlInvoice(lnurlMeta.callback, sats * 1000, trimmedComment)

      // 2. Extract payment hash — links the kind 30078 event to this specific invoice.
      //    realPaymentHash is the actual bolt11-derived hash; null when the
      //    decoder couldn't parse the invoice (we still need a d-tag value
      //    so we generate a UUID fallback). The real hash also goes to
      //    pollVerify for the LUD-21 preimage cross-check — without a real
      //    hash we can't verify, so the cross-check is skipped.
      const realPaymentHash = bolt11PaymentHash(pr)
      const paymentHashTag = realPaymentHash || crypto.randomUUID().replace(/-/g, '')
      setPaymentHash(realPaymentHash || '')

      // 3. Sign + publish kind 30078. Anonymous → single-use burner key
      //    (zeroed immediately after); attributed → donor's real signer
      //    (NIP-07 / bunker via NDK). The signer round-trip in attributed
      //    mode can take 20s if the user's signer is in another window/app
      //    (Primal app, Alby popup, bunker). On the non-NWC path we
      //    surface "Approve in your signer app…" so the user knows to look
      //    for the prompt; on the NWC path the unified "Sending…" view
      //    stays steady — most users are on fast NIP-07 extensions and the
      //    flicker isn't worth it.
      if (!walletConnected) {
        setLoadingStep(anonymous
          ? 'Publishing receipt…'
          : 'Approve in your signer app…')
      }
      const burner = anonymous ? generateBurnerKeypair() : null
      try {
        const { eventId: eid, published } = await publishDonationBoostagram({
          burnerSk: burner?.sk || null,
          paymentHash: paymentHashTag,
          donorNpub: anonymous ? '' : donorNpub,
          recipientLud16: recipientLud16 || FALLBACK_LUD16,
          amountMsats: sats * 1000,
          message: message.trim(),
          // Just the site root — readers / bots / share notes shouldn't
          // care which page the booster was on. Was previously
          // origin + pathname which leaked the whole URL (including
          // the viewed user's npub) into every boost record.
          pageUrl: window.location.origin,
        })

        setInvoice(pr)
        setEventId(eid)
        // Surface the publish result — if no relay accepted the kind
        // 30078, the LN payment will still go through but the bot
        // watching the metadata stream won't find anything to enrich
        // it with. User should know.
        setMetaPublished(!!published)

        // 4. Pay. Connected wallet (NWC or WebLN) auto-pays in foreground;
        //    no-wallet path arms verify polling so the modal can detect an
        //    external wallet's settlement of the QR.
        if (walletConnected) {
          const t0 = Date.now()
          console.info('[mynostr-boost] payInvoice: sending request')
          try {
            await payInvoiceViaActiveWallet(pr)
            console.info(`[mynostr-boost] payInvoice: settled in ${Date.now() - t0}ms`)
            setPaid(true)
          } catch (e) {
            const msg = String(e?.message || e)
            console.warn(`[mynostr-boost] payInvoice failed after ${Date.now() - t0}ms:`, msg)
            const friendly = /reply.?timeout|publish.?timeout|timeout/i.test(msg)
              ? 'Your wallet didn\'t acknowledge the payment within 25 seconds. The payment may have actually gone through — check your wallet before retrying.'
              : (msg && msg.length < 200 ? msg : 'Wallet payment failed.')
            setNwcNotice(`${friendly} You can pay this invoice manually below.`)
            setVerifyUrl(verify)
            setNwcSending(false)
          }
        } else {
          setVerifyUrl(verify)
        }
      } finally {
        if (burner?.sk) burner.sk.fill(0)
      }
    } catch (e) {
      setError(e.message)
      if (walletConnected) setNwcSending(false)
    } finally {
      setLoading(false)
      setLoadingStep('')
    }
  }

  async function handleCopy() {
    try {
      // Clipboard API requires HTTPS or localhost — fails on LAN (192.168.x.x)
      await navigator.clipboard.writeText(invoice)
    } catch {
      try {
        const el = document.createElement('textarea')
        el.value = invoice
        el.style.cssText = 'position:fixed;opacity:0'
        document.body.appendChild(el)
        el.focus()
        el.select()
        document.execCommand('copy')
        document.body.removeChild(el)
      } catch {
        return // both methods failed
      }
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handleReset() {
    stopPollRef.current?.()
    setInvoice('')
    setEventId('')
    setVerifyUrl(null)
    setPaymentHash('')
    setMetaPublished(true)
    setPaid(false)
    setError('')
    setNwcNotice('')
    // Clear share-flow state too so a previous attempt's status doesn't
    // bleed into the next boost.
    setShareAttempted(false)
    setSharePublished(false)
    setShareError('')
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

            {/* ── Form ── hidden once an NWC send is in flight, so the
                form's transient stage labels can't flicker into view on
                fast signers. */}
            {!invoice && !nwcSending && (
              <>
                <p className="text-xs text-neutral-500">
                  Support {APP_NAME} with a lightning payment.{' '}
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
                      {profile?.image && isSafeUrl(profile.image) && (
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

                {/* Share-to-feed opt-in — only when the donor has a real
                    signer to publish a kind 1 with. Hidden in anonymous
                    or read-only modes since neither can sign a kind 1
                    that lands on the donor's actual feed. */}
                {canShareToFeed && (
                  <label className="flex items-start gap-2 text-xs text-neutral-400 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={shareToFeed}
                      onChange={e => setShareToFeed(e.target.checked)}
                      className="accent-amber-600 mt-0.5"
                    />
                    <span className="leading-snug">
                      Share to my feed
                      <span className="block text-[10px] text-neutral-600 mt-0.5">
                        Posts a kind 1 note to your followers — your
                        message + a link back here.
                      </span>
                    </span>
                  </label>
                )}

                {error && <p className="text-xs text-red-400">{error}</p>}

                {/* Loading sub-state — visible while the modal is mid-flow.
                    Particularly useful during the attributed-mode signer
                    round-trip, when a NIP-07 / bunker prompt may pop up
                    in another window/app and the user wouldn't otherwise
                    know to look. */}
                {loading && loadingStep && (
                  <p className="text-xs text-amber-400 flex items-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                    {loadingStep}
                  </p>
                )}

                {/* NWC connected hint — sets the user's expectation that
                    the boost will pay automatically without an external
                    wallet handoff. Mirrors the zap surface's hint. */}
                {walletStatus?.connected && !loading && (
                  <p className="text-[11px] text-neutral-500 flex items-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" aria-hidden="true" />
                    <span className="truncate">
                      Pays via your connected wallet{walletStatus.alias ? ` · ${walletStatus.alias}` : ''}
                    </span>
                  </p>
                )}

                <button
                  onClick={handleGenerate}
                  disabled={loading || !!initError || !lnurlMeta}
                  className="w-full py-2 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
                >
                  {loading ? 'Preparing boost…' : !lnurlMeta && !initError ? 'Connecting…' : 'Boost ⚡'}
                </button>
              </>
            )}

            {/* ── NWC sending ── one steady view from click to preimage,
                replaces the form's stage labels so a fast signer doesn't
                flash through them. Stays mounted across the LNURL fetch
                + 30078 sign/publish + payInvoice round-trip; flips to the
                success view on preimage, or unmounts (revealing the QR
                view below) if NWC fails and we fall back to manual. */}
            {nwcSending && !paid && (
              <div className="flex flex-col items-center gap-4 py-6 text-center">
                <div className="w-14 h-14 rounded-full bg-amber-950/40 border-2 border-amber-600/60 flex items-center justify-center">
                  <span className="text-2xl animate-pulse">⚡</span>
                </div>
                <div>
                  <p className="text-sm font-medium text-amber-300">
                    Sending boost…
                  </p>
                  <p className="text-xs text-neutral-500 mt-1">
                    {parseInt(amount, 10).toLocaleString()} sats to {APP_NAME}
                  </p>
                </div>
              </div>
            )}

            {/* ── QR / waiting ── */}
            {invoice && !paid && !nwcSending && (
              <>
                {nwcNotice && (
                  <p className="text-xs text-amber-300 bg-amber-900/20 border border-amber-900/40 rounded px-3 py-2">
                    {nwcNotice}
                  </p>
                )}
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
                    Thanks for the boost ⚡ It helps keep {APP_NAME} going.
                  </p>
                </div>
                {/* Share-to-feed result. Only relevant when the donor
                    opted in. Pending → amber pulse; success → green ✓;
                    failure → amber warning (the boost itself succeeded). */}
                {shareToFeed && shareAttempted && !sharePublished && !shareError && (
                  <p className="text-xs text-neutral-500 flex items-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                    Sharing to your feed…
                  </p>
                )}
                {shareToFeed && sharePublished && (
                  <p className="text-xs text-green-400 flex items-center gap-1.5">
                    <span>✓</span>
                    Shared to your feed
                  </p>
                )}
                {shareToFeed && shareError && (
                  <p className="text-xs text-amber-500 max-w-xs">
                    Couldn't share to your feed — {shareError}
                  </p>
                )}

                {/* Metadata-publish warning. The Lightning payment
                    succeeded, but no relay in the boostagram set ack'd
                    the kind 30078 — bots watching the metadata stream
                    won't see this boost. Worth telling the user since
                    the receipt below would otherwise look like
                    everything's fine. */}
                {!metaPublished && (
                  <p className="text-xs text-amber-500 max-w-xs">
                    Boost succeeded, but the metadata event didn't reach
                    any boostagram relay. The recipient's bot won't have
                    your message attached.
                  </p>
                )}

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
