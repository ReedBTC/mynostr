/**
 * Primal Caching Service — WebSocket API
 *
 * Primal runs a persistent, pre-indexed Nostr cache at wss://cache1.primal.net/v1.
 * Protocol: standard Nostr REQ/EVENT/EOSE messages, but filters use a "cache" key
 * with an operation name instead of standard NIP-01 filter fields.
 *
 * Format: ["REQ", subId, {"cache": [operationName, params]}]
 *
 * We maintain a singleton WebSocket across the session so the first keystroke on
 * any search reuses an already-open connection — this is the main reason Primal
 * search feels instantaneous compared to other clients.
 *
 * All public functions return clean data objects, not raw Nostr events.
 */

const PRIMAL_WS_URL = 'wss://cache1.primal.net/v1'

// Singleton WS state
let ws = null
let connPromise = null
let subIdCounter = 0

// Pending subscriptions: subId → { chunks, resolve, reject, timer }
const subs = new Map()

// In-flight request dedup. Primal's server dedupes concurrent identical
// REQs from the same socket — only the first gets real events; parallel
// duplicates get an immediate empty EOSE. Under React StrictMode or HMR
// this shows up as "first load has data, second load overwrites with 0."
// We dedup at the client by keying active queries on op+params and
// returning the same promise to every caller until it settles.
const inflight = new Map() // key → Promise<events[]>

// ─── Connection management ────────────────────────────────────────────────────

function ensureConnected() {
  if (ws?.readyState === WebSocket.OPEN) return Promise.resolve()
  if (connPromise) return connPromise

  connPromise = new Promise((resolve, reject) => {
    const socket = new WebSocket(PRIMAL_WS_URL)

    socket.onopen = () => {
      ws = socket
      connPromise = null
      resolve()
    }

    socket.onerror = () => {
      connPromise = null
      ws = null
      reject(new Error('Primal WebSocket failed to connect'))
    }

    socket.onclose = () => {
      ws = null
      connPromise = null
      // Reject any pending subscriptions — callers can retry
      for (const [id, sub] of subs) {
        clearTimeout(sub.timer)
        sub.reject(new Error('Primal WebSocket closed unexpectedly'))
        subs.delete(id)
      }
    }

    socket.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      const [type, subId, payload] = msg
      const sub = subs.get(subId)
      if (!sub) return

      if (type === 'EVENT') {
        sub.chunks.push(payload)
      } else if (type === 'EOSE') {
        clearTimeout(sub.timer)
        subs.delete(subId)
        ws?.send(JSON.stringify(['CLOSE', subId]))
        sub.resolve(sub.chunks)
      }
    }
  })

  return connPromise
}

// JSON.stringify with sorted keys so two calls with the same params in a
// different key order still collide in the inflight dedupe map.
function stableStringify(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return JSON.stringify(v)
  const keys = Object.keys(v).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}'
}

