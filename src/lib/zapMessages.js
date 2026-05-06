/**
 * zapMessages — fetch + parse zap-with-message receipts for a single
 * Nostr event. Powers the per-note "zap comments" disclosure under
 * each NoteCard.
 *
 * Source strategy is hybrid:
 *   1. Primal cache `event_zaps_by_satszapped` (single round-trip;
 *      returns receipts + sender profiles already sorted by amount)
 *   2. Fall back to a direct relay subscription on Primal error or
 *      empty result (so brand-new notes Primal hasn't indexed yet
 *      still surface their messages from the writer's outbox relays)
 *
 * Per-note results are cached in-memory with a 5-minute TTL so the
 * IntersectionObserver-driven count fetch and the user's click-to-
 * expand share the same data — clicking is instant.
 *
 * Sender profiles harvested from the Primal response are stashed in
 * a parallel cache and exposed via `getCachedSenderProfile()`, so the
 * UI doesn't need a second batch profile fetch on expand.
 */
import { fetchEventZapEvents } from './primal.js'
import { getNDK } from './ndk.js'
import { withTimeout } from './utils.js'

const CACHE_TTL_MS    = 5 * 60 * 1000
const CACHE_MAX       = 500
const FETCH_LIMIT     = 200
const RELAY_TIMEOUT_MS = 4000

// noteId → { messages, source, fetchedAt }
const messageCache = new Map()
// noteId → Promise (in-flight de-dup)
const inflight = new Map()
// senderPubkey → parsed kind 0 profile object
const senderProfileCache = new Map()

function cacheSet(map, key, value, max = CACHE_MAX) {
  if (map.size >= max) map.delete(map.keys().next().value)
  map.set(key, value)
}

export function getCachedSenderProfile(pubkey) {
  return senderProfileCache.get(pubkey) || null
}

// Allow external callers (refreshNoteData) to pre-populate the cache
// with raw zap events fetched directly from the user's read relays —
// bypasses both the Primal-first lookup and the 5-min TTL. The caller
// has just-fetched authoritative data; we parse + harvest profiles
// here so the next read returns instantly.
export function primeZapMessages(noteId, rawEvents) {
  if (!noteId) return
  harvestSenderProfiles(rawEvents)
  const messages = parseZapEvents(rawEvents)
  cacheSet(messageCache, noteId, { messages, source: 'refresh', fetchedAt: Date.now() })
  // Drop any in-flight Primal/relay fetch — the next consumer call will
  // see our primed entry and skip the network.
  inflight.delete(noteId)
}

/**
 * Get zap messages for a note. Returns a cached result when fresh,
 * otherwise fetches via Primal-then-relays. De-duplicates concurrent
 * calls for the same noteId.
 */
export async function fetchZapMessages(noteId) {
  if (!noteId || typeof noteId !== 'string') {
    return { messages: [], source: null }
  }

  const cached = messageCache.get(noteId)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached
  }

  const existing = inflight.get(noteId)
  if (existing) return existing

  const promise = (async () => {
    let result = null
    // Primal first
    try {
      const events = await fetchEventZapEvents(noteId, { limit: FETCH_LIMIT })
      harvestSenderProfiles(events)
      const messages = parseZapEvents(events)
      if (messages.length > 0) {
        result = { messages, source: 'primal' }
      }
      // Empty Primal result might just mean "not indexed yet" — try relays.
    } catch {
      // Network / timeout — try relays.
    }

    if (!result) {
      try {
        const events = await fetchFromRelays(noteId)
        result = { messages: parseZapEvents(events), source: 'relays' }
      } catch {
        result = { messages: [], source: null }
      }
    }

    const stored = { ...result, fetchedAt: Date.now() }
    cacheSet(messageCache, noteId, stored)
    return stored
  })()

  inflight.set(noteId, promise)
  promise.finally(() => inflight.delete(noteId))
  return promise
}

async function fetchFromRelays(noteId) {
  const ndk = getNDK()
  const set = await withTimeout(
    ndk.fetchEvents({ kinds: [9735], '#e': [noteId], limit: FETCH_LIMIT }, { closeOnEose: true }),
    RELAY_TIMEOUT_MS,
    '__zap_messages_relay_timeout__',
  )
  return Array.from(set || [])
}

/**
 * Parse a heterogeneous event list (Primal returns kind 9735 zap
 * receipts + kind 0 sender profiles + kind 10000129 synthetics; relays
 * return only kind 9735) into a clean message-only array sorted by
 * amount descending. Skips:
 *   - zaps with empty content (the user didn't leave a message)
 *   - zaps without a parseable amount tag
 *   - zaps without a valid sender pubkey
 *   - duplicate receipt ids (same receipt from multiple relays)
 */
function parseZapEvents(events) {
  const messages = []
  const seen = new Set()
  for (const ev of events || []) {
    if (ev?.kind !== 9735) continue
    if (!ev.id || seen.has(ev.id)) continue

    const desc = ev.tags?.find(t => t[0] === 'description')?.[1]
    if (!desc) continue

    let req
    try { req = JSON.parse(desc) } catch { continue }
    if (!req || req.kind !== 9734) continue

    const message = (req.content || '').trim()
    if (!message) continue

    const amountTag = req.tags?.find(t => t[0] === 'amount')?.[1]
    const amountMsats = amountTag ? parseInt(amountTag, 10) : 0
    if (!Number.isFinite(amountMsats) || amountMsats <= 0) continue

    if (!req.pubkey || !/^[0-9a-f]{64}$/i.test(req.pubkey)) continue

    seen.add(ev.id)
    messages.push({
      receiptId:    ev.id,
      senderPubkey: req.pubkey.toLowerCase(),
      amountSats:   Math.floor(amountMsats / 1000),
      message,
      createdAt:    ev.created_at || 0,
    })
  }
  messages.sort((a, b) => b.amountSats - a.amountSats)
  return messages
}

function harvestSenderProfiles(events) {
  for (const ev of events || []) {
    if (ev?.kind !== 0 || !ev.pubkey) continue
    try {
      const parsed = JSON.parse(ev.content || '{}')
      cacheSet(senderProfileCache, ev.pubkey.toLowerCase(), { ...parsed, pubkey: ev.pubkey })
    } catch {}
  }
}
