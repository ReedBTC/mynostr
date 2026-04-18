import { useState, useEffect, useRef } from 'react'
import { NDKNip07Signer, NDKPrivateKeySigner, NDKNip46Signer } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { QRCodeSVG } from 'qrcode.react'
import { getNDK, resetNDK, connectAndWait } from '../lib/ndk.js'
import { useIsMobile } from '../hooks/useIsMobile.js'

// Mobile NIP-46 flows need to survive tab reloads and WebSocket suspensions
// — user taps a signer app, approves, comes back, but the browser tab was
// reaped or the relay socket was suspended while they were away, so the fresh
// subscription has a different localSigner pubkey in its #p filter and never
// sees the response event the signer already published.
//
// We can't use NDK's toPayload() mid-flow — it throws when userPubkey/
// bunkerPubkey aren't set yet (which is exactly our situation). Persist the
// raw internals instead: localSigner privkey and the nostrconnect URI
// (contains the secret, relay, and local pubkey). On restore, build a new
// signer with the SAME localSigner and overwrite nostrConnectSecret /
// nostrConnectUri so both the relay subscription filter and the secret check
// line up with the event already sitting in the relay.
const PENDING_NIP46_KEY = 'mynostr_pending_nip46'
const PENDING_NIP46_MAX_AGE_MS = 10 * 60 * 1000

function savePendingNip46(state) {
  try {
    if (!state?.localSignerPrivkey || !state?.nostrConnectUri) return
    localStorage.setItem(PENDING_NIP46_KEY, JSON.stringify({
      localSignerPrivkey: state.localSignerPrivkey,
      nostrConnectUri: state.nostrConnectUri,
      createdAt: Date.now(),
    }))
  } catch {}
}

