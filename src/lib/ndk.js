import NDK from '@nostr-dev-kit/ndk'

// Fallback relays used when user has no Kind 10002 relay list
export const FALLBACK_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://purplepag.es',
]

// NDK singleton — one instance shared across the entire app lifetime
let ndkInstance = null

export function getNDK() {
  if (!ndkInstance) {
    ndkInstance = new NDK({
      explicitRelayUrls: FALLBACK_RELAYS,
    })
  }
  return ndkInstance
}

// Kick off NDK's relay connections and wait for at least one to be ready.
// Prevents races where login completes before any relay handshake finishes —
// the next fetchEvent/publish would otherwise fail silently on mobile where
// WSS handshakes can take 1–3s each.
export async function connectAndWait(ndk, timeoutMs = 5000) {
  ndk.connect().catch(() => {})
  const start = Date.now()
  while (!ndk.pool.connectedRelays().length && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 100))
  }
}

// Remote signers (NIP-46 / bunker) round-trip the sign request through a
// relay, and the promise can hang indefinitely if the signer app is
// backgrounded, the auto-approve trust level didn't take, or the subscription
// died. Bound every sign call so the UI always reaches a terminal state —
// caller surfaces the message to the user.
export const SIGN_TIMEOUT_MS = 20000

export async function signWithTimeout(event, timeoutMs = SIGN_TIMEOUT_MS) {
  let timer
  try {
    await Promise.race([
      event.sign(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          'Signer timed out after 20s. If you\'re using a remote signer (bunker), check the signer app — the request may be waiting for approval, or the connection may have dropped.'
        )), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Add the signed-in user's kind-10002 write relays to NDK's explicit pool.
// This is the outbox model (NIP-65): events the user publishes should go
// to the relays their followers already read from, not just our fallbacks.
//
// Without this, every publish — bookmarks, profile edits, notes, reading
// lists — only hits the four FALLBACK_RELAYS. If a user writes to 12
// relays, readers watching the other 8 never see the update.
//
// Safe to call multiple times; addExplicitRelay dedupes by URL. No-op if
// the user has no 10002 or the lookup times out. Doesn't block on the
// new relays completing their WS handshake — NDK connects them in the
// background, so this call returns as soon as the 10002 is parsed.
export async function ensureUserWriteRelays(ndk, pubkey, { timeoutMs = 4000 } = {}) {
  if (!ndk || !pubkey) return []
  try {
    const relayListEvent = await Promise.race([
      ndk.fetchEvent({ kinds: [10002], authors: [pubkey] }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ])
    if (!relayListEvent) return []
    const writeRelays = (relayListEvent.tags || [])
      .filter(t => t[0] === 'r' && (!t[2] || t[2] === 'write'))
      .map(t => t[1])
      .filter(u => typeof u === 'string' && /^wss:\/\//i.test(u))
    for (const url of writeRelays) {
      try { ndk.addExplicitRelay(url) } catch {}
    }
    return writeRelays
  } catch {
    return []
  }
}

// Call on logout to close relay connections, detach the signer,
// and force a fresh NDK instance on next login.
export function resetNDK() {
  if (ndkInstance) {
    try {
      // Stop NIP-46 relay subscription if the signer has one (e.g. bunker/nostrconnect)
      if (ndkInstance.signer?.stop) ndkInstance.signer.stop()
      // Detach the signer so the private key reference is released immediately
      // rather than waiting for GC to collect the old NDK instance
      ndkInstance.signer = undefined
      for (const relay of ndkInstance.pool?.relays?.values() || []) {
        relay.disconnect()
      }
    } catch {
      // Best-effort cleanup — don't block logout on relay errors
    }
  }
  ndkInstance = null
}
