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

/** Send one cache query, collect all EVENT responses until EOSE. */
async function query(op, params, timeoutMs = 8000) {
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
 * Replaces the old NDK contact-list + relay fetch path.
 */
export async function fetchAuthorLongformFeed(pubkey, until = null, limit = 50) {
  const params = { pubkey, limit }
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

/** Gracefully close the singleton WebSocket (e.g. on logout). */
export function closePrimalSocket() {
  try { ws?.close() } catch {}
  ws = null
}
