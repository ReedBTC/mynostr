import { NDKNip07Signer, NDKNip46Signer } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { getNDK, resetNDK, connectAndWait } from './ndk.js'
import { fetchProfiles } from './primal.js'
import { sanitizeRelayUrls } from './publishNote.js'

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
//   nip46       — { method, pubkey, npub, bunkerPubkey, userPubkey,
//                   localSignerPrivkey, relays }
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
    const map = await Promise.race([
      fetchProfiles([pubkey]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500)),
    ])
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
      await Promise.race([
        user.fetchProfile(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ])
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
      await Promise.race([
        signer.blockUntilReady(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('__timeout__')), 10000)),
      ])
      const ndkUser = await signer.user()
      // Extension account may have changed since we saved — bail so the
      // login screen can re-auth as whoever the extension is currently set to.
      if (ndkUser.pubkey !== record.pubkey) return null
      await connectAndWait(ndk)
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
    const { bunkerPubkey, userPubkey, localSignerPrivkey, relays } = record
    if (!isHex64(bunkerPubkey) || !isHex64(userPubkey)) return null
    if (typeof localSignerPrivkey !== 'string' || !/^[0-9a-f]{64}$/i.test(localSignerPrivkey)) return null
    const safeRelays = sanitizeRelayUrls(relays)
    if (safeRelays.length === 0) return null
    try {
      const signer = new NDKNip46Signer(
        ndk, bunkerPubkey, localSignerPrivkey, safeRelays,
        { name: 'MyNostr', url: 'https://mynostr.app' }
      )
      // The remote signer already approved this localSigner in a prior
      // session, so wire up userPubkey / _user directly rather than
      // re-running the nostrconnect handshake. Kick off blockUntilReady()
      // in a time-boxed race so the RPC subscription comes online before
      // the first sign request; if it hangs (bunker offline), proceed
      // anyway — a later sign attempt will surface the failure.
      //
      // NOTE: `signer._user` is a private NDK internal (leading _).
      // LoginScreen's post-handshake path relies on the same field, so
      // both restore and fresh-login must move together across NDK
      // upgrades. Currently pinned to @nostr-dev-kit/ndk ^2 (2.18.x).
      signer.userPubkey = userPubkey
      signer._user = ndk.getUser({ pubkey: userPubkey })
      ndk.signer = signer
      await Promise.race([
        signer.blockUntilReady().catch(() => {}),
        new Promise(r => setTimeout(r, 5000)),
      ])
      await connectAndWait(ndk)
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

export function buildNip46Record({ bunkerPubkey, userPubkey, localSignerPrivkey, relays }) {
  if (!bunkerPubkey || !userPubkey || !localSignerPrivkey || !relays?.length) return null
  return {
    method: 'nip46',
    pubkey: userPubkey,
    npub: nip19.npubEncode(userPubkey),
    bunkerPubkey,
    userPubkey,
    localSignerPrivkey,
    relays,
  }
}

// Parse the relay list out of a bunker:// connection string. NDK stores it
// internally after parsing, but the accessor is private, so we keep our own
// parse for the save path. `new URL('bunker://abc?relay=wss://x')` works in
// modern browsers even for non-standard schemes.
export function parseBunkerRelays(token) {
  try {
    const url = new URL(token)
    return url.searchParams.getAll('relay')
  } catch {
    return []
  }
}
