/**
 * NIP-10 helpers — read reply/root references out of a kind 1 note's tags.
 *
 * Two tagging conventions are in the wild:
 *   - Preferred (NIP-10 "marked"): e-tags carry a marker in slot 3, one of
 *     'root' | 'reply' | 'mention'. Root and reply together identify the
 *     thread root and the immediate parent.
 *   - Deprecated positional: bare e-tags (no marker). First e-tag is the
 *     root, last e-tag is the immediate parent (when there's more than one).
 *     Older Damus/Amethyst notes still use this.
 *
 * 'mention' tags are never reply refs — they're just quote references to
 * notes embedded via `nostr:note1…` / `nostr:nevent1…` in content.
 */

/** Is this note a reply (in the NIP-10 sense)? */
export function isReply(note) {
  if (!note?.tags) return false
  let sawNonMentionE = false
  for (const t of note.tags) {
    if (t[0] !== 'e' || typeof t[1] !== 'string') continue
    const marker = t[3]
    if (marker === 'root' || marker === 'reply') return true
    if (marker === 'mention') continue
    // Bare e-tag (no marker) — legacy positional convention treats this as
    // a reply link.
    sawNonMentionE = true
  }
  return sawNonMentionE
}

/**
 * Pull the root + immediate-parent event ids out of a note's e-tags.
 * Returns { rootId, parentId } — either may be null if the note isn't a
 * reply. For a top-level note, both are null.
 *
 * When the note is a direct reply to the root, rootId === parentId.
 */
export function parseReplyRefs(note) {
  if (!note?.tags) return { rootId: null, parentId: null }
  const eTags = note.tags.filter(t => t[0] === 'e' && typeof t[1] === 'string' && /^[0-9a-f]{64}$/i.test(t[1]))
  if (eTags.length === 0) return { rootId: null, parentId: null }

  // Preferred form — any tag with marker 'root' or 'reply' wins.
  const rootTag  = eTags.find(t => t[3] === 'root')
  const replyTag = eTags.find(t => t[3] === 'reply')
  if (rootTag || replyTag) {
    const rootId   = (rootTag?.[1]  || replyTag?.[1] || '').toLowerCase()
    const parentId = (replyTag?.[1] || rootTag?.[1]  || '').toLowerCase()
    return { rootId: rootId || null, parentId: parentId || null }
  }

  // Deprecated positional form — ignore 'mention' tags; first non-mention
  // is root, last is parent. Direct reply → single non-mention tag.
  const chain = eTags.filter(t => t[3] !== 'mention')
  if (chain.length === 0) return { rootId: null, parentId: null }
  const first = chain[0][1].toLowerCase()
  const last  = chain[chain.length - 1][1].toLowerCase()
  return { rootId: first, parentId: last }
}
