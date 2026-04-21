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
  // Weak signal: base64-only and long enough to be ciphertext.
  return s.length >= 32 && /^[A-Za-z0-9+/=]+$/.test(s)
}

// NDK's signer.encrypt/decrypt reads `.pubkey` off the recipient — passing
// a bare hex string silently resolves to undefined and nukes encryption
// (extension signers call window.nostr.nip44.encrypt(undefined, …) and
// PrivateKey signers throw "invalid pubkey"). Always wrap as {pubkey}.
// Our bunker wrapper accepts either form; the {pubkey} wrap works for all.
async function getSelfRecipient(ndk) {
  if (!ndk?.signer) throw new Error('No signer attached')
  const pubkey = ndk.signer.pubkey || (await ndk.signer.user())?.pubkey
  if (!pubkey) throw new Error('Cannot resolve signer pubkey')
  return { pubkey }
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
  if (!ciphertext || typeof ciphertext !== 'string') return null
  if (!ndk?.signer) return null
  let self
  try { self = await getSelfRecipient(ndk) } catch { return null }

  const looksNip04 = /\?iv=[A-Za-z0-9+/=]+$/.test(ciphertext)
  const order = looksNip04 ? ['nip04', 'nip44'] : ['nip44', 'nip04']
  for (const scheme of order) {
    try {
      const plaintext = await ndk.signer.decrypt(self, ciphertext, scheme)
      if (!plaintext) continue
      const parsed = JSON.parse(plaintext)
      if (Array.isArray(parsed)) return parsed
      return null
    } catch {
      // try the other scheme
    }
  }
  return null
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

/**
 * Longform article shape → tag-array form. We preserve the minimum to
 * rehydrate the card (aTag + addedAt); title/image/author get re-fetched
 * by the enrichment pass just like public articles.
 */
export function articlesToTagArray(articles) {
  const out = []
  for (const a of articles || []) {
    if (!a?.aTag || typeof a.aTag !== 'string') continue
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
    if (!aTag || seen.has(aTag)) continue
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
