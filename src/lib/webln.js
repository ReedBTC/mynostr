/**
 * WebLN (browser-extension wallet) adapter.
 *
 * Companion to nwc.js — a second concrete wallet implementation for
 * browser-extension users (Alby, Mutiny). NWC works across devices once
 * a connection string is pasted in, but it requires the user to obtain
 * that string from their wallet UI. Browser-extension users already
 * have a one-tap pay path via WebLN that skips the copy/paste step.
 *
 * Lifecycle:
 *   - isAvailable()  → cheap sync check; window.webln is present
 *   - enable()       → user-permission gate; returns { alias } on success.
 *                      Most extensions cache the per-domain permission
 *                      after the first prompt, so subsequent enable()
 *                      calls are silent.
 *   - payInvoice()   → wraps window.webln.sendPayment; positional bolt11
 *                      arg matching nwc.payInvoice's shape so callers
 *                      can route to either adapter without knowing which.
 *
 * Persistence is intentionally minimal — a single flag in localStorage
 * marks "user previously enabled WebLN on this site". On next page load
 * the wallet status hook re-checks both `window.webln` and the flag and
 * silently re-enables if both are present. No URI to encrypt, no signer
 * round-trip, no per-account binding (the extension manages that
 * itself, so per-pubkey scoping isn't applicable here the way it is for
 * nwc).
 */

import { storageKey } from './brand.js'
import { nip19 } from 'nostr-tools'
import { withTimeout } from './utils.js'

// Per-pubkey scoping: matches nwc.js + the project's general per-pubkey
// storage rule. A previously-set flag must NOT silently re-enable WebLN
// for a *different* signed-in user — otherwise zaps from user B route
// through user A's still-authorized browser extension.
//
// Storage key uses the bech32 npub form so it ESCAPES the logout
// wipe pattern in App.jsx (which targets keys ending in `_<hex>`).
// Mirrors nwc.js's storageKey(`nwc_v1_<npub>`) pattern — both wallet
// connections persist across logout/login as a result. Callers can
// pass either hex pubkey or pre-encoded npub; we normalize.
const STORAGE_KEY_PREFIX = storageKey('webln_active_')
function storageKeyFor(pubkey) {
  if (!pubkey) return null
  try {
    const npub = pubkey.startsWith?.('npub1') ? pubkey : nip19.npubEncode(pubkey)
    return `${STORAGE_KEY_PREFIX}${npub}`
  } catch { return null }
}

let activeAlias = null
let isActive = false

const listeners = new Set()
function notify() {
  const status = getStatus()
  for (const fn of listeners) {
    try { fn(status) } catch {}
  }
}

/** Subscribe to enable/disable events. Returns an unsubscribe fn. */
export function onChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** True iff window.webln is present right now. Cheap sync check;
 *  callers can render the "Use browser extension" option conditionally. */
export function isAvailable() {
  return typeof window !== 'undefined' && !!window.webln
}

/** True once enable() has succeeded this session. */
export function isReady() {
  return isActive
}

export function getStatus() {
  return {
    connected: isActive,
    alias: activeAlias,
  }
}

/** True if the *given* pubkey previously enabled WebLN on this site. */
export function hasStoredFlag(pubkey) {
  const key = storageKeyFor(pubkey)
  if (!key) return false
  try { return localStorage.getItem(key) === '1' } catch { return false }
}

function setStoredFlag(pubkey, on) {
  const key = storageKeyFor(pubkey)
  if (!key) return
  try {
    if (on) localStorage.setItem(key, '1')
    else localStorage.removeItem(key)
  } catch {}
}

/**
 * Drive window.webln.enable() and (best-effort) fetch the wallet alias
 * via getInfo. Bounded by `timeoutMs` so a misbehaving extension that
 * never resolves doesn't lock the connect modal forever.
 *
 * `pubkey` is required so we scope the "previously enabled" flag to the
 * current Nostr identity — a different signed-in user must NOT inherit
 * a prior session's wallet authorization.
 */
export async function enable({ pubkey, timeoutMs = 15000 } = {}) {
  if (!isAvailable()) {
    throw new Error('No WebLN provider detected — install a browser extension like Alby first.')
  }
  if (!pubkey) {
    throw new Error('Sign in first — wallet authorization is scoped to your Nostr identity.')
  }
  await withTimeout(
    Promise.resolve(window.webln.enable()),
    timeoutMs,
    'Your wallet extension didn\'t respond. Try again, or check that it\'s unlocked.',
  )
  // Best-effort alias. Some providers don't implement getInfo at all.
  // Treat any failure as "alias unknown" — the connection still works.
  let alias = null
  try {
    const info = await withTimeout(
      Promise.resolve(window.webln.getInfo()),
      5000,
      'info-timeout',
    )
    alias = info?.node?.alias || info?.alias || null
  } catch {}
  isActive = true
  activeAlias = alias
  setStoredFlag(pubkey, true)
  notify()
  return { alias }
}

/**
 * Pay a bolt11 invoice. Positional string arg matches nwc.payInvoice so
 * ZapModal / payZapSplits can route to either adapter without knowing
 * which is on the other end.
 */
export async function payInvoice(bolt11) {
  if (!isActive) {
    // Belt-and-braces: shouldn't happen because callers gate on
    // isReady(), but fail loud if someone routes around it.
    throw new Error('Browser-extension wallet not enabled.')
  }
  const res = await window.webln.sendPayment(bolt11)
  if (!res || typeof res.preimage !== 'string') {
    throw new Error('Wallet didn\'t return a preimage — payment may not have settled.')
  }
  return { preimage: res.preimage }
}

/** Forget the WebLN connection. Clears the per-pubkey stored flag for
 *  the given user so a future "did this user authorize?" check is
 *  honest. The browser extension itself retains its per-domain
 *  permission grant — we have no API to revoke that. */
export function disconnect({ pubkey } = {}) {
  isActive = false
  activeAlias = null
  if (pubkey) setStoredFlag(pubkey, false)
  notify()
}

/** Soft-reset on logout: drop in-memory state but keep the flag so the
 *  next session restore can re-enable silently. Mirrors nwc.lockOnLogout. */
export function lockOnLogout() {
  isActive = false
  activeAlias = null
  notify()
}
