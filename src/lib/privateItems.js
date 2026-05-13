/**
 * NIP-51 private items — encrypt/decrypt helpers.
 *
 * NIP-51 stores private list items in the event `content` field as the user
 * self-encrypting (NIP-44 preferred, NIP-04 still widely deployed) a JSON-
 * stringified array of tags. Each tag is a standard Nostr tag array like
 * ["e", "<id>"] or ["a", "<atag>"].
 *
 * Extra tag elements beyond position 1 are permitted by the spec — we use
 * position 4 to carry our `addedAt` millisecond timestamp so cross-device
 * bookmarks keep their "date bookmarked" ordering without losing interop
 * with clients that only read positions 0–1.
 *
 * Shape inside the encrypted tag array:
 *   ["e", "<note_id>",   "", "", "<addedAt_ms>"]
 *   ["a", "<a_tag>",     "", "", "<addedAt_ms>"]   // longform article refs
 *
 * NOT persisted to localStorage. Callers keep decrypted items in memory only
 * so a filesystem-level browser-profile inspection can't surface them without
 * the signer.
 */

/**
 * Quick heuristic to decide whether an event's content blob is NIP-51
 * ciphertext or our own JSON-array extension. We only need this right — not
 * perfect — because a false positive still survives (decrypt will fail, we
 * fall back to parsing as JSON) and a false negative (treating ciphertext as
 * JSON) is caught by the JSON.parse failure the caller already handles.
 */
export function looksEncrypted(content) {
  if (!content || typeof content !== 'string') return false
  const s = content.trim()
  if (!s) return false
  // Our extended format always starts with `[` or `{`; NIP-51 ciphertext is
  // either raw NIP-44 base64 (starts with a letter/digit) or NIP-04
  // `<b64>?iv=<b64>`.
  if (s[0] === '[' || s[0] === '{') return false
  // Strong signal: NIP-04 payloads have a `?iv=` suffix.
  if (/\?iv=[A-Za-z0-9+/=]+$/.test(s)) return true
  // Weak signal for raw NIP-44 base64: must be base64-shaped (length % 4 == 0)
  // AND at least ~88 chars — the minimum for a NIP-44 v2 payload (1B version
  // + 32B nonce + 32B MAC + ≥1B ciphertext, base64-encoded). Tighter than a
  // bare 32-char threshold so short legacy/debug strings don't false-match
  // and get stashed as unrecoverable ciphertext.
  return s.length >= 88 && s.length % 4 === 0 && /^[A-Za-z0-9+/=]+$/.test(s)
}

// Identify which kind of signer is wired into NDK without relying on
// constructor.name (mangled to single letters by Vite's minifier in
// production). We branch on stable internal properties:
//   - Nip46BunkerSigner is our wrapper class in src/lib/nip46Signer.js;
//     `_bs` holds the nostr-tools BunkerSigner, `_userPubkey` is the
//     authoritative pubkey from get_public_key.
//   - NDKPrivateKeySigner stores the key on `.privateKey` (NDK ≥ 2.x).
//   - NDKNip07Signer has no distinctive props but it's the only signer
//     that delegates to window.nostr, so we fall to that branch when
//     the extension is exposed.
function detectSignerType(signer) {
  if (!signer) return null
  if (signer._bs && signer._userPubkey) return 'NIP-46 bunker (Amber/Primal/nsec.app)'
  if (signer.privateKey || signer._privateKey) return 'private key (raw nsec)'
  if (typeof window !== 'undefined' && window.nostr) return 'NIP-07 extension (window.nostr)'
  return 'unknown'
}

