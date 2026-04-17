import { useState, useEffect, useRef } from 'react'
import { NDKNip07Signer, NDKPrivateKeySigner, NDKNip46Signer } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { QRCodeSVG } from 'qrcode.react'
import { getNDK, resetNDK } from '../lib/ndk.js'
import { useIsMobile } from '../hooks/useIsMobile.js'

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
  const qrSignerRef = useRef(null)

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
      resetNDK()
      const signer = new NDKNip07Signer()
      const ndk = getNDK()
      ndk.signer = signer
      await Promise.race([
        signer.blockUntilReady(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('__timeout__')), 15000)),
      ])
      ndk.connect().catch(() => {})
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
        ndk.connect().catch(() => {})
        const user = await fetchUserProfile(ndk, decoded.data)
        user.readOnly = true
        onLogin(user)
      } else if (decoded.type === 'nsec') {
        const signer = new NDKPrivateKeySigner(decoded.data)
        ndk.signer = signer
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
    setNcTab(tab)
  }

  async function startQrFlow() {
    setError('')
    setQrWaiting(true)
    try {
      const ndk = getNDK()
      const signer = NDKNip46Signer.nostrconnect(ndk, 'wss://relay.primal.net', undefined, {
        name: 'MyNostr',
        url: 'https://mynostr.app',
      })
      qrSignerRef.current = signer
      const secret = new URL(signer.nostrConnectUri).searchParams.get('secret')
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
            signer.bunkerPubkey = pubkeyHex
            signer._user = ndk.getUser({ pubkey: pubkeyHex })
            resolve()
          } catch (e) {
            reject(e)
          }
        }

        async function onRequest(req) {
          if (req.method !== 'connect') return
          if (req.params?.[0] !== secret) return
          await finish(req.event.pubkey)
        }

        async function onResponse(res) {
          if (res.result !== secret) return
          signer.userPubkey = null
          const actualPubkey = await signer.getPublicKey().catch(() => res.event.pubkey)
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
      ndk.connect().catch(() => {})
      const user = await fetchUserProfile(ndk, signer.userPubkey)
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
    startQrFlow()
  }

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
      resetNDK()
      const ndk = getNDK()
      const signer = NDKNip46Signer.bunker(ndk, token)
      signer.on('authUrl', (url) => {
        try {
          const parsed = new URL(url)
          if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
            window.open(url, '_blank', 'width=600,height=700')
          }
        } catch {}
      })
      ndk.signer = signer
      await Promise.race([
        signer.blockUntilReady(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('__timeout__')), 30000)),
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
        className={`w-full py-3 px-4 rounded-lg font-medium transition-colors ${
          isMobile
            ? 'bg-neutral-800 hover:bg-neutral-700 text-neutral-300 border border-neutral-700'
            : 'bg-purple-700 hover:bg-purple-600 text-white'
        } disabled:opacity-40 disabled:cursor-not-allowed`}
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
          {/* Open in signer app — triggers nostrconnect:// deep link */}
          <button
            onClick={openInSignerApp}
            disabled={loading || !qrUri}
            className="w-full py-3 px-4 rounded-lg bg-purple-700 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium transition-colors flex items-center justify-center gap-2"
          >
            {qrWaiting && !qrUri ? (
              <>
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Preparing...
              </>
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
            Opens Amber, Keystache, or your default Nostr signer
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
            {/* Mobile order: Key first, then Nostr Connect, then Extension at bottom */}
            <KeySection />
            <Divider />
            <NostrConnectSection />
            {hasExtension && (
              <>
                <Divider />
                <ExtensionSection />
              </>
            )}
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
