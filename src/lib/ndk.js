import NDK from '@nostr-dev-kit/ndk'

// Fallback relays used when user has no Kind 10002 relay list
export const FALLBACK_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
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