// NDK's signer.encrypt/decrypt reads `.pubkey` off the recipient — passing
// a bare hex string silently resolves to undefined and nukes encryption
// (extension signers call window.nostr.nip44.encrypt(undefined, …) and
// PrivateKey signers throw "invalid pubkey"). Always wrap as {pubkey}.
// Our bunker wrapper accepts either form; the {pubkey} wrap works for all.
//
// Cache the resolved recipient per signer. Without this, a bulk op that
// encrypts/decrypts N categories can hit `signer.user()` N times — for
// NIP-46 bunkers that's a round-trip per call and can prompt the signer
// app repeatedly. WeakMap releases the entry when the signer is GC'd
// (logout / NDK reset).
const RECIPIENT_CACHE = new WeakMap()
async function getSelfRecipient(ndk) {
  if (!ndk?.signer) throw new Error('No signer attached')
  const signer = ndk.signer
  const cached = RECIPIENT_CACHE.get(signer)
  if (cached) return cached
  const pubkey = signer.pubkey || (await signer.user())?.pubkey
  if (!pubkey) throw new Error('Cannot resolve signer pubkey')
  const recipient = { pubkey }
  RECIPIENT_CACHE.set(signer, recipient)
  return recipient
}

/**
 * Encrypt a tag array as NIP-51 private content.
 *
 * Writes prefer NIP-44 (authenticated, versioned); if the signer rejects
 * (older extension, bunker without NIP-44 advertised), falls back to NIP-04
 * so we never refuse to save.
 */
export async function encryptPrivateTagArray(tagArray, ndk) {
  if (!Array.isArray(tagArray)) throw new Error('tagArray must be an array')
  const plaintext = JSON.stringify(tagArray)
  const self = await getSelfRecipient(ndk)
  try {
    return await ndk.signer.encrypt(self, plaintext, 'nip44')
  } catch (err44) {
    try {
      return await ndk.signer.encrypt(self, plaintext, 'nip04')
    } catch (err04) {
      // Surface the NIP-44 error since that was the preferred path.
      throw err44
    }
  }
}

/**
 * Decrypt NIP-51 private content. Accepts both NIP-44 and NIP-04 ciphertext —
 * tries the one the format heuristic suggests first, falls back to the other.
 * Returns the parsed tag array on success, or null on any failure (missing
 * signer, wrong key, non-JSON plaintext, corrupted data). Fail-closed by
 * design: a category with undecryptable content simply shows no private
 * items rather than revealing internals.
 */
export async function decryptPrivateTagArray(ciphertext, ndk) {
  const { result } = await decryptPrivateTagArrayDetailed(ciphertext, ndk)
  return result
}

/**
 * Same as `decryptPrivateTagArray` but also returns per-scheme error
 * strings so the UI can surface what actually went wrong. Useful for
 * diagnosing the "extension never showed a prompt" case on mobile —
 * we get to see whether the call rejected, returned empty, hit a
 * TypeError, or never reached the extension at all.
 *
 * Returns `{ result, errors, available }`:
 *   - result: parsed tag array, or null on failure
 *   - errors: array of "<scheme>: <message>" strings, one per failed attempt
 *   - available: { nip04, nip44, hasSigner, pubkey } — capability snapshot
 *     of window.nostr at call time
 */
export async function decryptPrivateTagArrayDetailed(ciphertext, ndk) {
  const available = {
    nip04: typeof window?.nostr?.nip04?.decrypt === 'function',
    nip44: typeof window?.nostr?.nip44?.decrypt === 'function',
    hasSigner: !!ndk?.signer,
    // signerType pins which decrypt path actually ran. We duck-type
    // instead of reading constructor.name — Vite minifies class names
    // in production, so NDKNip07Signer becomes "Ee" and the field
    // becomes useless for triage. Properties are stable across builds.
    signerType: detectSignerType(ndk?.signer),
    pubkey: null,
  }
  if (!ciphertext || typeof ciphertext !== 'string') {
    return { result: null, errors: ['input: empty ciphertext'], available }
  }
  if (!ndk?.signer) {
    return { result: null, errors: ['signer: not attached to NDK'], available }
  }
  let self
  try {
    self = await getSelfRecipient(ndk)
    available.pubkey = self?.pubkey || null
  } catch (e) {
    return { result: null, errors: [`recipient: ${e?.message || String(e)}`], available }
  }

  const looksNip04 = /\?iv=[A-Za-z0-9+/=]+$/.test(ciphertext)
  const order = looksNip04 ? ['nip04', 'nip44'] : ['nip44', 'nip04']
  const errors = []

  // Bypass NDK's queueEncryption for NIP-07 extensions and call
  // window.nostr directly — same pattern Coracle/welshman uses
  // (Nip07Signer just does `ext.nip44.decrypt(pubkey, message)`).
  // NDK's queue serializes through a recursive helper and retries on
  // "call already executing"; for nos2x-fox on mobile Firefox that
  // extra indirection has been observed to leave decrypt in a state
  // where the extension throws internal errors ("secretsCache is
  // undefined") on otherwise-authorized self-decrypts. A direct call
  // matches what works on coracle.social on the same device/extension.
  const useDirectExtensionCall = (
    !!window?.nostr &&
    available.signerType === 'NIP-07 extension (window.nostr)'
  )

  for (const scheme of order) {
    try {
      let plaintext
      if (useDirectExtensionCall && typeof window.nostr?.[scheme]?.decrypt === 'function') {
        plaintext = await window.nostr[scheme].decrypt(self.pubkey, ciphertext)
      } else {
        plaintext = await ndk.signer.decrypt(self, ciphertext, scheme)
      }
      if (!plaintext) {
        errors.push(`${scheme}: empty result (extension returned nothing — often a silent permission denial)`)
        continue
      }
      try {
        const parsed = JSON.parse(plaintext)
        if (Array.isArray(parsed)) return { result: parsed, errors, available }
        errors.push(`${scheme}: decrypted but not a JSON array`)
      } catch (e) {
        errors.push(`${scheme}: decrypted but JSON parse failed (${e?.message || String(e)})`)
      }
    } catch (e) {
      errors.push(`${scheme}: ${e?.message || String(e)}`)
    }
  }
  return { result: null, errors, available }
}

