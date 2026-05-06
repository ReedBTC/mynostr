import NDK, { NDKRelaySet } from '@nostr-dev-kit/ndk'
import { withTimeout } from './utils.js'
import { resetPublishedAtCounter } from './publishProduct.js'

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
// Module-level buffer so the AppShell banner can display a warning that
// fired before it mounted. ensureUserWriteRelays runs during login/restore,
// which completes BEFORE the module route + AppShell mount, so a pure
// event-listener approach loses races. The banner reads this on mount and
// clears it on dismiss. Cleared when a subsequent call succeeds so the
// user doesn't see a stale warning across re-logins.
export const OUTBOX_WARNING_EVENT = 'mynostr:outbox-warning'
let _lastOutboxWarning = null
// Defensive copy — callers shouldn't be able to mutate the shared buffer by
// accident (a rename of `.reason` would silently corrupt the banner state).
export function getLastOutboxWarning() {
  return _lastOutboxWarning ? { ..._lastOutboxWarning } : null
}
export function clearLastOutboxWarning() { _lastOutboxWarning = null }

export async function ensureUserWriteRelays(ndk, pubkey, { timeoutMs = 4000 } = {}) {
  if (!ndk || !pubkey) return []
  // Empty/failed results mean subsequent publishes will fall back to the
  // full pool (fallback relays) — the exact pre-outbox-migration behavior
  // we're trying to get away from. Surface it so the user can react
  // (re-login, check RelayCard) rather than silently writing to relays
  // their followers don't read from.
  const warn = (reason) => {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn(`[ensureUserWriteRelays] ${reason} for ${pubkey.slice(0, 8)}… — publishes will hit fallback relays`)
    }
    _lastOutboxWarning = { pubkey, reason, at: Date.now() }
    try {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(OUTBOX_WARNING_EVENT, { detail: { pubkey, reason } }))
      }
    } catch {}
  }
  try {
    const relayListEvent = await withTimeout(
      ndk.fetchEvent({ kinds: [10002], authors: [pubkey] }),
      timeoutMs,
    )
    if (!relayListEvent) {
      warn('no kind 10002 relay list')
      return []
    }
    const writeRelays = (relayListEvent.tags || [])
      .filter(t => t[0] === 'r' && (!t[2] || t[2] === 'write'))
      .map(t => t[1])
      .filter(u => typeof u === 'string' && /^wss:\/\//i.test(u))
    if (writeRelays.length === 0) {
      warn('kind 10002 has no write relays')
      return []
    }
    for (const url of writeRelays) {
      try { ndk.addExplicitRelay(url) } catch {}
    }
    // Success — clear any prior warning so a recovered session doesn't
    // keep nagging the user about an outbox issue that no longer applies.
    _lastOutboxWarning = null
    return writeRelays
  } catch (err) {
    warn(err?.message === 'timeout' ? 'timed out fetching kind 10002' : 'error fetching kind 10002')
    return []
  }
}

// Resolve the signed-in user's NIP-65 write relays. Returns the URL list if
// we can read a kind 10002, null otherwise — callers decide how to handle a
// missing 10002 (fall back to pool, prompt the user, etc).
//
// Implementation note: we used to rely on `ndk.activeUser.relayList()`,
// but that helper can return stale or empty results when the user's
// 10002 has changed during the session — exactly when accurate write-
// relay targeting matters most (a publish to the wrong relay set lands
// on relays nobody queries; a delete to the wrong relay set never
// reaches the relays serving the original event). A direct fetchEvent
// against the kind-10002 filter is slower but always reflects the
// current state of the network, which is what callers expect.
export async function getOwnWriteRelays(ndk) {
  const pubkey = ndk?.activeUser?.pubkey
  if (!ndk || !pubkey) return null
  try {
    const ev = await withTimeout(
      ndk.fetchEvent({ kinds: [10002], authors: [pubkey] }),
      5000,
      'fetch-10002-timeout',
    )
    if (!ev) return null
    const urls = (ev.tags || [])
      .filter(t => t[0] === 'r' && (!t[2] || t[2] === 'write'))
      .map(t => t[1])
      .filter(u => typeof u === 'string' && /^wss:\/\//i.test(u))
    return urls.length ? urls : null
  } catch {
    return null
  }
}

// Resolve the signed-in user's NIP-65 read relays. Symmetric with
// getOwnWriteRelays — same direct-fetch pattern (no NDK helper cache),
// same null-on-miss contract. Used by features that need to query the
// user's full read surface, including read-only relays that
// ensureUserWriteRelays doesn't add to the explicit pool.
export async function getOwnReadRelays(ndk) {
  const pubkey = ndk?.activeUser?.pubkey
  if (!pubkey) return null
  return getUserReadRelays(ndk, pubkey)
}

/**
 * Read another user's NIP-65 read relays — the relays they listen on
 * for incoming events. Used by publish paths that want to ensure the
 * recipient actually sees what we send (RSVPs being the canonical
 * case: the event host needs to know who's coming).
 *
 * Returns array of wss:// URLs, or null if the user has no kind 10002.
 * Unmarked `r` tags count as read+write; explicit `'read'` marker is
 * also read.
 */
export async function getUserReadRelays(ndk, pubkey) {
  if (!ndk || !pubkey) return null
  try {
    const ev = await withTimeout(
      ndk.fetchEvent({ kinds: [10002], authors: [pubkey] }),
      4000,
      'fetch-10002-timeout',
    )
    if (!ev) return null
    const urls = (ev.tags || [])
      .filter(t => t[0] === 'r' && (!t[2] || t[2] === 'read'))
      .map(t => t[1])
      .filter(u => typeof u === 'string' && /^wss:\/\//i.test(u))
    return urls.length ? urls : null
  } catch {
    return null
  }
}

// Publish an event only to the user's own NIP-65 write relays.
//
// This is the outbox-model publish path. Use it for events the user will want
// to edit or retract later — replaceables (profile, contacts, bookmarks,
// reading lists, articles, drafts, kind-5 deletes). Publishing such events to
// fallback relays outside the user's write set creates data debt: a future
// edit or delete published to the user's own relays won't reach those copies,
// so third-party clients may keep showing the old version.
//
// If the user has no 10002 yet, we fall back to the full pool — there's
// nothing else to target until they publish one, and their writes landing on
// the fallbacks is the same outcome as today. The RelayCard onboarding prompts
// for 10002 setup, so this degenerate case is bounded.
export async function publishToOwnOutbox(event) {
  const ndk = event.ndk
  const writeRelays = await getOwnWriteRelays(ndk)
  if (!writeRelays) return event.publish()
  const relaySet = NDKRelaySet.fromRelayUrls(writeRelays, ndk)
  return event.publish(relaySet)
}

// Publish an event to NDK's full relay pool (user's outbox + fallbacks).
// Use this for reach-over-recall events: kind 1 notes, reactions, reposts,
// and the kind 10002 relay list itself (bootstrap repair).
export async function publishToPool(event) {
  return event.publish()
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
  // Drop any outbox warning left over from the previous session so a relog
  // (same or different account) starts clean.
  _lastOutboxWarning = null
  // Reset the marketplace publish-timestamp monotonic counter so the next
  // user's first publish doesn't inherit drift from the prior session.
  resetPublishedAtCounter()
}
