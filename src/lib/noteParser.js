/**
 * noteParser.js — Parse kind 1 note content into renderable segments,
 * extract auto-generated tags, and validate uploaded events.
 */
import { CLIENT_TAG } from './brand.js'
import { nip19 } from 'nostr-tools'

// ─── Media detection ─────────────────────────────────────────────────────────

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|svg|avif)(\?[^\s]*)?$/i
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?[^\s]*)?$/i
const YOUTUBE_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{11})/

// ─── Nostr entity patterns ───────────────────────────────────────────────────

// Matches nostr: URIs (NIP-27)
const NOSTR_URI_RE = /nostr:(npub1[a-z0-9]+|nprofile1[a-z0-9]+|note1[a-z0-9]+|nevent1[a-z0-9]+|naddr1[a-z0-9]+)/g

// Matches hashtags: #word but not inside URLs
const HASHTAG_RE = /(?:^|\s)#([a-zA-Z]\w{0,49})(?=\s|$|[.,!?;:])/g

// URL pattern — liberal match for http(s) URLs
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g

// ─── Segment types ───────────────────────────────────────────────────────────

/**
 * Parse note content into an ordered array of typed segments.
 *
 * @param {string} content — the note's text content
 * @returns {Array<{type: string, value: string, data?: object}>}
 *
 * Segment types:
 *   text      — plain text (may contain newlines)
 *   mention   — nostr:npub1... or nostr:nprofile1...
 *   note_embed — nostr:note1... or nostr:nevent1... or nostr:naddr1...
 *   hashtag   — #tag
 *   image     — URL ending in image extension
 *   video     — URL ending in video extension
 *   youtube   — YouTube link
 *   link      — any other http(s) URL
 */
export function parseNoteContent(content) {
  if (!content) return [{ type: 'text', value: '' }]

  // Build a list of all matches with their positions
  const tokens = []

  // Nostr URIs
  for (const m of content.matchAll(NOSTR_URI_RE)) {
    const raw = m[1]
    let type = 'mention'
    let data = {}
    try {
      const decoded = nip19.decode(raw)
      data = { decoded }
      if (decoded.type === 'note' || decoded.type === 'nevent' || decoded.type === 'naddr') {
        type = 'note_embed'
      }
    } catch {
      data = { error: true }
    }
    tokens.push({ type, start: m.index, end: m.index + m[0].length, value: m[0], data })
  }

  // URLs (must come after nostr URIs to avoid double-matching)
  for (const m of content.matchAll(URL_RE)) {
    // Skip if this position is already covered by a nostr: URI
    if (tokens.some(t => m.index >= t.start && m.index < t.end)) continue

    const url = m[0]
    let type = 'link'
    const data = { url }

    if (IMAGE_EXT.test(url)) {
      type = 'image'
    } else if (VIDEO_EXT.test(url)) {
      type = 'video'
    } else if (YOUTUBE_RE.test(url)) {
      type = 'youtube'
      data.videoId = url.match(YOUTUBE_RE)[1]
    }

    tokens.push({ type, start: m.index, end: m.index + url.length, value: url, data })
  }

  // Hashtags
  for (const m of content.matchAll(HASHTAG_RE)) {
    const hashStart = m[0].indexOf('#') + m.index
    const fullTag = '#' + m[1]
    // Skip if inside a URL or nostr entity
    if (tokens.some(t => hashStart >= t.start && hashStart < t.end)) continue
    tokens.push({
      type: 'hashtag',
      start: hashStart,
      end: hashStart + fullTag.length,
      value: fullTag,
      data: { tag: m[1].toLowerCase() },
    })
  }

  // Sort by position
  tokens.sort((a, b) => a.start - b.start)

  // Build segments: fill gaps with text segments
  const segments = []
  let cursor = 0

  for (const token of tokens) {
    if (token.start > cursor) {
      segments.push({ type: 'text', value: content.slice(cursor, token.start) })
    }
    segments.push({ type: token.type, value: token.value, data: token.data })
    cursor = token.end
  }

  // Trailing text
  if (cursor < content.length) {
    segments.push({ type: 'text', value: content.slice(cursor) })
  }

  return segments.length ? segments : [{ type: 'text', value: content }]
}

// ─── Tag extraction ──────────────────────────────────────────────────────────

/**
 * Scan content and auto-generate p, t, and e tags.
 * These correspond to mentions, hashtags, and quoted events found in the text.
 *
 * @param {string} content
 * @returns {Array<string[]>} — array of Nostr tag arrays
 */