// ─── Item <-> NIP-51 tag-array converters ────────────────────────────────

/**
 * Convert our notes-module item shape ({id, addedAt}) to the NIP-51 tag
 * form used inside the encrypted content blob. addedAt is stashed in
 * position 4 — other clients reading position 0-1 see a normal `e` tag.
 */
export function noteItemsToTagArray(items) {
  const out = []
  for (const it of items || []) {
    if (!it?.id || !/^[0-9a-f]{64}$/i.test(it.id)) continue
    out.push(['e', it.id.toLowerCase(), '', '', String(it.addedAt || 0)])
  }
  return out
}

/**
 * Read notes-module items out of a decrypted NIP-51 tag array. Ignores any
 * non-`e` tags (longform `a` tags coming from a shared category — those are
 * the longform hook's to handle).
 */
export function tagArrayToNoteItems(tagArray) {
  const items = []
  const seen = new Set()
  for (const t of tagArray || []) {
    if (!Array.isArray(t) || t[0] !== 'e') continue
    const id = typeof t[1] === 'string' ? t[1].toLowerCase() : null
    if (!id || !/^[0-9a-f]{64}$/.test(id) || seen.has(id)) continue
    seen.add(id)
    const addedAt = Number(t[4]) || 0
    items.push({ id, addedAt })
  }
  return items
}

// NIP-33 addressable event reference: `<kind>:<pubkey-hex>:<d-tag>`.
// Validate shape so a malformed or malicious entry in a decrypted blob
// can't propagate into `event.tags` on the next publish.
const ATAG_PATTERN = /^\d+:[0-9a-f]{64}:.+$/

/**
 * Longform article shape → tag-array form. We preserve the minimum to
 * rehydrate the card (aTag + addedAt); title/image/author get re-fetched
 * by the enrichment pass just like public articles.
 */
export function articlesToTagArray(articles) {
  const out = []
  for (const a of articles || []) {
    if (!a?.aTag || typeof a.aTag !== 'string') continue
    if (!ATAG_PATTERN.test(a.aTag)) continue
    out.push(['a', a.aTag, '', '', String(a.addedAt || 0)])
  }
  return out
}

export function tagArrayToArticles(tagArray) {
  const out = []
  const seen = new Set()
  for (const t of tagArray || []) {
    if (!Array.isArray(t) || t[0] !== 'a') continue
    const aTag = typeof t[1] === 'string' ? t[1] : null
    if (!aTag || !ATAG_PATTERN.test(aTag) || seen.has(aTag)) continue
    seen.add(aTag)
    out.push({
      aTag,
      title: '',
      image: '',
      author: '',
      tTags: [],
      addedAt: Number(t[4]) || 0,
    })
  }
  return out
}
