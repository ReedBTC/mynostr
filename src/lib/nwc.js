/**
 * Nostr Wallet Connect (NIP-47) client lifecycle.
 *
 * Responsibilities:
 *   - Hold a single NWCClient instance per session, lazily decrypted from
 *     the localStorage blob on first use.
 *   - Validate a freshly-pasted URI before persisting (round-trip
 *     getBalance so we don't save an unreachable connection).
 *   - Encrypt-to-self before persisting; never write the raw URI to
 *     storage.
 *   - Surface a small subscriber API so the UI can react to connect /
 *     disconnect events without polling.
 *   - Verify preimages on payInvoice so a misbehaving wallet can't fake
 *     payment success.
 *   - Sync logout/disconnect across tabs via storage events.
 *
 * API surface (security review item 4): the live NWCClient is no longer
 * exported. Callers go through `payInvoice(bolt11)` which keeps the
 * client closed-over and never returns it. This prevents accidental
 * credential exposure if the API surface grows or third-party code is
 * given the result.
 */

import { storageKey } from './brand.js'
import { NWCClient } from '@getalby/sdk'
import { nip19 } from 'nostr-tools'
import { encryptForSelf, decryptFromSelf } from './selfEncrypt.js'
import { loadEncrypted, saveEncrypted, clearEncrypted, storageKeyFor } from './nwcStore.js'
import { getNDK } from './ndk.js'
import { withTimeout } from './utils.js'
import { bolt11PaymentHash } from './boostagram.js'

const SESSION_STORAGE_KEY = storageKey('session')   // matches lib/sessionPersistence.js

/**
 * Strip any nostr+walletconnect:// URI fragments (which contain the
 * shared secret) from a string before displaying or logging it. The
 * @getalby/sdk doesn't appear to embed the URI in any of its thrown
 * errors today, but defense-in-depth — if a future SDK version or
 * downstream library leaks the URI into an error message, this guard
 * keeps it out of console logs and out of the WalletConnectModal's
 * surfaced error text.
 */
export function redactNwcSecrets(value) {
  if (typeof value !== 'string') return value
  return value.replace(/nostr\+walletconnect:\/\/\S+/gi, 'nostr+walletconnect://[redacted]')
}

let activeClient = null
let activeOwnerNpub = null
let activeWalletAlias = null
// True while ensureReady() is mid-flight (decrypt + relay probe). The
// wallet row reads this through getStatus().probing and shows
// "Checking wallet…" instead of "Connect Wallet" during cold-load
// reconnection — otherwise users see a "Connect" button momentarily
// and wonder if their stored connection was forgotten.
let isEnsuring = false

const listeners = new Set()
function notify() {
  const status = getStatus()
  for (const fn of listeners) {
    try { fn(status) } catch {}
  }
}

/** Subscribe to connect/disconnect events. Returns an unsubscribe fn. */
export function onChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Snapshot of NWC state. Two shapes:
 *   { connected: false }                                                   // not unlocked
 *   { connected: true, ownerNpub, alias? }                                 // ready to pay
 *
 * `hasStoredBlob` from previous versions is removed (was never read by
 * the UI). Without an active session we no longer have a pubkey to look
 * up the per-account blob with, so we always report disconnected here —
 * `ensureReady(currentUser)` is the path that hydrates state from
 * storage on session restore.
 */
export function getStatus() {
  if (activeClient && activeOwnerNpub) {
    return { connected: true, ownerNpub: activeOwnerNpub, alias: activeWalletAlias || null, probing: isEnsuring }
  }
  return { connected: false, probing: isEnsuring }
}

/** Quick sync check used by the zap UI to decide whether to default to NWC. */
export function isReady() {
  return !!(activeClient && activeOwnerNpub)
}

async function probe(nwcUri) {
  const client = new NWCClient({ nostrWalletConnectUrl: nwcUri })
  // getBalance is the cheapest method that covers connectivity + auth.
  // 12s budget — wallet relay handshake plus signer round-trip on the
  // wallet's side; mobile wallets in the background can take a moment.
  try {
    await withTimeout(
      client.getBalance(),
      12000,
      'Wallet didn\'t respond within 12 seconds. Is your wallet online?',
    )
  } catch (e) {
    try { client.close() } catch {}
    throw e
  }
  let alias = null
  try {
    const info = await withTimeout(client.getInfo(), 6000, 'info-timeout')
    if (info && typeof info.alias === 'string') alias = info.alias
  } catch {}
  return { client, alias }
}

/**
 * Connect a fresh NWC URI.
 *   1. Probe the URI to confirm it works.
 *   2. Encrypt it to the current logged-in user via the NDK signer.
 *   3. Persist the ciphertext + activate the in-memory client.
 *
 * Throws if no Nostr session is active (NWC requires a signer to encrypt
 * to). Throws if the URI is malformed or unreachable.
 */
