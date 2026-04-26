/**
 * Build a draft snapshot from a kind-1 event (parsed JSON or fetched event).
 * Shared between NoteComposer's JSON-import flow and the DraftsTray's
 * multi-JSON-import flow so both produce identical hydration.
 *
 * Two paths:
 *   1. mynostr-to-mynostr — when the event JSON carries a
 *      `_mynostr_form` sidecar (produced by handleExportJson +
 *      handleExportAllDrafts), restore from it directly. Lossless:
 *      relayOverride, manualTags, zapSplits all preserved exactly.
 *   2. Cross-client (or older mynostr exports without the sidecar) —
 *      heuristically rebuild from the canonical event tags + content.
 *      Rewrites nostr:npub URIs to @DisplayName (fetches profiles),
 *      splits out zap tags, pulls reply/quote references from NIP-10
 *      markers + content, retains non-auto tags as manualTags.
 */
import { nip19 } from 'nostr-tools'
import { fetchProfiles } from './primal.js'

const DEFAULT_SNAPSHOT = {
  content: '',
  zapSplits: [],
  userZapPct: null,
  manualTags: [],
  mentions: {},
  replyToInput: '',
  replyTarget: null,
  quoteInput: '',
  quoteTarget: null,
  relayOverride: { enabled: false, relays: [] },
  publishAt: null,
}

