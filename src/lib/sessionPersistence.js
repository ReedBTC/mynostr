import { NDKNip07Signer } from '@nostr-dev-kit/ndk'
import { warmupNip07Permissions } from './ndk.js'
import { nip19 } from 'nostr-tools'
import { getNDK, resetNDK, connectAndWait, ensureUserWriteRelays } from './ndk.js'
import { fetchProfiles } from './primal.js'
import { withTimeout } from './utils.js'
import { sanitizeRelayUrls } from './publishNote.js'
import { restoreFromSession } from './nip46Signer.js'

// Validate a 64-char hex pubkey. Used on restore to refuse garbage from a
// corrupted localStorage record before handing it to NDK.
function isHex64(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s)
}

// Persists "who is logged in and how" across reloads. Matches the convention
// every major Nostr client uses: save the handshake material for each login
// method and silently re-auth on page load. The actual credential authority
// (extension, remote signer) enforces session TTL, not us.
//
// Record shape by method:
//   extension   — { method, pubkey, npub }
//   npub        — { method, pubkey, npub }  (read-only)
//   nip46       — { method, pubkey, npub, clientSecret, bunkerPointer,
//                   userPubkey }
//     clientSecret  — hex of the Uint8Array local signer key
//     bunkerPointer — { pubkey, relays: string[], secret: string|null }
//     userPubkey    — the authoritative user pubkey the bunker signs with
//
// nsec logins are deliberately NOT persisted — the LoginScreen warns the key
// is in-memory only, matching the default stance of Primal / Iris / Snort.

const SESSION_KEY = 'mynostr_session'

export function saveSession(record) {
  if (!record?.method || !record?.pubkey) return
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(record))
  } catch {}
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.method || !parsed?.pubkey) return null
    return parsed
  } catch {
    return null
  }
}

export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY) } catch {}
}

// Hydrate the profile for a user record. Primal first (fast), NDK relay
// fallback, both time-boxed. Mirrors LoginScreen's fetchUserProfile so the
// top-right badge renders the same either way.
export async function fetchUserProfile(ndk, pubkey) {
  const user = ndk.getUser({ pubkey })
  try {
    const map = await withTimeout(fetchProfiles([pubkey]), 2500)
    const raw = map?.get?.(pubkey)
    if (raw) {
      const picture = raw.picture || raw.image
      user.profile = {
        name:        raw.name,
        displayName: raw.display_name || raw.displayName,
        image:       picture,
        picture,
        about:       raw.about,
        nip05:       raw.nip05,
        lud06:       raw.lud06,
        lud16:       raw.lud16,
        website:     raw.website,
        banner:      raw.banner,
      }
    }
  } catch {}
  if (!user.profile) {
    try {
      await withTimeout(user.fetchProfile(), 5000)
    } catch {}
  }
  return user
}

async function waitForExtension(maxMs = 2000) {
  if (typeof window === 'undefined') return false
  if (window.nostr) return true
  const start = Date.now()
  while (!window.nostr && Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 100))
  }
  return !!window.nostr
}

// Tracks any in-flight `signer.blockUntilReady()` call from restoreSession
// so the LoginScreen's manual login can wait for it to settle before
// firing its own getPublicKey. Two parallel getPublicKey calls into the
// same browser extension confuse the message channel — the popup's
// approval gets routed to whichever signer the extension picks first,
// and the other call hangs forever (NDKNip07Signer.blockUntilReady has
// no abort path; if window.nostr.getPublicKey() never resolves, neither
// does it). The classic symptom: page loads, restoreSession hits its
// timeout, LoginScreen renders, user clicks Login, "Approve in your
// extension…" hangs the full ceiling and times out — until the user
// refreshes and the auto-restore succeeds on a now-warm extension.
//
// This holds the *underlying* promise (not the timeout-wrapped one) so
// the manual login can wait for the actual extension response, even if
// restoreSession already gave up and returned null.
let inflightExtensionAuth = null

export function getInflightExtensionAuth() {
  return inflightExtensionAuth
}

/**
 * Restore a saved session. Returns the hydrated user object on success,
 * null on failure (caller should then show the login screen).
 *
 * Failure modes are silent on purpose — the restore runs at app boot with
 * no UI to surface errors, and every failure just falls through to the
 * login screen which is already the correct remediation.
 */