export async function connect(nwcUri, currentUser) {
  if (!currentUser?.pubkey) {
    throw new Error('Sign in with Nostr first — your wallet connection is encrypted with your account.')
  }
  if (typeof nwcUri !== 'string' || !nwcUri.startsWith('nostr+walletconnect://')) {
    throw new Error('That doesn\'t look like a NWC connection string. It should start with nostr+walletconnect://')
  }

  const { client, alias } = await probe(nwcUri)

  const ndk = getNDK()
  if (!ndk?.signer) {
    try { client.close() } catch {}
    throw new Error('Signer unavailable — please re-log-in.')
  }

  // 8s bound. Remote signers can hang on NIP-44 encrypt the same way they
  // hang on decrypt; a fresh connect shouldn't trap the user any longer
  // than a re-unlock would.
  let ciphertext
  try {
    ciphertext = await withTimeout(
      encryptForSelf(ndk.signer, ndk.getUser({ pubkey: currentUser.pubkey }), nwcUri),
      8000,
      'Your signer didn\'t respond. If you use a remote signer (bunker/Amber), check that it\'s online and try again.',
    )
  } catch (e) {
    console.warn('[mynostr-nwc] encrypt failed', redactNwcSecrets(String(e?.message || e)))
    try { client.close() } catch {}
    if (/timeout/i.test(String(e?.message || ''))) {
      throw new Error('Your signer didn\'t respond. Check that your bunker / signer app is online and try again.')
    }
    throw new Error('Couldn\'t secure your wallet connection. Check that your signer is responsive and try again.')
  }

  const ownerNpub = currentUser.npub || nip19.npubEncode(currentUser.pubkey)
  saveEncrypted({ ciphertext, ownerNpub })

  // Close any prior client before swapping in the new one — otherwise
  // the previous WebSocket leaks (relay subscription stays open until
  // the page reloads). Happens when a user re-connects without
  // disconnecting first, or replaces a stale connection.
  if (activeClient) {
    try { activeClient.close() } catch {}
  }

  activeClient = client
  activeOwnerNpub = ownerNpub
  activeWalletAlias = alias
  notify()
  return { alias }
}

/**
 * If a stored blob exists for `currentUser`'s account, decrypt + open
 * the client. Idempotent — if already connected, no-op. Returns true
 * on success, false on "not connected and not unlockable". Throws only
 * on transient errors the user can retry (signer rejected, relay
 * unreachable).
 */
export async function ensureReady(currentUser) {
  if (activeClient) return true
  if (!currentUser?.pubkey) return false

  const currentNpub = currentUser.npub || nip19.npubEncode(currentUser.pubkey)
  const blob = loadEncrypted(currentNpub)
  if (!blob) return false

  // Per-pubkey storage means loadEncrypted only returns the blob for
  // our key, so this check is now defensive (matches stay safe even if
  // the storage key were ever shared in a future migration bug).
  if (blob.ownerNpub !== currentNpub) {
    clearEncrypted(currentNpub)
    return false
  }

  const ndk = getNDK()
  if (!ndk?.signer) return false

  // From here we're going to do real async work (decrypt + probe).
  // Flip the probing flag and notify so the wallet row can flip from
  // "Connect Wallet" to "Checking wallet…" before we await anything.
  // Cleared in the finally below regardless of success / failure /
  // thrown error.
  isEnsuring = true
  notify()
  try {
    // 8s bound. Some signers (notably remote bunkers with broken relay sets
    // and older extension builds) silently hang on NIP-44/04 decrypt instead
    // of surfacing a rejection. Bound the call so the UI can't get stuck on
    // "Unlocking wallet…" forever.
    console.info('[mynostr-nwc] ensureReady: decrypting blob…')
    let nwcUri
    try {
      nwcUri = await withTimeout(
        decryptFromSelf(
          ndk.signer,
          ndk.getUser({ pubkey: currentUser.pubkey }),
          blob.ciphertext,
        ),
        8000,
        'Your signer didn\'t respond. If you use a remote signer (bunker/Amber), check that it\'s online and try again.',
      )
      console.info('[mynostr-nwc] ensureReady: decrypt ok')
    } catch (e) {
      console.warn('[mynostr-nwc] ensureReady: decrypt failed', redactNwcSecrets(String(e?.message || e)))
      if (/timeout/i.test(String(e?.message || ''))) {
        throw new Error('Your signer didn\'t respond. Check that your bunker / signer app is online and try again.')
      }
      throw new Error('Couldn\'t unlock your wallet connection. Reconnect to keep zapping.')
    }

    const client = new NWCClient({ nostrWalletConnectUrl: nwcUri })
    console.info('[mynostr-nwc] ensureReady: probing getBalance…')
    try {
      await withTimeout(client.getBalance(), 8000, 'wallet-unreachable')
      console.info('[mynostr-nwc] ensureReady: getBalance ok')
    } catch (e) {
      console.warn('[mynostr-nwc] ensureReady: getBalance failed', redactNwcSecrets(String(e?.message || e)))
      try { client.close() } catch {}
      throw new Error('Saved wallet connection is no longer reachable. Reconnect to keep zapping.')
    }

    activeClient = client
    activeOwnerNpub = currentNpub
    try {
      const info = await withTimeout(client.getInfo(), 5000, 'info-timeout')
      activeWalletAlias = info?.alias || null
    } catch {
      activeWalletAlias = null
    }
    console.info('[mynostr-nwc] ensureReady: connected')
    return true
  } finally {
    // Always clear the probing flag and notify — covers the success,
    // throw-from-decrypt, and throw-from-probe branches with one notify.
    isEnsuring = false
    notify()
  }
}