/** Send one cache query, collect all EVENT responses until EOSE. */
async function query(op, params, timeoutMs = 8000) {
  // Dedup concurrent identical requests. Key order is normalized by
  // stableStringify so a caller refactor that flips field order can't
  // silently bypass the dedupe.
  const key = `${op}:${stableStringify(params)}`
  const existing = inflight.get(key)
  if (existing) return existing

  const promise = (async () => {
    await ensureConnected()
    const subId = `mn_${++subIdCounter}_${Date.now()}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        subs.delete(subId)
        reject(new Error(`Primal "${op}" timed out`))
      }, timeoutMs)
      subs.set(subId, { chunks: [], resolve, reject, timer })
      ws.send(JSON.stringify(['REQ', subId, { cache: [op, params] }]))
    })
  })()

  inflight.set(key, promise)
  promise.finally(() => inflight.delete(key))
  return promise
}

// ─── Data helpers ─────────────────────────────────────────────────────────────

/** Pull a tag value from a Nostr event's tags array. */
function getTag(event, name) {
  return event.tags?.find(t => t[0] === name)?.[1] || ''
}

/** Parse kind 0 profile content safely. */
function parseProfile(event) {
  try {
    const p = JSON.parse(event.content)
    return { ...p, pubkey: event.pubkey }
  } catch {
    return { pubkey: event.pubkey }
  }
}

/** Split a mixed event array into articles, profiles, and Primal stats. */
function splitEvents(events) {
  const articles  = []
  const profiles  = new Map() // pubkey → parsed profile object
  const statsMap  = new Map() // pubkey → { followers_count, ... }

  for (const ev of events) {
    if (ev.kind === 30023) {
      articles.push(ev)
    } else if (ev.kind === 0) {
      profiles.set(ev.pubkey, parseProfile(ev))
    } else if (ev.kind === 10000133) {
      // Primal follower-counts event — two possible formats:
      //   1. Dict: content = {"pubkeyHex": count, ...} (from user_infos)
      //   2. Per-user: content = {"followers_count": N} with ["p", pubkey] tag
      try {
        const data = JSON.parse(ev.content)
        const pubkey = ev.tags?.find(t => t[0] === 'p')?.[1]
        if (pubkey) {
          statsMap.set(pubkey, data)
        } else {
          // Dict format — convert each entry to {followers_count: N}
          for (const [pk, val] of Object.entries(data)) {
            statsMap.set(pk, typeof val === 'number' ? { followers_count: val } : val)
          }
        }
      } catch {}
    }
  }

  articles.sort((a, b) => b.created_at - a.created_at)
  return { articles, profiles, statsMap }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Search Nostr users by display name / username.
 * Results are ranked by follower count (Primal's social graph ranking).
 *
 * @returns {Array<{ pubkey, name, picture, followersCount }>}
 */
/**
 * Search Nostr users by display name / username.
 * Uses user_infos to get both profiles and follower counts in one call.
 *
 * @returns {Array<{ pubkey, name, picture, followersCount }>}
 */
export async function searchUsers(queryStr, limit = 10) {
  if (!queryStr?.trim()) return []

  // First get matching pubkeys via user_search
  const searchEvents = await query('user_search', { query: queryStr.trim(), limit })
  const pubkeys = []
  for (const ev of searchEvents) {
    if (ev.kind === 0 && !pubkeys.includes(ev.pubkey)) pubkeys.push(ev.pubkey)
  }
  if (pubkeys.length === 0) return []

  // Then fetch full profiles + follower counts via user_infos
  let allEvents = searchEvents
  try {
    const infoEvents = await query('user_infos', { pubkeys }, 4000)
    allEvents = [...searchEvents, ...infoEvents]
  } catch { /* use search events only */ }

  const { statsMap } = splitEvents(allEvents)

  const userProfiles = new Map()
  for (const ev of allEvents) {
    if (ev.kind === 0) userProfiles.set(ev.pubkey, parseProfile(ev))
  }

  // Preserve the original search order
  return pubkeys
    .filter(pk => userProfiles.has(pk))
    .map(pk => {
      const p = userProfiles.get(pk)
      return {
        pubkey:         p.pubkey,
        name:           p.display_name || p.name || '',
        picture:        p.picture || '',
        followersCount: statsMap.get(p.pubkey)?.followers_count ?? null,
      }
    })
}

/**
 * Fetch the global long-form (kind 30023) discovery feed from Primal.
 * Used when no user is logged in, or as fallback.
 */
export async function fetchLongReadsFeed(until = null, limit = 25) {
  const params = { limit }
  if (until) params.until = until
  try {
    const events = await query('long_reads', params)
    const { articles, profiles } = splitEvents(events)
    return { articles, profiles }
  } catch {
    return { articles: [], profiles: new Map() }
  }
}

/**
 * Fetch a personalized long-form feed for a logged-in user.
 * Uses Primal's long_form_content_feed op with user_pubkey for social-graph
 * ranking / follows-scoped content. Falls back to global if empty.
 */
export async function fetchFollowingLongformFeed(pubkey, until = null, limit = 25) {
  const params = { user_pubkey: pubkey, limit }
  if (until) params.until = until
  try {
    const events = await query('long_form_content_feed', params)
    const { articles, profiles } = splitEvents(events)
    return { articles, profiles }
  } catch {
    return { articles: [], profiles: new Map() }
  }
}

/**
 * Fetch long-form articles by a specific author via Primal's index.
 * Primal's long_form_content_feed op defaults to a social-graph feed when
 * given only `pubkey`; `notes: 'authored'` makes it return articles *by*
 * that pubkey, which is what we actually want here.
 */
export async function fetchAuthorLongformFeed(pubkey, until = null, limit = 100) {
  const params = { pubkey, notes: 'authored', limit }
  if (until) params.until = until
  try {
    const events = await query('long_form_content_feed', params)
    const { articles, profiles } = splitEvents(events)
    return { articles, profiles }
  } catch {
    return { articles: [], profiles: new Map() }
  }
}

/**
 * Fetch long-form articles filtered by a topic/category.
 * Used for the Recipes feed (topic = 'food' or 'cooking').
 * Returns the raw result — callers should filter client-side by tag.
 */
export async function fetchTopicLongformFeed(topic, until = null, limit = 100) {
  const params = { topic, limit }
  if (until) params.until = until
  try {
    const events = await query('long_form_content_feed', params)
    const { articles, profiles } = splitEvents(events)
    return { articles, profiles }
  } catch {
    return { articles: [], profiles: new Map() }
  }
}

/**
 * Search kind 30023 articles by title / content query.
 *
 * @returns {{ articles: NostrEvent[], profiles: Map<pubkey, profile> }}
 */
export async function searchArticles(queryStr, until = null, limit = 25) {
  if (!queryStr?.trim()) return { articles: [], profiles: new Map() }

  const params = { query: queryStr.trim(), limit }
  if (until) params.until = until

  try {
    const events = await query('search', params)
    // search returns mixed kinds — filter to 30023 only
    const filtered = events.filter(e => e.kind === 30023 || e.kind === 0)
    const { articles, profiles } = splitEvents(filtered)
    return { articles, profiles }
  } catch {
    return { articles: [], profiles: new Map() }
  }
}

// ─── Kind 1 (short notes) helpers ─────────────────────────────────────────────

/**
 * Split a mixed-kind event payload into notes, profiles, and Primal stats.
 * Mirrors splitEvents() but keeps kind 1 instead of 30023.
 */
function splitNoteEvents(events) {
  const notes    = []
  const profiles = new Map()
  const statsMap = new Map()

  for (const ev of events) {
    if (ev.kind === 1) {
      notes.push(ev)
    } else if (ev.kind === 0) {
      profiles.set(ev.pubkey, parseProfile(ev))
    } else if (ev.kind === 10000133) {
      try {
        const data = JSON.parse(ev.content)
        const pubkey = ev.tags?.find(t => t[0] === 'p')?.[1]
        if (pubkey) {
          statsMap.set(pubkey, data)
        } else {
          for (const [pk, val] of Object.entries(data)) {
            statsMap.set(pk, typeof val === 'number' ? { followers_count: val } : val)
          }
        }
      } catch {}
    }
  }

  notes.sort((a, b) => b.created_at - a.created_at)
  return { notes, profiles, statsMap }
}

/**
 * Fetch short notes (kind 1) authored by a specific pubkey.
 * Uses Primal's `feed` op with `notes: 'authored'` for a pre-indexed,
 * chronologically-sorted page. `until` is a unix seconds cursor — pass the
 * oldest note's created_at to page backward.
 */
export async function fetchAuthorNotes(pubkey, until = null, limit = 25) {
  if (!pubkey) return { notes: [], profiles: new Map() }
  const params = { pubkey, notes: 'authored', limit }
  if (until) params.until = until
  try {
    const events = await query('feed', params)
    const { notes, profiles } = splitNoteEvents(events)
    return { notes, profiles }
  } catch {
    return { notes: [], profiles: new Map() }
  }
}

/**
 * Fetch short notes (kind 1) authored by a specific pubkey that are *replies*
 * (NIP-10 reply tag), pre-filtered by Primal. Same shape as fetchAuthorNotes.
 */
export async function fetchAuthorReplies(pubkey, until = null, limit = 25) {
  if (!pubkey) return { notes: [], profiles: new Map() }
  const params = { pubkey, notes: 'replies', limit }
  if (until) params.until = until
  try {
    const events = await query('feed', params)
    const { notes, profiles } = splitNoteEvents(events)
    return { notes, profiles }
  } catch {
    return { notes: [], profiles: new Map() }
  }
}

/**
 * Fetch a full thread — the root note plus every descendant reply Primal
 * has indexed — starting from any note in the thread. Uses Primal's
 * `thread_view` op; a single call returns the event, its ancestors, and
 * all descendants.
 *
 * Returns { notes: Array<kind1>, profiles: Map<pubkey, profile> }.
 * Callers walk the reply chain themselves using parseReplyRefs().
 */
export async function fetchThread(eventId) {
  if (!eventId) return { notes: [], profiles: new Map() }
  try {
    const events = await query('thread_view', { event_id: eventId, limit: 400 })
    const { notes, profiles } = splitNoteEvents(events)
    return { notes, profiles }
  } catch {
    return { notes: [], profiles: new Map() }
  }
}

/**
 * Batch-fetch a set of events by id (Primal's `events` op). Used by the
 * Bookmarks tab to hydrate the e-tag list from a kind 10003 bookmark event.
 * Primal returns whatever it has cached — callers should be prepared for
 * fewer events than requested.
 */
export async function fetchNotesByIds(ids) {
  if (!ids?.length) return { notes: [], profiles: new Map() }
  const unique = [...new Set(ids)]
  try {
    const events = await query('events', { event_ids: unique }, 8000)
    const { notes, profiles } = splitNoteEvents(events)
    return { notes, profiles }
  } catch {
    return { notes: [], profiles: new Map() }
  }
}

/**
 * Fetch profiles for a list of pubkeys (hex).
 * Returns a Map<pubkey, { pubkey, name, display_name, picture, ... }>.
 */
export async function fetchProfiles(pubkeys) {
  if (!pubkeys?.length) return new Map()
  const unique = [...new Set(pubkeys)]
  try {
    const events = await query('user_infos', { pubkeys: unique }, 5000)
    const profiles = new Map()
    for (const ev of events) {
      if (ev.kind === 0) profiles.set(ev.pubkey, parseProfile(ev))
    }
    return profiles
  } catch {
    return new Map()
  }
}

/**
 * Aggregate stats for a single user from Primal's cache.
 *
 * Primal exposes a synthetic kind 10000133 event that carries counts Primal
 * has pre-aggregated: note_count, reply_count, followers_count, follows_count,
 * long_form_note_count, time_joined, media_count, total_satszapped, …
 *
 * Two response shapes exist in the wild:
 *   1. Flat:  content = { note_count, reply_count, … }           ←  user_profile
 *   2. Dict:  content = { "<pubkeyHex>": { …flatStats } }        ←  user_infos
 *   3. Dict:  content = { "<pubkeyHex>": <followers_count> }     ←  user_infos (short)
 *
 * We prefer the per-user `user_profile` op but fall back to `user_infos` if
 * that comes back empty, and we accept any of the three shapes. Returns null
 * only when Primal has nothing indexed for this pubkey.
 *
 * Not using NIP-45 COUNT — Primal's cache returns everything in one round
 * trip, whereas NIP-45 would need a separate REQ per metric against a relay
 * that supports it.
 */
// Primal's synthetic event kinds, verified against the primal-web-app source:
//   10000105 "UserStats"           — the full stats object (note_count,
//                                    reply_count, follows_count, followers_count,
//                                    long_form_note_count, media_count,
//                                    total_satszapped, time_joined, …).
//                                    Returned by the `user_profile` op.
//   10000133 "UserFollowerCounts"  — follower count only. Returned as a
//                                    dict { pubkey: count } from `user_infos`,
//                                    or a bare object from `user_profile`.
// A previous iteration of this code parsed only 10000133 and treated it as
// the full stats object, which is why everything except followers rendered
// "—" — 10000133 never carries the other fields.
const KIND_USER_STATS           = 10000105
const KIND_USER_FOLLOWER_COUNTS = 10000133

/**
 * Aggregate stats for a single user from Primal's cache.
 *
 * Calls `user_profile` (preferred — returns the full UserStats event) and
 * falls back to `user_infos` for just the follower count when user_profile
 * didn't include one. Merges across both kinds so a partial response from
 * either op still contributes what it has.
 *
 * Fields on a full response (kind 10000105 content):
 *   note_count, reply_count, follows_count, followers_count,
 *   long_form_note_count, media_count, total_satszapped, time_joined, …
 *
 * Returns null only when Primal has nothing indexed for this pubkey.
 */
export async function fetchUserStats(pubkey) {
  if (!pubkey) return null

  const merged = {}

  const absorb = (events) => {
    for (const ev of events) {
      let data
      try { data = JSON.parse(ev.content) } catch { continue }
      if (!data || typeof data !== 'object') continue

      if (ev.kind === KIND_USER_STATS) {
        // Full per-user stats — spread over merged.
        Object.assign(merged, data)
        continue
      }

      if (ev.kind === KIND_USER_FOLLOWER_COUNTS) {
        // Two shapes: flat { followers_count } or dict { pubkey: count }.
        if (typeof data.followers_count === 'number') {
          if (merged.followers_count == null) merged.followers_count = data.followers_count
        } else if (typeof data[pubkey] === 'number') {
          if (merged.followers_count == null) merged.followers_count = data[pubkey]
        } else if (data[pubkey] && typeof data[pubkey] === 'object') {
          // Defensive — dict of full stats objects. Rare.
          for (const [k, v] of Object.entries(data[pubkey])) {
            if (merged[k] == null) merged[k] = v
          }
        }
      }
    }
  }

  try { absorb(await query('user_profile', { pubkey }, 6000)) } catch {}
  if (merged.followers_count == null) {
    try { absorb(await query('user_infos', { pubkeys: [pubkey] }, 6000)) } catch {}
  }

  return Object.keys(merged).length > 0 ? merged : null
}

// Primal's synthetic "ZAP_EVENT" kind. Emitted alongside real zap receipts
// with amount_sats pre-extracted — we don't need to decode bolt11 ourselves.
const KIND_ZAP_EVENT = 10000129

/**
 * Aggregate received-zap totals for a user. Uses `user_zaps_by_satszapped`
 * which orders by amount desc, so even when we cap the sample the biggest
 * zaps are always included — totals stay close to exact because zap
 * amounts are long-tail distributed.
 *
 * Returns:
 *   {
 *     satsReceived:    sum of amount_sats across received sample
 *     receivedSample:  count of ZAP_EVENT rows actually parsed
 *     receivedLimited: true when we hit `limit` and more may exist
 *   }
 *
 * Sent-side totals come from UserStats (total_satszapped), so we don't
 * fetch them here. Top-N zapper/recipient lists are also out of scope —
 * bring them back when there's a UI consuming them.
 */
export async function fetchUserZapAggregates(pubkey, { limit = 1000 } = {}) {
  if (!pubkey) return null

  const events = await query('user_zaps_by_satszapped', { receiver: pubkey, limit }, 8000).catch(() => [])

  let total = 0
  let sample = 0
  for (const ev of events) {
    if (ev.kind !== KIND_ZAP_EVENT) continue
    let data
    try { data = JSON.parse(ev.content) } catch { continue }
    const amount = Number(data?.amount_sats) || 0
    if (amount <= 0) continue
    total += amount
    sample += 1
  }

  return {
    satsReceived:    total,
    receivedSample:  sample,
    receivedLimited: sample >= limit,
  }
}

/**
 * Posting cadence — counts of an author's kind 1 events (notes + replies)
 * bucketed by local date over a fixed time window (default 52 weeks).
 *
 * We include replies so a reply-heavy user still gets a representative
 * chart. Pagination walks backward via `until` and stops as soon as a page
 * crosses the cutoff, so sparse posters don't over-fetch. Heavy posters
 * (more than ~1600 events/year) may hit the page cap before reaching the
 * cutoff — `capped` flags that case so the UI can show "(indexed)".
 *
 * Returns:
 *   {
 *     buckets:   Map<"YYYY-MM-DD", count>   (daily, within window only)
 *     total, oldestTs, newestTs,
 *     windowWeeks, windowSinceTs,           // the fixed window we queried
 *     capped,                               // true if we ran out of pages first
 *   }
 */
export async function fetchAuthorPostingCadence(pubkey, { weeks = 52, maxPages = 8, pageLimit = 100 } = {}) {
  if (!pubkey) return null
  const now    = Math.floor(Date.now() / 1000)
  const cutoff = now - weeks * 7 * 86400

  async function paginate(mode) {
    const events = []
    let until = null
    let pages = 0
    let exhausted = false

    for (let page = 0; page < maxPages; page++) {
      const params = { pubkey, notes: mode, limit: pageLimit }
      if (until) params.until = until

      let batch = []
      try { batch = await query('feed', params, 6000) } catch { break }
      const kind1s = batch.filter(e => e.kind === 1)
      if (kind1s.length === 0) { exhausted = true; break }
      pages++

      let oldestInPage = until || now
      for (const ev of kind1s) {
        if (ev.created_at < oldestInPage) oldestInPage = ev.created_at
        if (ev.created_at >= cutoff) events.push(ev)
      }

      if (oldestInPage < cutoff) { exhausted = true; break }
      if (kind1s.length < pageLimit) { exhausted = true; break }
      until = oldestInPage - 1
    }

    return { events, pages, exhausted }
  }

  const [authored, replies] = await Promise.all([
    paginate('authored'),
    paginate('replies'),
  ])

  const seen     = new Set()
  const buckets  = new Map()
  let total      = 0
  let oldestTs   = null
  let newestTs   = null

  for (const ev of [...authored.events, ...replies.events]) {
    if (seen.has(ev.id)) continue
    seen.add(ev.id)
    if (oldestTs == null || ev.created_at < oldestTs) oldestTs = ev.created_at
    if (newestTs == null || ev.created_at > newestTs) newestTs = ev.created_at
    const d = new Date(ev.created_at * 1000)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    buckets.set(key, (buckets.get(key) || 0) + 1)
    total++
  }

  const capped = (!authored.exhausted && authored.pages >= maxPages) ||
                 (!replies.exhausted  && replies.pages  >= maxPages)

  const result = {
    buckets, total, oldestTs, newestTs,
    windowWeeks:   weeks,
    windowSinceTs: cutoff,
    capped,
  }

  // Dev-only probe so the console has a cheap way to inspect what came back.
  // Guarded so production builds don't expose the viewed pubkey on window.
  if (import.meta.env?.DEV && typeof window !== 'undefined') {
    window.__lastCadence = {
      pubkey,
      total,
      windowWeeks: weeks,
      authoredPages: authored.pages,
      authoredEvents: authored.events.length,
      repliesPages: replies.pages,
      repliesEvents: replies.events.length,
      oldestTs,
      newestTs,
      bucketsSize: buckets.size,
      capped,
    }
  }

  return result
}

/** Gracefully close the singleton WebSocket (e.g. on logout). */
export function closePrimalSocket() {
  try { ws?.close() } catch {}
  ws = null
}
