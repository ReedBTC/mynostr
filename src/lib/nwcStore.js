/**
 * Persistence for the user's NWC (NIP-47) connection URI.
 *
 * The URI is a bearer credential — anyone holding it can spend up to the
 * budget the user authorized when issuing the connection. So we never write
 * the raw URI to localStorage. Instead we encrypt it *to the user themselves*
 * via NIP-44 (NIP-04 fallback) using whatever signer they're logged in with,
 * and store only the ciphertext + the npub it was encrypted to.
 *
 * Storage scoping (security review item 5):
 *   Per-pubkey key — storageKey(`nwc_v1_<npub>`). Different accounts on the
 *   same browser can each have their own wallet without one clearing the
 *   other on login. Legacy global storageKey(`nwc_v1`) blobs are migrated on
 *   first read by the matching owner; mismatched legacy blobs are
 *   discarded (we can't migrate to a key we don't own).
 *
 * Size cap (security review item 3):
 *   loadEncrypted refuses blobs over MAX_BLOB_SIZE — a real ciphertext
 *   is well under 1KB. Oversized blobs are likely tampered or planted
 *   by a malicious extension; we drop them rather than feed garbage to
 *   the signer.
 *
 * Properties of the encrypt-to-self scheme:
 *   - Encrypted blob is useless without the signer. A malicious browser
 *     extension that exfiltrates localStorage gets ciphertext only.
 *   - On logout the signer drops; the blob becomes inert until they log
 *     back in as the same npub.
 *   - On login as a different npub, that account's blob (if any) is
 *     loaded; the previous account's blob stays untouched.
 *
 * Storage shape:
 *   localStorage[storageKey("nwc_v1_<npub>")] = JSON.stringify({
 *     ciphertext: "<scheme-prefixed encrypted NWC URI>",
 *     ownerNpub: "npub1...",
 *     savedAt: 1714329600000,
 *   })
 */

import { storageKey } from './brand.js'

const STORAGE_PREFIX  = storageKey('nwc_v1_')
const LEGACY_KEY      = storageKey('nwc_v1')   // pre-scoping global key
const MAX_BLOB_SIZE   = 4096               // ciphertext is normally <800 chars

function scopedKey(ownerNpub) { return `${STORAGE_PREFIX}${ownerNpub}` }

/**
 * Migrate a legacy global blob to per-pubkey storage. Idempotent — if
 * the legacy key is missing or already matched, no-op. If the legacy
 * blob's ownerNpub matches the current user, it's copied to the
 * per-pubkey key. Either way (match or not), the legacy key is cleared
 * after — we don't leave global wallet ciphertext lingering.
 */
function migrateLegacyBlob(ownerNpub) {
  try {
    const legacy = localStorage.getItem(LEGACY_KEY)
    if (!legacy) return
    if (legacy.length <= MAX_BLOB_SIZE) {
      try {
        const parsed = JSON.parse(legacy)
        if (parsed?.ownerNpub === ownerNpub) {
          localStorage.setItem(scopedKey(ownerNpub), legacy)
        }
      } catch {}
    }
    localStorage.removeItem(LEGACY_KEY)
  } catch {}
}

/**
 * Read the encrypted NWC blob for a specific account. Returns null when
 * none exists, when the blob is oversized (likely tampered), or when
 * its shape is malformed.
 */
export function loadEncrypted(ownerNpub) {
  if (typeof ownerNpub !== 'string' || !ownerNpub.startsWith('npub1')) return null
  migrateLegacyBlob(ownerNpub)
  try {
    const raw = localStorage.getItem(scopedKey(ownerNpub))
    if (!raw) return null
    if (raw.length > MAX_BLOB_SIZE) {
      // Tampered or planted oversized blob — clear and bail. Real
      // ciphertext is comfortably under 1KB.
      try { localStorage.removeItem(scopedKey(ownerNpub)) } catch {}
      return null
    }
    const parsed = JSON.parse(raw)
    if (typeof parsed?.ciphertext !== 'string' || typeof parsed?.ownerNpub !== 'string') {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * Persist the encrypted blob under `ownerNpub`'s key. Validates input
 * shape; a malformed call is a silent no-op (callers shouldn't be
 * passing bad input).
 */
export function saveEncrypted({ ciphertext, ownerNpub }) {
  if (typeof ciphertext !== 'string' || !ciphertext) return
  if (typeof ownerNpub !== 'string' || !ownerNpub.startsWith('npub1')) return
  try {
    localStorage.setItem(scopedKey(ownerNpub), JSON.stringify({
      ciphertext,
      ownerNpub,
      savedAt: Date.now(),
    }))
  } catch {}
}

/** Wipe the at-rest blob for a specific account. Called on disconnect or
 *  cross-tab logout sync. */
export function clearEncrypted(ownerNpub) {
  if (typeof ownerNpub !== 'string' || !ownerNpub.startsWith('npub1')) return
  try { localStorage.removeItem(scopedKey(ownerNpub)) } catch {}
}

/** The localStorage key used for `ownerNpub` — exposed so the cross-tab
 *  storage-event listener can match on key. */
export function storageKeyFor(ownerNpub) { return scopedKey(ownerNpub) }
