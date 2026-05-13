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

/**
 * Pre-authorize every NIP-07 permission in one batched popup at login.
 *
 * Coracle, Snort, and other reference clients get a single approval popup
 * at sign-in listing every operation they'll ever need (read pubkey,
 * sign, nip04 encrypt/decrypt, nip44 encrypt/decrypt). NDK's
 * NDKNip07Signer.blockUntilReady only asks for read_pubkey. So our first
 * nip44.decrypt call — fired from the page-load bookmark sweep, no
 * user-gesture context — hits an unauthorized state. nos2x-fox on
 * Firefox Android can't pop up the approval from that context and throws
 * "secretsCache is undefined" instead of asking the user.
 *
 * Fix: right after getPublicKey, fire encrypt + decrypt for both schemes
 * concurrently. Extensions queue parallel permission requests and show
 * one batched popup matching Coracle's UX — user picks "Authorize
 * forever" once, every subsequent operation sails through silently.
 *
 * Only safe to call for NIP-07 sessions (callers must gate). NIP-46
 * bunkers have their own permission model and don't touch window.nostr.
 *
 * Always silent on failure — login proceeds regardless of what the
 * extension or user does with the popup.
 */
export async function warmupNip07Permissions() {
  if (typeof window === 'undefined' || !window?.nostr) return
  try {
    const pubkey = await window.nostr.getPublicKey()
    if (!pubkey || typeof pubkey !== 'string') return

    // Stage 1: encrypts in parallel. nos2x-fox queues concurrent
    // permission requests into one popup; if the user authorizes
    // forever, stage 2 (decrypts) succeeds silently.
    const has04Encrypt = typeof window.nostr.nip04?.encrypt === 'function'
    const has44Encrypt = typeof window.nostr.nip44?.encrypt === 'function'
    const encryptResults = await Promise.allSettled([
      has04Encrypt ? window.nostr.nip04.encrypt(pubkey, 'mynostr-warmup') : Promise.reject(new Error('nip04 unavailable')),
      has44Encrypt ? window.nostr.nip44.encrypt(pubkey, 'mynostr-warmup') : Promise.reject(new Error('nip44 unavailable')),
    ])

    // Stage 2: decrypts in parallel, using the freshly-encrypted blobs
    // as valid ciphertexts. Catch each individually so one scheme's
    // failure doesn't short-circuit the other.
    const decryptCalls = []
    const has04Decrypt = typeof window.nostr.nip04?.decrypt === 'function'
    const has44Decrypt = typeof window.nostr.nip44?.decrypt === 'function'
    if (has04Decrypt && encryptResults[0].status === 'fulfilled' && typeof encryptResults[0].value === 'string') {
      decryptCalls.push(
        window.nostr.nip04.decrypt(pubkey, encryptResults[0].value).catch(() => {}),
      )
    }
    if (has44Decrypt && encryptResults[1].status === 'fulfilled' && typeof encryptResults[1].value === 'string') {
      decryptCalls.push(
        window.nostr.nip44.decrypt(pubkey, encryptResults[1].value).catch(() => {}),
      )
    }
    if (decryptCalls.length) await Promise.all(decryptCalls)
  } catch {
    // Swallow — login proceeds either way. If the user rejected the
    // popup, the existing decrypt-failure banner will surface the
    // problem and offer Retry from the actual decrypt path.
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

// Retry-on-miss tuning for the kind-10002 fetch. The primary attempt is
// generous (6s) because mobile Firefox / cellular connections often need
// 1-3s per WSS handshake AFTER connectAndWait returns; a 4s window let
// us race past slow handshakes and falsely warn users with valid 10002s.
// On miss (timeout OR null), we wait 1.5s for additional relays in the
// pool to finish handshaking, then retry once with a tighter 4s window.
// Worst-case wait for users genuinely missing a 10002: 6 + 1.5 + 4 ≈
// 11.5s — slow but accurate, beats a false "no write relays" banner.
const ENSURE_RELAYS_RETRY_GAP_MS = 1500
const ENSURE_RELAYS_RETRY_TIMEOUT_MS = 4000

export async function ensureUserWriteRelays(ndk, pubkey, { timeoutMs = 6000 } = {}) {
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

  // Wraps the actual fetch so the primary + retry paths share one shape.
  // Returns the kind-10002 NDKEvent, null if the relay pool returned nothing
  // before the timeout, or throws (only for non-timeout errors — withTimeout
  // resolves null on timeout via the underlying fetch resolving empty).
  async function attemptFetch(ms) {
    return withTimeout(
      ndk.fetchEvent({ kinds: [10002], authors: [pubkey] }),
      ms,
    )
  }

  let relayListEvent = null
  let lastErr = null
  try {
    relayListEvent = await attemptFetch(timeoutMs)
  } catch (err) {
    lastErr = err
  }
  // Single retry on miss — see the constant comment above for rationale.
  // Both timeout-thrown and resolved-null land here, since both mean
  // "we didn't see the 10002 yet" and the same gap+retry helps either.
  if (!relayListEvent) {
    await new Promise(r => setTimeout(r, ENSURE_RELAYS_RETRY_GAP_MS))
    try {
      relayListEvent = await attemptFetch(ENSURE_RELAYS_RETRY_TIMEOUT_MS)
    } catch (err) {
      lastErr = err
    }
  }

  if (!relayListEvent) {
    if (lastErr) {
      warn(lastErr?.message === 'timeout' ? 'timed out fetching kind 10002' : 'error fetching kind 10002')
    } else {
      warn('no kind 10002 relay list')
    }
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

// Publish an event to a "reach" relay set: the user's own NIP-65 write
// relays unioned with FALLBACK_RELAYS. Use for events that should reach
// non-followers (kind 1 notes, reactions, reposts, comments) — followers
// get them via outbox routing through the user's own relays, and
// non-followers via the common fallbacks.
//
// Builds an explicit NDKRelaySet rather than calling event.publish()
// with no args. Without an explicit set, NDK only reaches relays that
// happened to be connected at publish time — slow relays whose WS
// handshakes hadn't finished get silently skipped, so a 12-relay write
// list could end up with the event on 6 with no warning. With a set,
// NDK opens any missing connections and waits for ACK from each.
//
// Falls back to event.publish() (the bare-pool path) only when neither
// the user's write list nor the fallbacks are available — same shape
// as publishToOwnOutbox's degenerate case.
export async function publishToPool(event) {
  const ndk = event.ndk
  const writeRelays = await getOwnWriteRelays(ndk).catch(() => null)
  const targets = Array.from(new Set([...(writeRelays || []), ...FALLBACK_RELAYS]))
  if (targets.length === 0) return event.publish()
  const relaySet = NDKRelaySet.fromRelayUrls(targets, ndk)
  return event.publish(relaySet)
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