export async function restoreSession(record) {
  if (!record?.method || !isHex64(record.pubkey)) return null

  resetNDK()
  const ndk = getNDK()

  if (record.method === 'extension') {
    const ok = await waitForExtension(2000)
    if (!ok) return null
    try {
      const signer = new NDKNip07Signer()
      ndk.signer = signer
      // Hold the underlying promise (not the timeout-wrapped one) on a
      // module-level ref so manual login can serialize behind it. Cleared
      // when the underlying call eventually settles — even if our timeout
      // already fired and we returned null.
      const ready = signer.blockUntilReady()
      inflightExtensionAuth = ready
      ready.finally(() => {
        if (inflightExtensionAuth === ready) inflightExtensionAuth = null
      })
      // 30s ceiling (was 10s). Cold extensions — especially after a deploy
      // or fresh page load — frequently take 10-20s to wake their service
      // worker and respond. The old 10s misfired often, dumping users
      // onto LoginScreen even when the extension would have answered if
      // given another second or two. Manual login still has its own 60s
      // ceiling for the user-driven case.
      await withTimeout(ready, 30000, '__timeout__')
      const ndkUser = await signer.user()
      // Extension account may have changed since we saved — bail so the
      // login screen can re-auth as whoever the extension is currently set to.
      if (ndkUser.pubkey !== record.pubkey) return null
      await connectAndWait(ndk)
      // Warmup intentionally NOT called here: it was added to batch
      // permission popups Coracle-style, but on a tester's Firefox
      // Android the warmup's nip44 call was the FIRST nip44 hit to a
      // cold-woken nos2x-fox background script and left the extension
      // in a state where every subsequent nip44 failed. Removing the
      // warmup restores the pre-May-13 flow where the first nip44
      // call happens only when the user opens the Private bookmarks
      // tab — by which point the extension is warm and the call works.
      // If we re-introduce warmup, it must NOT fire nip44 calls
      // immediately at login.
      await ensureUserWriteRelays(ndk, ndkUser.pubkey)
      return await fetchUserProfile(ndk, ndkUser.pubkey)
    } catch {
      return null
    }
  }

  if (record.method === 'npub') {
    try {
      await connectAndWait(ndk)
      const user = await fetchUserProfile(ndk, record.pubkey)
      user.readOnly = true
      return user
    } catch {
      return null
    }
  }

  if (record.method === 'nip46') {
    const { clientSecret, bunkerPointer, userPubkey } = record
    if (!isHex64(userPubkey)) return null
    if (typeof clientSecret !== 'string' || !/^[0-9a-f]{64}$/i.test(clientSecret)) return null
    if (!bunkerPointer || !isHex64(bunkerPointer.pubkey)) return null
    const safeRelays = sanitizeRelayUrls(bunkerPointer.relays)
    if (safeRelays.length === 0) return null
    try {
      // Rebuild the bunker signer with the saved handshake material — same
      // local secret + same bunker pointer, so the bunker recognizes us
      // without the user re-approving. We skip the connect() RPC on restore
      // (reference clients do the same); if the bunker's session has since
      // expired it will surface on the first sign() call with a bounded
      // signWithTimeout error, which is the right place for that failure.
      const signer = restoreFromSession({
        ndk,
        clientSecret,
        bunkerPointer: { ...bunkerPointer, relays: safeRelays },
        userPubkey,
        onAuthUrl: (url) => {
          try {
            const parsed = new URL(url)
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return
            if (typeof window !== 'undefined') {
              window.open(url, '_blank', 'noopener,noreferrer')
            }
          } catch {}
        },
      })
      ndk.signer = signer
      await connectAndWait(ndk)
      await ensureUserWriteRelays(ndk, userPubkey)
      return await fetchUserProfile(ndk, userPubkey)
    } catch {
      return null
    }
  }

  return null
}

// ── Helpers for the LoginScreen save path ──────────────────────────────────

export function buildExtensionRecord(pubkey) {
  return { method: 'extension', pubkey, npub: nip19.npubEncode(pubkey) }
}

export function buildNpubRecord(pubkey) {
  return { method: 'npub', pubkey, npub: nip19.npubEncode(pubkey) }
}

export function buildNip46Record({ clientSecret, bunkerPointer, userPubkey }) {
  if (!clientSecret || !userPubkey || !bunkerPointer?.pubkey || !bunkerPointer?.relays?.length) {
    return null
  }
  return {
    method: 'nip46',
    pubkey: userPubkey,
    npub: nip19.npubEncode(userPubkey),
    clientSecret,
    bunkerPointer: {
      pubkey: bunkerPointer.pubkey,
      relays: bunkerPointer.relays,
      secret: bunkerPointer.secret ?? null,
    },
    userPubkey,
  }
}
