import { useState, useEffect } from 'react'
import * as nwc from '../lib/nwc.js'
import * as webln from '../lib/webln.js'

/**
 * Wallet connect modal — two paths:
 *   1. WebLN ("Use my browser extension") — one-tap for Alby/Mutiny users.
 *      Visible iff window.webln is present.
 *   2. NWC — paste a connection string, validate via getBalance, encrypt
 *      to the user's Nostr key, persist + activate.
 *
 * If the user is signed out or read-only when this opens, the NWC path
 * fails fast — encryption requires a signer. WebLN doesn't need a
 * signer (the extension manages its own credentials), so it would work
 * read-only in principle, but the wallet row that opens this modal is
 * already gated on `canUseWallet` — keeping consistent gating here.
 */
function friendlyOrFallback(rawMsg, fallback) {
  const msg = String(rawMsg || '')
  const looksFriendly = msg.length > 0 && msg.length < 200 && !/Error:|stack|undefined/i.test(msg)
  return looksFriendly ? msg : fallback
}

export default function WalletConnectModal({ user, onClose, onConnected }) {
  const [uri, setUri] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')
  const weblnAvailable = webln.isAvailable()

  useEffect(() => {
    function onKey(e) {
      if (connecting) return
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, connecting])

  async function handleConnect() {
    setError('')
    if (!user) {
      setError('Sign in with Nostr first — your wallet connection is encrypted with your account.')
      return
    }
    const trimmed = uri.trim()
    if (!trimmed) { setError('Paste your NWC connection string above.'); return }
    setConnecting(true)
    try {
      await nwc.connect(trimmed, user)
      setUri('')
      onConnected?.()
      onClose()
    } catch (e) {
      const safeMsg = nwc.redactNwcSecrets(String(e?.message || e))
      console.warn('[mynostr-nwc] connect failed', safeMsg)
      setError(friendlyOrFallback(
        safeMsg,
        'Couldn\'t connect to your wallet. Check the connection string and that your wallet is online.',
      ))
    } finally {
      setConnecting(false)
    }
  }

  async function handleWeblnConnect() {
    setError('')
    if (!user?.pubkey) {
      setError('Sign in first — wallet authorization is scoped to your Nostr identity.')
      return
    }
    setConnecting(true)
    try {
      await webln.enable({ pubkey: user.pubkey })
      onConnected?.()
      onClose()
    } catch (e) {
      const msg = String(e?.message || e)
      console.warn('[mynostr-webln] enable failed', msg)
      setError(friendlyOrFallback(
        msg,
        'Your browser extension didn\'t connect. Make sure it\'s unlocked and try again.',
      ))
    } finally {
      setConnecting(false)
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 bg-black/70 z-40"
        onClick={connecting ? undefined : onClose}
        aria-hidden="true"
      />
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-6"
        role="dialog"
        aria-label="Connect Lightning Wallet"
      >
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg w-full max-w-sm flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
            <h2 className="text-sm font-semibold text-neutral-200">⚡ Connect Lightning Wallet</h2>
            <button
              onClick={onClose}
              disabled={connecting}
              className="text-neutral-500 hover:text-neutral-300 transition-colors text-lg leading-none disabled:opacity-30"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className="px-4 py-5 space-y-4">
            <p className="text-xs text-neutral-400 leading-snug">
              Connect a Lightning wallet so MyNostr can send zaps directly —
              no copy-paste invoices. Both options below pay through your own
              wallet; MyNostr never holds funds.
            </p>

            {weblnAvailable && (
              <>
                <button
                  onClick={handleWeblnConnect}
                  disabled={connecting}
                  className="w-full py-2.5 rounded bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
                >
                  {connecting ? 'Connecting…' : '⚡ Use my browser extension'}
                </button>
                <p className="text-[10px] text-neutral-600 leading-snug -mt-2">
                  Detected a WebLN-compatible extension (Alby, Mutiny, etc.).
                  One tap to authorize — no string to paste.
                </p>

                <div className="flex items-center gap-2 pt-1">
                  <div className="flex-1 h-px bg-neutral-800" />
                  <span className="text-[10px] text-neutral-600 uppercase tracking-wider">or</span>
                  <div className="flex-1 h-px bg-neutral-800" />
                </div>
              </>
            )}

            <div>
              <label className="block text-xs text-neutral-400 mb-1.5">NWC connection string</label>
              <textarea
                value={uri}
                onChange={e => setUri(e.target.value)}
                rows={3}
                placeholder="nostr+walletconnect://…"
                // Suppress password-manager autosave / autofill: this URI
                // is a bearer credential we already encrypt at rest with
                // the user's signer; we don't want it duplicated into
                // 1Password/LastPass/etc as a side effect of pasting.
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-xs text-neutral-100 font-mono focus:outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-500/30"
              />
              <p className="mt-1.5 text-[10px] text-neutral-600 leading-snug">
                Get a connection string from Alby Hub, Primal, Mutiny, Coinos,
                or any wallet that supports NIP-47.
              </p>
            </div>

            {error && (
              <p className="text-xs text-red-400">{error}</p>
            )}

            <button
              onClick={handleConnect}
              disabled={connecting}
              className="w-full py-2.5 rounded bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
            >
              {connecting ? 'Connecting…' : weblnAvailable ? 'Connect via NWC' : 'Connect Wallet'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