function loadPendingNip46() {
  try {
    const raw = localStorage.getItem(PENDING_NIP46_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.localSignerPrivkey || !parsed?.nostrConnectUri) return null
    if (Date.now() - Number(parsed.createdAt) > PENDING_NIP46_MAX_AGE_MS) {
      localStorage.removeItem(PENDING_NIP46_KEY)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function clearPendingNip46() {
  try { localStorage.removeItem(PENDING_NIP46_KEY) } catch {}
}

export default function LoginScreen({ onLogin }) {
  const isMobile = useIsMobile()
  const [nsecValue, setNsecValue] = useState('')
  const [bunkerValue, setBunkerValue] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [hasExtension, setHasExtension] = useState(false)
  const [ncTab, setNcTab] = useState(null) // 'qr' | 'paste' — set after mount based on device
  const [qrUri, setQrUri] = useState(null)
  const [qrWaiting, setQrWaiting] = useState(false)
  const [copied, setCopied] = useState(false)
  // Bunker/NIP-46 can request user-approval via a web URL (nsec.app etc).
  // On mobile, window.open from an async callback is blocked by popup blockers,
  // so we surface the URL in the UI for the user to tap manually. The *user
  // gesture* of tapping the rendered link bypasses the blocker.
  const [authUrl, setAuthUrl] = useState(null)
  const qrSignerRef = useRef(null)
  // Token for the extension-detection poll so a competing login flow can abort it.
  const extPollTokenRef = useRef({ aborted: true })

  function abortExtensionPoll() {
    extPollTokenRef.current.aborted = true
  }

  useEffect(() => {
    if (window.nostr) { setHasExtension(true); return }
    const interval = setInterval(() => {
      if (window.nostr) { setHasExtension(true); clearInterval(interval) }
    }, 100)
    const timeout = setTimeout(() => clearInterval(interval), 3000)
    return () => { clearInterval(interval); clearTimeout(timeout) }
  }, [])

  // Default Nostr Connect tab based on device
  useEffect(() => {
    setNcTab(isMobile ? 'paste' : 'qr')
  }, [isMobile])

  // Start QR flow when QR tab is active (desktop) or always on mobile —
  // pre-generating the nostrconnect:// URI so the first tap of "Open in
  // Signer App" navigates immediately instead of just generating the link.
  useEffect(() => {
    if (isMobile || ncTab === 'qr') startQrFlow()
    return () => {
      if (qrSignerRef.current) {
        qrSignerRef.current.stop()
        qrSignerRef.current = null
      }
    }
  }, [ncTab, isMobile]) // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchUserProfile(ndk, pubkey) {
    const user = ndk.getUser({ pubkey })
    try {
      await Promise.race([
        user.fetchProfile(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ])
    } catch {}
    return user
  }

  function cancelActiveQrFlow() {
    if (qrSignerRef.current) {
      qrSignerRef.current.stop()
      qrSignerRef.current = null
    }
    setQrWaiting(false)
    clearPendingNip46()
    abortExtensionPoll()
  }

  async function loginWithExtension() {
    setError('')
    cancelActiveQrFlow()
    setLoading(true)
    // Some extensions inject window.nostr asynchronously — poll briefly, but
    // allow a competing login flow to abort via extPollTokenRef.
    const token = { aborted: false }
    extPollTokenRef.current = token
    if (!window.nostr) {
      const start = Date.now()
      while (!window.nostr && !token.aborted && Date.now() - start < 1500) {
        await new Promise(r => setTimeout(r, 100))
      }
    }
    if (token.aborted) { setLoading(false); return }
    if (!window.nostr) {
      // Only suggest localhost when on a non-secure origin — on HTTPS that hint is nonsense.
      const insecureOrigin = typeof window !== 'undefined'
        && window.location?.protocol === 'http:'
        && window.location?.hostname !== 'localhost'
        && window.location?.hostname !== '127.0.0.1'
      const base = 'No Nostr extension detected. Supported: Alby, nos2x, keys.band, Nostore.'
      const originHint = insecureOrigin
        ? ' If you have one installed, this page origin may not be permitted — try http://localhost instead of a LAN IP, or use HTTPS.'
        : ''
      setError(base + originHint)
      setLoading(false)
      return
    }
    try {
      resetNDK()
      const signer = new NDKNip07Signer()
      const ndk = getNDK()
      ndk.signer = signer
      await Promise.race([
        signer.blockUntilReady(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('__timeout__')), 15000)),
      ])
      await connectAndWait(ndk)
      const pubkey = await signer.user()
      const user = await fetchUserProfile(ndk, pubkey.pubkey)
      onLogin(user)
    } catch (err) {
      if (err.message === '__timeout__') {
        setError('Extension did not respond in time. If you are using keys.band, open the extension and approve this site first, then try again.')
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
      resetNDK()
      const decoded = nip19.decode(val)
      const ndk = getNDK()

      if (decoded.type === 'npub') {
        await connectAndWait(ndk)
        const user = await fetchUserProfile(ndk, decoded.data)
        user.readOnly = true
        onLogin(user)
      } else if (decoded.type === 'nsec') {
        const signer = new NDKPrivateKeySigner(decoded.data)
        ndk.signer = signer
        await connectAndWait(ndk)
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
      setNsecValue('')
    }
  }

  function switchNcTab(tab) {
    if (qrSignerRef.current) {
      qrSignerRef.current.stop()
      qrSignerRef.current = null
    }
    setQrUri(null)
    setQrWaiting(false)
    setError('')
    clearPendingNip46()
    setNcTab(tab)
  }

  async function startQrFlow() {
    setError('')
    setQrWaiting(true)
    try {
      const ndk = getNDK()
      // Make sure app-wide relays are connected so post-login fetches work.
      // The signer itself gets a *dedicated* relay pool (see below) so it
      // doesn't matter whether this succeeds.
      await connectAndWait(ndk)

      // Different signers publish the connect response to different relays:
      // Primal publishes to relay.primal.net, Amber tends toward relay.nsec.app
      // or relay.damus.io. A single-relay URI leaves one of them stranded.
      // We advertise all three in the nostrconnect URI *and* subscribe to all
      // three, so whichever relay the signer picks, we'll see the event.
      const NC_RELAYS = [
        'wss://relay.nsec.app',
        'wss://relay.primal.net',
        'wss://relay.damus.io',
      ]

      const pending = loadPendingNip46()
      let signer = null
      let savedUri = null
      let savedSecret = null
      let savedPrivkey = null
      let savedRelays = null
      if (pending) {
        try {
          const parsedUri = new URL(pending.nostrConnectUri)
          const uriRelays = parsedUri.searchParams.getAll('relay')
          const s = parsedUri.searchParams.get('secret')
          if (uriRelays.length && s) {
            savedUri = pending.nostrConnectUri
            savedSecret = s
            savedPrivkey = pending.localSignerPrivkey
            savedRelays = uriRelays
          }
        } catch {
          // corrupted persisted state — fall through
        }
        if (!savedUri) clearPendingNip46()
      }

      if (savedUri) {
        // Restore: reuse the same localSigner privkey so the #p filter
        // matches the already-published event, and overwrite the
        // auto-generated secret/URI so the secret check lines up too.
        signer = new NDKNip46Signer(ndk, undefined, savedPrivkey, savedRelays, {
          name: 'MyNostr',
          url: 'https://mynostr.app',
        })
        signer.nostrConnectSecret = savedSecret
        signer.nostrConnectUri = savedUri
      } else {
        // Fresh flow: construct with multi-relay support, then rebuild the
        // URI with all relay params. NDK's generator only emits the first.
        signer = new NDKNip46Signer(ndk, undefined, undefined, NC_RELAYS, {
          name: 'MyNostr',
          url: 'https://mynostr.app',
        })
        const localPubkey = signer.localSigner.pubkey
        const sec = signer.nostrConnectSecret
        const params = [
          `name=${encodeURIComponent('MyNostr')}`,
          `url=${encodeURIComponent('https://mynostr.app')}`,
          `secret=${encodeURIComponent(sec)}`,
          ...NC_RELAYS.map(r => `relay=${encodeURIComponent(r)}`),
        ]
        signer.nostrConnectUri = `nostrconnect://${localPubkey}?${params.join('&')}`
        savePendingNip46({
          localSignerPrivkey: signer.localSigner.privateKey,
          nostrConnectUri: signer.nostrConnectUri,
        })
      }
      qrSignerRef.current = signer
      const secret = signer.nostrConnectSecret
      setQrUri(signer.nostrConnectUri)

      await new Promise((resolve, reject) => {
        let done = false

        async function finish(pubkeyHex) {
          if (done) return
          done = true
          signer.rpc.off('request', onRequest)
          signer.rpc.off('response', onResponse)
          try {
            signer.userPubkey = pubkeyHex
            signer._user = ndk.getUser({ pubkey: pubkeyHex })
            resolve()
          } catch (e) {
            reject(e)
          }
        }

        // The inbound event's pubkey is the BUNKER's signing key, which for
        // nsec.app / some Amber setups is NOT the user's pubkey. Always ask
        // the bunker explicitly via getPublicKey to learn the real user key.
        async function resolveUserPubkey(bunkerSigningPubkey) {
          signer.bunkerPubkey = bunkerSigningPubkey
          signer.userPubkey = null
          return signer.getPublicKey().catch(() => bunkerSigningPubkey)
        }

        async function onRequest(req) {
          if (req.method !== 'connect') return
          if (req.params?.[0] !== secret) return
          const actualPubkey = await resolveUserPubkey(req.event.pubkey)
          await finish(actualPubkey)
        }

        async function onResponse(res) {
          if (res.result !== secret) return
          const actualPubkey = await resolveUserPubkey(res.event.pubkey)
          await finish(actualPubkey)
        }

        signer.rpc.on('request', onRequest)
        signer.rpc.on('response', onResponse)

        signer.blockUntilReady().catch((err) => {
          if (done) return
          if (qrSignerRef.current === null) return
          done = true
          signer.rpc.off('request', onRequest)
          signer.rpc.off('response', onResponse)
          reject(err)
        })
      })

      if (qrSignerRef.current === null) return

      setQrWaiting(false)
      setLoading(true)
      ndk.signer = signer
      await connectAndWait(ndk)
      const user = await fetchUserProfile(ndk, signer.userPubkey)
      clearPendingNip46()
      onLogin(user)
    } catch (err) {
      if (qrSignerRef.current === null) return
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
    clearPendingNip46()
    startQrFlow()
  }

  // When the user comes back from a signer app, re-subscribe to the relay so
  // the response event (already published by the signer) gets delivered.
  // Mobile browsers are inconsistent about which event fires on return:
  //   - visibilitychange: the main one, but unreliable on iOS when coming
  //     back from a custom-scheme handoff
  //   - pageshow: fires on bfcache restore, used on some iOS Safari paths
  //     in place of a normal visibility transition
  //   - focus: backup for the rare case both of the above miss
  // A 15s interval acts as a last-resort retry — covers browsers where none
  // of the wakeup events fire, and cases where the relay took longer than
  // our first subscription attempt to replay the historical response event.
  useEffect(() => {
    if (!qrWaiting) return
    let lastRestart = Date.now()
    function restart() {
      if (!qrSignerRef.current) return
      const now = Date.now()
      if (now - lastRestart < 1000) return
      lastRestart = now
      qrSignerRef.current.stop()
      qrSignerRef.current = null
      startQrFlow()
    }
    function onVisible() {
      if (document.visibilityState === 'visible') restart()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', restart)
    window.addEventListener('focus', restart)
    const interval = setInterval(restart, 15000)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', restart)
      window.removeEventListener('focus', restart)
      clearInterval(interval)
    }
  }, [qrWaiting]) // eslint-disable-line react-hooks/exhaustive-deps

  async function copyQrUri() {
    if (!qrUri) return
    await navigator.clipboard.writeText(qrUri)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function openInSignerApp() {
    if (!qrUri) return
    window.location.href = qrUri
  }

  async function loginWithBunker() {
    setError('')
    setAuthUrl(null)
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
    // If the bunker requests web approval (authUrl) we know it's alive and
    // just waiting for the user — extend the timeout to give them time to tap.
    // On mobile, window.open from an async callback is blocked, so we surface
    // the URL in the UI; on desktop we also try to pop it up.
    let timeoutId = null
    let rejectTimeout = null
    let authRequested = false
    try {
      resetNDK()
      const ndk = getNDK()
      const signer = NDKNip46Signer.bunker(ndk, token)
      signer.on('authUrl', (url) => {
        authRequested = true
        if (timeoutId) clearTimeout(timeoutId)
        if (rejectTimeout) {
          timeoutId = setTimeout(() => rejectTimeout(new Error('__timeout__')), 180000)
        }
        let safe = null
        try {
          const parsed = new URL(url)
          if (parsed.protocol === 'https:' || parsed.protocol === 'http:') safe = url
        } catch {}
        if (!safe) return
        setAuthUrl(safe)
        if (!isMobile) {
          try { window.open(safe, '_blank', 'width=600,height=700') } catch {}
        }
      })
      ndk.signer = signer
      await Promise.race([
        signer.blockUntilReady(),
        new Promise((_, reject) => {
          rejectTimeout = reject
          timeoutId = setTimeout(() => reject(new Error('__timeout__')), 30000)
        }),
      ])
      await connectAndWait(ndk)
      const ndkUser = await signer.user()
      const user = await fetchUserProfile(ndk, ndkUser.pubkey)
      onLogin(user)
    } catch (err) {
      if (err.message === '__timeout__') {
        setError(authRequested
          ? 'Bunker requested approval but never completed. Tap the approval link above, then wait for your signer to connect.'
          : 'Bunker did not respond in time. Check that the connection string is valid and the bunker is online.')
      } else {
        setError('Bunker login failed: ' + (err.message || 'unknown error'))
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
      setLoading(false)
      setBunkerValue('')
      setAuthUrl(null)
    }
  }

  // ─── Shared sub-components ──────────────────────────────────────────────────

  const Divider = () => (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-px bg-neutral-800" />
      <span className="text-xs text-neutral-600">or</span>
      <div className="flex-1 h-px bg-neutral-800" />
    </div>
  )

  const KeySection = () => (
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor="nsec-input" className="block text-sm text-neutral-400">
          {isMobile ? 'Paste your key' : 'Private key (nsec) or public key (npub)'}
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

      {!nsecValue.startsWith('npub') && (
        <p className="text-xs text-amber-500/80 leading-relaxed">
          Your key is held in memory only and cleared when you close this page. Never stored.
        </p>
      )}
      {nsecValue.startsWith('npub') && (
        <p className="text-xs text-neutral-600 leading-relaxed">
          npub login is read-only. You can browse but cannot publish.
        </p>
      )}

      <button
        onClick={loginWithKey}
        disabled={loading || !nsecValue.trim()}
        className="w-full py-3 px-4 rounded-lg bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed text-neutral-100 font-medium transition-colors border border-neutral-700"
      >
        {loading ? 'Connecting...' : 'Login with Key'}
      </button>
    </div>
  )

  const ExtensionSection = () => (
    <div className="space-y-3">
      <button
        onClick={loginWithExtension}
        disabled={loading}
        className="w-full py-3 px-4 rounded-lg bg-purple-700 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium transition-colors"
      >
        {loading ? 'Connecting...' : 'Login with Extension'}
      </button>
      {!hasExtension && !isMobile && (
        <p className="text-xs text-neutral-500 text-center">
          Works with Alby, nos2x, Nostore, keys.band, and other NIP-07 extensions.
        </p>
      )}
    </div>
  )

  const NostrConnectSection = () => (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-neutral-400">Nostr Connect</span>
        {!isMobile && (
          <div className="flex rounded-md overflow-hidden border border-neutral-700 text-xs">
            <button
              onClick={() => switchNcTab('qr')}
              className={`px-3 py-1.5 transition-colors ${ncTab === 'qr' ? 'bg-neutral-700 text-neutral-100' : 'bg-neutral-900 text-neutral-500 hover:text-neutral-300'}`}
            >
              Scan QR
            </button>
            <button
              onClick={() => switchNcTab('paste')}
              className={`px-3 py-1.5 transition-colors border-l border-neutral-700 ${ncTab === 'paste' ? 'bg-neutral-700 text-neutral-100' : 'bg-neutral-900 text-neutral-500 hover:text-neutral-300'}`}
            >
              Paste string
            </button>
          </div>
        )}
      </div>

      {/* Mobile: signer app button + paste input */}
      {isMobile && (
        <div className="space-y-3">
          {/* Single tile — taps open the pre-generated nostrconnect:// URI
              via the system handler. Android routes to whichever signer
              claimed the scheme (Amber, Primal, etc); iOS routes to the
              user's installed signer. */}
          <button
            onClick={openInSignerApp}
            disabled={loading || !qrUri}
            className="w-full py-3 px-4 rounded-lg bg-purple-700 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium transition-colors flex items-center justify-center gap-2"
          >
            {qrWaiting && !qrUri ? (
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              'Open in Signer App'
            )}
          </button>
          {qrUri && (
            <button
              onClick={copyQrUri}
              disabled={loading}
              className="w-full py-2 px-4 rounded-lg bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed text-neutral-300 text-xs border border-neutral-700 transition-colors"
            >
              {copied ? 'Copied!' : 'Copy connection link'}
            </button>
          )}
          {qrWaiting && qrUri && (
            <div className="flex items-center justify-center gap-2 text-xs text-neutral-500">
              <span className="inline-block w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
              Waiting for signer...
            </div>
          )}

          <p className="text-xs text-neutral-500 text-center">
            Your phone will open whichever signer app claimed the nostrconnect link. Using a different signer? Copy the link above and paste it in.
          </p>

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-neutral-800" />
            <span className="text-xs text-neutral-600">or paste a bunker string</span>
            <div className="flex-1 h-px bg-neutral-800" />
          </div>

          <div className="space-y-2">
            <input
              id="bunker-input-mobile"
              type="password"
              value={bunkerValue}
              onChange={e => setBunkerValue(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && loginWithBunker()}
              placeholder="bunker://..."
              autoComplete="off"
              spellCheck={false}
              className="w-full px-4 py-3 rounded-lg bg-neutral-900 border border-neutral-700 text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-purple-600 font-mono text-sm"
            />
            <button
              onClick={loginWithBunker}
              disabled={loading || !bunkerValue.trim()}
              className="w-full py-3 px-4 rounded-lg bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed text-neutral-100 font-medium transition-colors border border-neutral-700"
            >
              {loading ? 'Connecting...' : 'Connect'}
            </button>
          </div>
        </div>
      )}

      {/* Desktop: QR code tab */}
      {!isMobile && ncTab === 'qr' && (
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

      {/* Desktop: paste bunker string tab */}
      {!isMobile && ncTab === 'paste' && (
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
            />
          </div>
          <p className="text-xs text-neutral-500 leading-relaxed">
            Generate a connection string from Nsec.app or any NIP-46 bunker, then paste it here.
          </p>
          <button
            onClick={loginWithBunker}
            disabled={loading || !bunkerValue.trim()}
            className="w-full py-3 px-4 rounded-lg bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed text-neutral-100 font-medium transition-colors border border-neutral-700"
          >
            {loading ? 'Connecting...' : 'Login with Bunker'}
          </button>
        </div>
      )}
    </div>
  )

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-4">
      <div className="w-full max-w-md space-y-6">

        {/* Logo */}
        <div className="text-center">
          <img src="/mynostr.png" alt="MyNostr" className="h-16 mx-auto mb-2" />
          <p className="mt-2 text-neutral-500 text-sm">Your personal Nostr portal</p>
        </div>

        {isMobile ? (
          <>
            {/* Mobile order: Extension first (matches desktop — mobile extensions
                have improved enough that this can be a preferred flow when present),
                then Key, then Nostr Connect */}
            {hasExtension && (
              <>
                <ExtensionSection />
                <Divider />
              </>
            )}
            <KeySection />
            <Divider />
            <NostrConnectSection />
          </>
        ) : (
          <>
            {/* Desktop order: Extension first (primary), then Key, then Nostr Connect */}
            <ExtensionSection />
            <Divider />
            <KeySection />
            <Divider />
            <NostrConnectSection />
          </>
        )}

        {/* Bunker requested web approval — the user must tap this to approve
            in their signer. Must be a real <a> tap so mobile popup blockers
            don't eat it (window.open from an async callback is blocked). */}
        {authUrl && (
          <div className="rounded-lg border border-purple-700 bg-purple-950/40 p-3 text-center space-y-2">
            <p className="text-xs text-purple-200">
              Your bunker is asking you to approve this connection.
            </p>
            <a
              href={authUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block w-full py-2 px-4 rounded-lg bg-purple-700 hover:bg-purple-600 text-white text-sm font-medium transition-colors"
            >
              Open approval page
            </a>
            <p className="text-[11px] text-neutral-500 leading-relaxed">
              Approve in the new tab, then return here. Login finishes automatically.
            </p>
          </div>
        )}

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