/**
 * Pay a bolt11 invoice via the active NWC client. Wraps the SDK's
 * payInvoice with two pieces of safety:
 *   - 25s withTimeout (vs the SDK's 60s default) so a wallet that
 *     doesn't acknowledge the kind 23195 response doesn't trap callers.
 *   - Preimage verification: sha256(preimage) MUST match the bolt11's
 *     payment_hash. A malicious wallet could otherwise feign success
 *     with a fake preimage. If the bolt11 decoder can't extract a
 *     payment_hash, we trust the wallet at face value (better to mark
 *     paid than to fail a legitimate payment for a parser quirk).
 *
 * Throws on payment failure / timeout / preimage mismatch. Returns the
 * SDK's raw response on success.
 */
export async function payInvoice(bolt11) {
  if (!activeClient) throw new Error('NWC not connected')
  const result = await withTimeout(
    activeClient.payInvoice({ invoice: bolt11 }),
    25000,
    'reply-timeout',
  )
  if (!result?.preimage) {
    throw new Error('Wallet didn\'t return a preimage — payment may not have settled.')
  }
  const expectedHash = bolt11PaymentHash(bolt11)
  if (expectedHash) {
    const ok = await verifyPreimage(result.preimage, expectedHash)
    if (!ok) {
      throw new Error('Wallet returned a preimage that doesn\'t match the invoice — payment may not have actually settled. Check your wallet.')
    }
  }
  return result
}

/**
 * Verify sha256(hexToBytes(preimage)) === paymentHash. Both inputs are
 * 64-char hex strings. Returns false on any decoding error rather than
 * throwing — the caller already has its own error path.
 */
async function verifyPreimage(preimage, paymentHash) {
  if (typeof preimage !== 'string' || !/^[0-9a-f]{64}$/i.test(preimage)) return false
  if (typeof paymentHash !== 'string' || !/^[0-9a-f]{64}$/i.test(paymentHash)) return false
  try {
    const bytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(preimage.slice(i * 2, i * 2 + 2), 16)
    }
    const hashBuf = await crypto.subtle.digest('SHA-256', bytes)
    const hashBytes = new Uint8Array(hashBuf)
    let hashHex = ''
    for (let i = 0; i < hashBytes.length; i++) {
      hashHex += hashBytes[i].toString(16).padStart(2, '0')
    }
    return hashHex === paymentHash.toLowerCase()
  } catch {
    return false
  }
}

/** Tear down the live client and clear the at-rest blob. */
export function disconnect() {
  const npub = activeOwnerNpub
  if (activeClient) {
    try { activeClient.close() } catch {}
  }
  activeClient = null
  activeOwnerNpub = null
  activeWalletAlias = null
  if (npub) clearEncrypted(npub)
  notify()
}

/**
 * Soft-reset on logout: drop the in-memory client without wiping the stored
 * blob. Next login as the same npub will unlock it again.
 */
export function lockOnLogout() {
  if (activeClient) {
    try { activeClient.close() } catch {}
  }
  activeClient = null
  activeOwnerNpub = null
  activeWalletAlias = null
  notify()
}

// ── Cross-tab logout/disconnect sync (security review item 10) ──────────
// When another tab calls `disconnect()` (clears the NWC blob) or the
// session record is wiped (logout), this tab's in-memory client is now
// stale. Listen for storage events on either key and lock down here too,
// so a user who thinks they've fully logged out everywhere actually has.
//
// Storage events fire ONLY in tabs other than the originating one, so
// this is a no-op in the originating tab and an active sync elsewhere.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (!e || e.newValue !== null) return  // we only care about deletions
    // Match either: the active tab's NWC blob being cleared by another
    // tab's disconnect(), OR the session record being cleared by another
    // tab's logout. Both should drop our in-memory client.
    const activeBlobKey = activeOwnerNpub ? storageKeyFor(activeOwnerNpub) : null
    const isWalletKey = activeBlobKey && e.key === activeBlobKey
    const isSessionKey = e.key === SESSION_STORAGE_KEY
    if (!isWalletKey && !isSessionKey) return
    if (activeClient) {
      try { activeClient.close() } catch {}
    }
    activeClient = null
    activeOwnerNpub = null
    activeWalletAlias = null
    notify()
  })
}
