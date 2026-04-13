import { useState, useEffect, useRef } from 'react'
import { NDKNip07Signer, NDKPrivateKeySigner, NDKNip46Signer } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { QRCodeSVG } from 'qrcode.react'
import { getNDK } from '../lib/ndk.js'

export default function LoginScreen({ onLogin }) {
  const [nsecValue, setNsecValue] = useState('')
  const [bunkerValue, setBunkerValue] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [hasExtension, setHasExtension] = useState(false)
  // Nostr Connect section state
  const [ncTab, setNcTab] = useState('qr')       // 'qr' | 'paste'
  const [qrUri, setQrUri] = useState(null)        // nostrconnect:// URI to display
  const [qrWaiting, setQrWaiting] = useState(false)
  const [copied, setCopied] = useState(false)
  const qrSignerRef = useRef(null)                // holds signer so we can call .stop() on cancel

  useEffect(() => {
    // Some extensions (nos2x) inject window.nostr after the page renders.
    // Poll briefly to catch late injections.
    if (window.nostr) { setHasExtension(true); return }
    const interval = setInterval(() => {
      if (window.nostr) { setHasExtension(true); clearInterval(interval) }
    }, 100)
    const timeout = setTimeout(() => clearInterval(interval), 3000)
    return () => { clearInterval(interval); clearTimeout(timeout) }
  }, [])

  // Auto-start QR flow on mount (QR is the default Nostr Connect tab)
  useEffect(() => {
    startQrFlow()
    return () => {
      // Clean up relay subscription if user navigates away mid-flow
      if (qrSignerRef.current) {
        qrSignerRef.current.stop()
        qrSignerRef.current = null
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch Kind 0 profile with a timeout so a slow relay doesn't block login
  async function fetchUserProfile(ndk, pubkey) {
    const user = ndk.getUser({ pubkey })
    try {
      await Promise.race([
        user.fetchProfile(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ])
    } catch {
      // Profile fetch failure is non-fatal — user still logs in without avatar/name
    }
    return user
  }

  // Cancel any active QR listener before starting a different login method
  function cancelActiveQrFlow() {
    if (qrSignerRef.current) {
      qrSignerRef.current.stop()
      qrSignerRef.current = null
    }
    setQrWaiting(false)
  }

  async function loginWithExtension() {
    setError('')
    cancelActiveQrFlow()
    if (!window.nostr) {
      setError('No Nostr extension detected. Install Alby, nos2x, keys.band, or Nostore.')
      return
    }
    setLoading(true)
    try {
      const signer = new NDKNip07Signer()
      const ndk = getNDK()
      ndk.signer = signer

      // blockUntilReady resolves once the extension returns the pubkey.
      // 15s timeout catches extensions like keys.band where a pending site-approval
      // dialog can cause the response to never arrive due to a Chrome message
      // callback race condition.
      await Promise.race([
        signer.blockUntilReady(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('__timeout__')), 15000)
        ),
      ])

      // Fire relay connections in the background — login doesn't need to wait for them
      ndk.connect().catch(() => {})

      const pubkey = await signer.user()
      const user = await fetchUserProfile(ndk, pubkey.pubkey)
      onLogin(user)
    } catch (err) {
      if (err.message === '__timeout__') {
        setError(
          'Extension did not respond in time. If you are using keys.band, open the extension and approve this site first, then try again.'
        )
      } else {
        setError('Extension login failed: ' + (err.message || 'unknown error'))
      }
    } finally {
      setLoading(false)
    }
  }

  async function loginWithKey() {
    setError('')
    cancelActiveQrFlow()
    const val = nsecValue.trim()
    if (!val) {
      setError('Please enter your nsec or npub key.')
      return
    }
    setLoading(true)
    try {
      const decoded = nip19.decode(val)
      const ndk = getNDK()

      if (decoded.type === 'npub') {
        // Read-only login — no signer, just connect and fetch profile
        ndk.connect().catch(() => {})
        const user = await fetchUserProfile(ndk, decoded.data)
        user.readOnly = true
        onLogin(user)
      } else if (decoded.type === 'nsec') {
        // Decode nsec → raw private key hex
        const signer = new NDKPrivateKeySigner(decoded.data)
        ndk.signer = signer

        // Fire relay connections in the background
        ndk.connect().catch(() => {})

        const ndkUser = await signer.user()
        const user = await fetchUserProfile(ndk, ndkUser.pubkey)
        onLogin(user)
      } else {
        throw new Error('Input must be an nsec or npub key.')
      }
    } catch (err) {
      setError(err.message || 'Invalid key.')
    } finally {
      setLoading(false)
      // Clear the input field — nsec should not linger in the DOM
      setNsecValue('')
    }
  }

  function switchNcTab(tab) {
    // Cancel any in-progress QR flow when switching tabs
    if (qrSignerRef.current) {
      qrSignerRef.current.stop()
      qrSignerRef.current = null
    }
    setQrUri(null)
    setQrWaiting(false)
    setError('')
    setNcTab(tab)
    if (tab === 'qr') startQrFlow()
  }

  async function startQrFlow() {
    setError('')
    setQrWaiting(true)
    try {
      const ndk = getNDK()
      const signer = NDKNip46Signer.nostrconnect(ndk, 'wss://relay.primal.net', undefined, {
        name: 'MyNostr',
        url: 'https://nostrmd.xyz',
      })
      qrSignerRef.current = signer

      // Extract secret from URI so we can verify connect requests ourselves
      const secret = new URL(signer.nostrConnectUri).searchParams.get('secret')
      setQrUri(signer.nostrConnectUri)

      // NDK bug: blockUntilReadyNostrConnect only listens for "response" events,
      // but Primal, Amber, and most modern signers send a "connect" REQUEST
      // (with method:"connect") when they scan the QR. In the NDK RPC module,
      // events with a method field are emitted as "request", never "response",
      // so blockUntilReady() hangs forever.
      //
      // Fix: listen on signer.rpc directly for both "request" and "response"
      // events, then do the key resolution ourselves.
      await new Promise((resolve, reject) => {
        let done = false

        async function finish(pubkeyHex) {
          if (done) return
          done = true
          signer.rpc.off('request', onRequest)
          signer.rpc.off('response', onResponse)
          try {
            signer.userPubkey = pubkeyHex
            signer.bunkerPubkey = pubkeyHex
            signer._user = ndk.getUser({ pubkey: pubkeyHex })
            resolve()
          } catch (e) {
            reject(e)
          }
        }

        // Request-based flow: Primal, Amber, most modern signers
        async function onRequest(req) {
          if (req.method !== 'connect') return
          if (req.params?.[0] !== secret) return  // secret mismatch — not our QR
          await finish(req.event.pubkey)
        }

        // Response-based flow: older signers / bunkers
        async function onResponse(res) {
          if (res.result !== secret) return
          // Older flow sets userPubkey to the ephemeral key — get the real one
          signer.userPubkey = null
          const actualPubkey = await signer.getPublicKey().catch(() => res.event.pubkey)
          await finish(actualPubkey)
        }

        signer.rpc.on('request', onRequest)
        signer.rpc.on('response', onResponse)

        // blockUntilReady() starts the internal relay subscription — we still
        // need it to establish the relay connection and subscription.
        // We ignore its resolution since our listeners above handle the result.
        signer.blockUntilReady().catch((err) => {
          if (done) return
          if (qrSignerRef.current === null) return  // manual cancel
          done = true
          signer.rpc.off('request', onRequest)
          signer.rpc.off('response', onResponse)
          reject(err)
        })
      })

      if (qrSignerRef.current === null) return  // cancelled mid-flow

      setQrWaiting(false)
      setLoading(true)
      ndk.signer = signer
      ndk.connect().catch(() => {})
      const user = await fetchUserProfile(ndk, signer.userPubkey)
      onLogin(user)
    } catch (err) {
      if (qrSignerRef.current === null) return  // manual cancel
      setQrWaiting(false)
      setError('QR login failed: ' + (err.message || 'unknown error'))
    } finally {
      setLoading(false)
    }
  }

  function cancelQrFlow() {
    if (qrSignerRef.current) {
      qrSignerRef.current.stop()
      qrSignerRef.current = null
    }
    setQrUri(null)
    setQrWaiting(false)
    setError('')
    // Regenerate a fresh QR immediately
    startQrFlow()
  }

  async function copyQrUri() {
    if (!qrUri) return
    await navigator.clipboard.writeText(qrUri)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function loginWithBunker() {
    setError('')
    cancelActiveQrFlow()
    const token = bunkerValue.trim()
    if (!token) {
      setError('Please paste your bunker:// connection string.')
      return
    }
    if (!token.startsWith('bunker://')) {
      setError('Connection string must start with bunker://')
      return
    }
    setLoading(true)
    try {
      const ndk = getNDK()
      const signer = NDKNip46Signer.bunker(ndk, token)

      // Some bunkers send an authUrl if they need the user to approve in a browser tab.
      // Validate the URL scheme to prevent javascript: or other injection from a
      // malicious/compromised bunker.
      signer.on('authUrl', (url) => {
        try {
          const parsed = new URL(url)
          if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
            window.open(url, '_blank', 'width=600,height=700')
          }
        } catch {
          // Malformed URL — ignore silently
        }
      })

      ndk.signer = signer

      await Promise.race([
        signer.blockUntilReady(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('__timeout__')), 30000)
        ),
      ])

      ndk.connect().catch(() => {})

      const ndkUser = await signer.user()
      const user = await fetchUserProfile(ndk, ndkUser.pubkey)
      onLogin(user)
    } catch (err) {
      if (err.message === '__timeout__') {
        setError('Bunker did not respond in time. Check that the connection string is valid and the bunker is online.')
      } else {
        setError('Bunker login failed: ' + (err.message || 'unknown error'))
      }
    } finally {
      setLoading(false)
      setBunkerValue('')
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-4">
      <div className="w-full max-w-md space-y-8">

        {/* Logo / title */}
        <div className="text-center">
          <img src="/nostrmd.png" alt="NostrMD" className="h-16 mx-auto mb-2" />
          <p className="mt-2 text-neutral-500 text-sm">Long-form publishing for Nostr</p>
        </div>

        {/* NIP-07 extension login */}
        <div className="space-y-3">
          <button
            onClick={loginWithExtension}
            disabled={loading}
            className="w-full py-3 px-4 rounded-lg bg-purple-700 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium transition-colors"
            aria-label="Login with Nostr browser extension"
          >
            {loading ? 'Connecting...' : 'Login with Extension'}
          </button>
          {!hasExtension && (
            <p className="text-xs text-neutral-500 text-center">
              Works with Alby, nos2x, Nostore, keys.band, and other NIP-07 extensions.
            </p>
          )}
        </div>

        {/* Divider */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-neutral-800" />
          <span className="text-xs text-neutral-600">or</span>
          <div className="flex-1 h-px bg-neutral-800" />
        </div>

        {/* nsec / npub direct input */}
        <div className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="nsec-input" className="block text-sm text-neutral-400">
              Private key (nsec) or public key (npub)
            </label>
            <input
              id="nsec-input"
              type={nsecValue.startsWith('npub') ? 'text' : 'password'}
              value={nsecValue}
              onChange={e => setNsecValue(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && loginWithKey()}
              placeholder="nsec1... or npub1..."
              autoComplete="off"
              spellCheck={false}
              className="w-full px-4 py-3 rounded-lg bg-neutral-900 border border-neutral-700 text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-purple-600 font-mono text-sm"
              aria-label="Nostr key input"
            />
          </div>

          {/* Security warning — only relevant for nsec */}
          {!nsecValue.startsWith('npub') && (
            <p className="text-xs text-amber-500/80 leading-relaxed">
              Your key is held in memory only and will be cleared when you close or refresh this page.
              It is never written to storage.
            </p>
          )}
          {nsecValue.startsWith('npub') && (
            <p className="text-xs text-neutral-600 leading-relaxed">
              npub login is read-only. You can browse and download your articles but cannot publish.
            </p>
          )}

          <button
            onClick={loginWithKey}
            disabled={loading || !nsecValue.trim()}
            className="w-full py-3 px-4 rounded-lg bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed text-neutral-100 font-medium transition-colors border border-neutral-700"
            aria-label="Login with nsec or npub key"
          >
            {loading ? 'Connecting...' : 'Login with Key'}
          </button>
        </div>

        {/* Divider */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-neutral-800" />
          <span className="text-xs text-neutral-600">or</span>
          <div className="flex-1 h-px bg-neutral-800" />
        </div>

        {/* Nostr Connect — tabbed: QR code or paste bunker:// */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-neutral-400">Nostr Connect</span>
            <div className="flex rounded-md overflow-hidden border border-neutral-700 text-xs">
              <button
                onClick={() => switchNcTab('qr')}
                className={`px-3 py-1 transition-colors ${ncTab === 'qr' ? 'bg-neutral-700 text-neutral-100' : 'bg-neutral-900 text-neutral-500 hover:text-neutral-300'}`}
              >
                Scan QR
              </button>
              <button
                onClick={() => switchNcTab('paste')}
                className={`px-3 py-1 transition-colors border-l border-neutral-700 ${ncTab === 'paste' ? 'bg-neutral-700 text-neutral-100' : 'bg-neutral-900 text-neutral-500 hover:text-neutral-300'}`}
              >
                Paste string
              </button>
            </div>
          </div>

          {ncTab === 'qr' && (
            <div className="space-y-3">
              {qrWaiting && qrUri ? (
                <>
                  <div className="flex flex-col items-center gap-3 py-2">
                    <div className="p-3 bg-white rounded-lg">
                      <QRCodeSVG value={qrUri} size={200} />
                    </div>
                    <p className="text-xs text-neutral-400 text-center">
                      Scan with Amber, Primal, or any NIP-46 signer app
                    </p>
                    <div className="flex gap-2 w-full">
                      <button
                        onClick={copyQrUri}
                        className="flex-1 py-2 px-3 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs border border-neutral-700 transition-colors"
                      >
                        {copied ? 'Copied!' : 'Copy link'}
                      </button>
                      <button
                        onClick={cancelQrFlow}
                        className="flex-1 py-2 px-3 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs border border-neutral-700 transition-colors"
                      >
                        Refresh QR
                      </button>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-neutral-500">
                      <span className="inline-block w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
                      Waiting for signer to connect...
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center py-4">
                  <div className="w-8 h-8 border-2 border-purple-600 border-t-transparent rounded-full animate-spin" />
                  <p className="text-xs text-neutral-500 mt-2">Generating QR...</p>
                </div>
              )}
            </div>
          )}

          {ncTab === 'paste' && (
            <div className="space-y-3">
              <div className="space-y-1">
                <label htmlFor="bunker-input" className="block text-xs text-neutral-500">
                  Paste your bunker:// connection string
                </label>
                <input
                  id="bunker-input"
                  type="password"
                  value={bunkerValue}
                  onChange={e => setBunkerValue(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && loginWithBunker()}
                  placeholder="bunker://..."
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full px-4 py-3 rounded-lg bg-neutral-900 border border-neutral-700 text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-purple-600 font-mono text-sm"
                  aria-label="Nostr Connect bunker connection string"
                />
              </div>
              <p className="text-xs text-neutral-500 leading-relaxed">
                Generate a connection string from Nsec.app or any NIP-46 bunker, then paste it here.
              </p>
              <button
                onClick={loginWithBunker}
                disabled={loading || !bunkerValue.trim()}
                className="w-full py-3 px-4 rounded-lg bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed text-neutral-100 font-medium transition-colors border border-neutral-700"
                aria-label="Login with Nostr Connect bunker string"
              >
                {loading ? 'Connecting...' : 'Login with Bunker'}
              </button>
            </div>
          )}
        </div>

        {/* Error display */}
        {error && (
          <p className="text-sm text-red-400 text-center" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