export async function buildDraftSnapshotFromEvent(event, userPubkey) {
  // Sidecar fast path — full UI state restored from the export.
  // Spread over DEFAULT_SNAPSHOT so older exports with a partial
  // sidecar still get sensible defaults for any newly-added fields.
  if (event && event._mynostr_form && typeof event._mynostr_form === 'object') {
    return { ...DEFAULT_SNAPSHOT, ...event._mynostr_form }
  }

  const rawContent = event.content || ''
  const tags = event.tags || []

  // Rewrite nostr:npub1/nprofile1 URIs to @DisplayName + build mentions map.
  const nextMentions = new Map()
  let loadedContent = rawContent
  const npubRe = /nostr:(npub1[a-z0-9]+|nprofile1[a-z0-9]+)/g
  const npubMatches = [...loadedContent.matchAll(npubRe)]
  if (npubMatches.length > 0) {
    const pubkeys = []
    const matchMap = []
    for (const m of npubMatches) {
      try {
        const decoded = nip19.decode(m[1])
        const pk = decoded.type === 'npub' ? decoded.data : decoded.data?.pubkey
        if (pk) { pubkeys.push(pk); matchMap.push({ fullMatch: m[0], pubkey: pk }) }
      } catch {}
    }
    if (pubkeys.length > 0) {
      try {
        const profiles = await fetchProfiles([...new Set(pubkeys)])
        for (const { fullMatch, pubkey } of matchMap) {
          const p = profiles.get(pubkey)
          const name = p?.display_name || p?.name || nip19.npubEncode(pubkey).slice(0, 12)
          let displayName = name
          if (nextMentions.has(displayName) && nextMentions.get(displayName) !== pubkey) {
            displayName = `${name}_${nip19.npubEncode(pubkey).slice(5, 9)}`
          }
          nextMentions.set(displayName, pubkey)
          loadedContent = loadedContent.replaceAll(fullMatch, `@${displayName}`)
        }
      } catch {}
    }
  }

  // Zap-split parsing — normalize weights together so the user's own share
  // stays proportional to what the JSON originally encoded.
  const userHex = (userPubkey || '').toLowerCase()
  const toHex = (v) => {
    if (typeof v !== 'string') return ''
    const s = v.trim()
    if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase()
    try {
      const d = nip19.decode(s)
      if (d.type === 'npub') return d.data.toLowerCase()
      if (d.type === 'nprofile') return (d.data.pubkey || '').toLowerCase()
    } catch {}
    return ''
  }
  const allZaps = tags
    .filter(t => t[0] === 'zap' && t[1])
    .map(t => ({ hex: toHex(t[1]), relay: t[2] || '', weight: Number(t[3]) || 1 }))
    .filter(t => t.hex)
  const totalWeight = allZaps.reduce((sum, t) => sum + t.weight, 0)

  let importedUserPct
  const zapSplits = []
  for (const t of allZaps) {
    const pct = totalWeight > 0 ? Math.round((t.weight / totalWeight) * 100) : 0
    if (userHex && t.hex === userHex) {
      importedUserPct = pct
    } else {
      zapSplits.push({ pubkey: t.hex, relay: t.relay, pct })
    }
  }
  // If the original had any zap tags but omitted the user, pin user to 0
  // so we don't auto-inject them as the remainder.
  const userZapPct = importedUserPct != null ? importedUserPct : (allZaps.length > 0 ? 0 : null)

  const autoTagTypes = new Set(['p', 't', 'e', 'a', 'zap', 'client'])
  const manualTags = tags.filter(t => !autoTagTypes.has(t[0]))

  // Reply-target detection from NIP-10 markers only.
  const eTagsForReply = tags.filter(
    t => t[0] === 'e' && typeof t[1] === 'string' && /^[0-9a-f]{64}$/i.test(t[1])
  )
  const aTagsForReply = tags.filter(t => t[0] === 'a' && typeof t[1] === 'string')
  const markedEReply = eTagsForReply.find(t => t[3] === 'reply')
  const markedERoot  = eTagsForReply.find(t => t[3] === 'root')
  const markedAReply = aTagsForReply.find(t => t[3] === 'reply')
  const markedARoot  = aTagsForReply.find(t => t[3] === 'root')

  let replyToInput = ''
  let replyTargetIdOrCoord = ''
  if (markedEReply || markedERoot) {
    const tag = markedEReply || markedERoot
    const id = tag[1].toLowerCase()
    const hint = typeof tag[2] === 'string' && tag[2].startsWith('wss://') ? tag[2] : ''
    try {
      replyToInput = nip19.neventEncode({ id, relays: hint ? [hint] : [] })
      replyTargetIdOrCoord = id
    } catch {}
  } else if (markedAReply || markedARoot) {
    const tag = markedAReply || markedARoot
    const [kindStr, pubkey, identifier = ''] = (tag[1] || '').split(':')
    const kindNum = Number(kindStr)
    const hint = typeof tag[2] === 'string' && tag[2].startsWith('wss://') ? tag[2] : ''
    if (Number.isFinite(kindNum) && /^[0-9a-f]{64}$/i.test(pubkey || '')) {
      try {
        replyToInput = nip19.naddrEncode({
          kind: kindNum,
          pubkey,
          identifier,
          relays: hint ? [hint] : [],
        })
        replyTargetIdOrCoord = `${kindNum}:${pubkey.toLowerCase()}:${identifier}`
      } catch {}
    }
  }

  // Quote detection — pick the last nostr: URI in content that isn't the reply target.
  let quoteInput = ''
  const nostrUriRe = /nostr:((?:note1|nevent1|naddr1)[a-z0-9]+)/g
  const uriMatches = [...rawContent.matchAll(nostrUriRe)]
  for (let i = uriMatches.length - 1; i >= 0; i--) {
    const bech = uriMatches[i][1]
    try {
      const decoded = nip19.decode(bech)
      let idOrCoord = ''
      if (decoded.type === 'note') {
        idOrCoord = decoded.data.toLowerCase()
      } else if (decoded.type === 'nevent') {
        idOrCoord = decoded.data.id.toLowerCase()
      } else if (decoded.type === 'naddr') {
        const { kind, pubkey, identifier = '' } = decoded.data
        idOrCoord = `${kind}:${(pubkey || '').toLowerCase()}:${identifier}`
      }
      if (idOrCoord && idOrCoord === replyTargetIdOrCoord) continue
      quoteInput = bech
      break
    } catch {}
  }

  return {
    content: loadedContent,
    mentions: Object.fromEntries(nextMentions),
    zapSplits,
    userZapPct,
    manualTags,
    replyToInput,
    replyTarget: null,
    quoteInput,
    quoteTarget: null,
    relayOverride: { enabled: false, relays: [] },
    publishAt: null,
  }
}