export function extractTags(content) {
  if (!content) return []

  const tags = []
  const seenP = new Set()
  const seenT = new Set()
  const seenE = new Set()

  // Nostr URIs → p and e tags
  for (const m of content.matchAll(NOSTR_URI_RE)) {
    try {
      const decoded = nip19.decode(m[1])
      switch (decoded.type) {
        case 'npub':
          if (!seenP.has(decoded.data)) {
            seenP.add(decoded.data)
            tags.push(['p', decoded.data])
          }
          break
        case 'nprofile':
          if (!seenP.has(decoded.data.pubkey)) {
            seenP.add(decoded.data.pubkey)
            tags.push(['p', decoded.data.pubkey, decoded.data.relays?.[0] || ''])
          }
          break
        case 'note':
          if (!seenE.has(decoded.data)) {
            seenE.add(decoded.data)
            tags.push(['e', decoded.data, '', 'mention'])
          }
          break
        case 'nevent':
          if (!seenE.has(decoded.data.id)) {
            seenE.add(decoded.data.id)
            tags.push(['e', decoded.data.id, decoded.data.relays?.[0] || '', 'mention'])
          }
          break
        case 'naddr': {
          const d = decoded.data
          const aTag = `${d.kind}:${d.pubkey}:${d.identifier}`
          tags.push(['a', aTag, d.relays?.[0] || '', 'mention'])
          break
        }
      }
    } catch {
      // Skip invalid entities
    }
  }

  // Hashtags → t tags
  for (const m of content.matchAll(HASHTAG_RE)) {
    const tag = m[1].toLowerCase()
    if (!seenT.has(tag)) {
      seenT.add(tag)
      tags.push(['t', tag])
    }
  }

  return tags
}

// ─── Event validation ────────────────────────────────────────────────────────

/**
 * Validate that a JSON object is a valid kind 1 Nostr event structure.
 *
 * @param {any} json — parsed JSON
 * @returns {{ valid: boolean, errors: string[], event: object|null }}
 */
export function validateKind1Event(json) {
  const errors = []

  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { valid: false, errors: ['JSON must be an object'], event: null }
  }

  if (json.kind !== 1) {
    errors.push(`Expected kind 1, got kind ${json.kind ?? '(missing)'}`)
  }

  if (typeof json.content !== 'string') {
    errors.push('Missing or invalid "content" field (must be a string)')
  }

  if (!Array.isArray(json.tags)) {
    errors.push('Missing or invalid "tags" field (must be an array)')
  }

  if (typeof json.pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(json.pubkey)) {
    errors.push('Missing or invalid "pubkey" field (must be 64-char hex)')
  }

  if (typeof json.created_at !== 'number') {
    errors.push('Missing or invalid "created_at" field (must be a unix timestamp number)')
  }

  return {
    valid: errors.length === 0,
    errors,
    event: errors.length === 0 ? json : null,
  }
}

// ─── Tag merging ─────────────────────────────────────────────────────────────

/**
 * Merge auto-generated tags, zap splits, manual tags, and the client tag
 * into a final deduplicated tag array.
 *
 * Zap splits use percentages. Each entry has { pubkey, relay, pct }.
 * If userPct is a number, the user gets that explicit pct. If it's null/undefined,
 * the user catches the remainder (100 - sum of others).
 *
 * @param {object} params
 * @param {Array<string[]>} params.autoTags — from extractTags()
 * @param {Array<{pubkey: string, relay: string, pct: number}>} params.zapSplits — other recipients (not the user)
 * @param {string} [params.userPubkey] — logged-in user's pubkey
 * @param {number} [params.userPct] — explicit user pct; if omitted, defaults to remainder
 * @param {Array<string[]>} params.manualTags — non-auto tags preserved from upload
 * @returns {Array<string[]>}
 */
export function mergeTags({ autoTags = [], zapSplits = [], userPubkey, userPct, manualTags = [] }) {
  const tags = [...autoTags]

  // Only emit zap tags when the author actually configured a split —
  // either by adding other recipients or explicitly setting their own share.
  // Otherwise a plain note gets no zap tags and zaps default to the author as usual.
  const hasAnySplit = zapSplits.length > 0 || userPct != null

  if (hasAnySplit) {
    const otherTotal = zapSplits.reduce((sum, z) => sum + (z.pct || 0), 0)
    const effectiveUserPct = userPct == null
      ? Math.max(0, 100 - otherTotal)
      : Math.max(0, Math.min(100, userPct))

    if (userPubkey && effectiveUserPct > 0) {
      tags.push(['zap', userPubkey, '', String(effectiveUserPct)])
    }
    for (const zap of zapSplits) {
      if (zap.pct > 0) {
        tags.push(['zap', zap.pubkey, zap.relay || '', String(zap.pct)])
      }
    }
  }

  // Manual tags (preserved from original event) that aren't duplicated by auto-tags
  for (const tag of manualTags) {
    // Skip tags that auto-generation handles (p, t, e, a) and zap tags
    if (['p', 't', 'e', 'a', 'zap', 'client'].includes(tag[0])) continue
    tags.push(tag)
  }

  // Always add client tag
  tags.push(['client', CLIENT_TAG])

  return tags
}
