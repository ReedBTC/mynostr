/**
 * relayInfo — NIP-11 relay info document fetcher and user-relay-list loader.
 *
 * Each Nostr relay serves a JSON document describing itself (name, software,
 * supported NIPs, limitations, contact) at its HTTPS origin when asked with
 * `Accept: application/nostr+json`. This is the cheapest, most authoritative
 * way to learn what a relay supports — no relay query needed, one GET per
 * relay, served by the relay itself. Results are LRU-cached with a 1-hour TTL
 * so tabbing away and back doesn't re-probe every relay.
 *
 * Failed fetches (CORS refusal, timeout, 404, parse error) cache a {_error}
 * sentinel briefly so we don't hammer a flaky relay in a tight render loop.
 */
import { CLIENT_TAG } from './brand.js'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNDK, connectAndWait, signWithTimeout, FALLBACK_RELAYS, publishToOwnOutbox } from './ndk.js'
import { createLRU, isSafeUrl } from './utils.js'

const NIP11_CACHE   = createLRU(100)
const NIP11_TTL_MS  = 60 * 60 * 1000
const FAIL_TTL_MS   =  5 * 60 * 1000 // re-try failures sooner than successes

// Optional CORS-proxy Worker URL. When set, we prefer it over direct fetches
// because most public relays don't send Access-Control-Allow-Origin, which
// means a browser-side direct fetch silently fails for ~30%+ of relays. The
// proxy fetches server-side, caches at the edge, and returns with our CORS.
// Fall through to the direct fetch if the proxy is unreachable or errors.
const PROXY_URL = (import.meta.env?.VITE_RELAY_INFO_PROXY || '').replace(/\/+$/, '')

export function normalizeRelayUrl(url) {
  try {
    const u = new URL(url)
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')
    return `${u.protocol}//${u.host}${path}`.toLowerCase()
  } catch {
    return (url || '').toLowerCase().replace(/\/+$/, '')
  }
}

function httpUrlForRelay(relayUrl) {
  if (relayUrl.startsWith('wss://')) return 'https://' + relayUrl.slice(6)
  if (relayUrl.startsWith('ws://'))  return 'http://'  + relayUrl.slice(5)
  return relayUrl
}

/**
 * Fetch a single relay's NIP-11 document. Never throws — returns either the
 * relay JSON (possibly partial) or `{ _error: '...' }` on failure. Callers
 * check for `_error` before using any field.
 */
export async function fetchNip11(relayUrl, { timeoutMs = 5000 } = {}) {
  const key = normalizeRelayUrl(relayUrl)
  if (!key) return { _error: 'invalid url' }
  const cached = NIP11_CACHE.get(key)
  if (cached) {
    const age = Date.now() - cached.fetchedAt
    const ttl = cached.data?._error ? FAIL_TTL_MS : NIP11_TTL_MS
    if (age < ttl) return cached.data
  }

  // Try proxy first when configured. Proxy responses for failed upstreams
  // still come back 200 with a {_error} body — treat those the same as a
  // direct-fetch error and fall through so we at least try direct as a
  // second chance (some relays serve CORS-friendly NIP-11 even if the proxy
  // upstream hiccuped).
  if (PROXY_URL) {
    const viaProxy = await fetchViaProxy(key, timeoutMs)
    if (viaProxy && !viaProxy._error) {
      NIP11_CACHE.set(key, { fetchedAt: Date.now(), data: viaProxy })
      return viaProxy
    }
  }

  const direct = await fetchDirect(key, timeoutMs)
  NIP11_CACHE.set(key, { fetchedAt: Date.now(), data: direct })
  return direct
}

async function fetchViaProxy(relayUrl, timeoutMs) {
  const url = `${PROXY_URL}/?relay=${encodeURIComponent(relayUrl)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      credentials: 'omit',
    })
    if (!res.ok) return null
    const data = await res.json()
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function fetchDirect(relayUrl, timeoutMs) {
  const httpUrl    = httpUrlForRelay(relayUrl)
  const controller = new AbortController()
  const timer      = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(httpUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/nostr+json' },
      signal: controller.signal,
      // Don't send credentials — NIP-11 is anonymous and we never want to
      // leak a cookie/auth header to a third-party relay.
      credentials: 'omit',
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!data || typeof data !== 'object') throw new Error('bad json')
    return data
  } catch (e) {
    return e.name === 'AbortError'
      ? { _error: 'timeout' }
      : { _error: e.message || 'fetch failed' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch the viewed user's relay list. Prefers NIP-65 (kind 10002) which is
 * what modern clients publish. Falls back to parsing legacy kind 3 contact
 * lists that still carry a JSON relay blob in `.content` — common for
 * long-time Nostr users who pre-date NIP-65 and never migrated.
 *
 * Returns `{ relays, source }` where relays is a normalized array
 * `[{ url, read, write }]` and source is one of:
 *   - 'nip65'  — user has a kind 10002 event (modern, preferred)
 *   - 'kind3'  — user only has legacy kind 3 relay blob, should upgrade
 *   - 'none'   — genuinely new account, no relay list at all
 *
 * Consumers use `source` to show an upgrade banner for kind 3 users and a
 * "create a list" prompt for none users.
 */
export async function fetchUserRelayList(pubkey) {
  if (!pubkey) return { relays: [], source: 'none' }
  const ndk = getNDK()
  try {
    await connectAndWait(ndk, 3000)

    // Race kind 10002 and kind 3 in parallel so legacy-only accounts don't
    // pay the full 10002 timeout before we try the fallback.
    const [list10002, list3] = await Promise.all([
      ndk.fetchEvent({ kinds: [10002], authors: [pubkey] }).catch(() => null),
      ndk.fetchEvent({ kinds: [3],     authors: [pubkey] }).catch(() => null),
    ])

    if (list10002) return { relays: parseKind10002(list10002), source: 'nip65' }
    if (list3)     return { relays: parseKind3Content(list3), source: 'kind3' }
    return { relays: [], source: 'none' }
  } catch {
    return { relays: [], source: 'none' }
  }
}

/**
 * Publish a NIP-65 kind 10002 relay list for the signed-in user.
 *
 * @param {object} params
 * @param {Array<{url:string, read:boolean, write:boolean}>} params.relays
 * @returns {Promise<{relays: string[]}>} relays that acknowledged the publish
 *
 * Behavior notes:
 *  - Tags follow NIP-65: `["r", url]` when both read+write, otherwise
 *    `["r", url, "read"]` or `["r", url, "write"]`. A relay with neither
 *    flag is skipped (would be dead weight in the list).
 *  - Publishes to the user's current write relays PLUS the fallback relays,
 *    so a user fixing a broken list doesn't rely on the broken list's
 *    writes to propagate the fix. Relays silently dedupe.
 *  - Replaceable event — the newest kind 10002 wins per author on each
 *    relay, so clients reading from the publish set will see the new list.
 */
export async function publishRelayList({ relays }) {
  const ndk = getNDK()
  if (!ndk?.signer) throw new Error('Not signed in')
  if (!Array.isArray(relays)) throw new Error('relays must be an array')

  const tags = []
  for (const r of relays) {
    const url = normalizeRelayUrl(r?.url)
    if (!url) continue
    if (r.read && r.write)       tags.push(['r', url])
    else if (r.write)            tags.push(['r', url, 'write'])
    else if (r.read)             tags.push(['r', url, 'read'])
    // neither flag → skip (user effectively removed the relay)
  }
  tags.push(['client', CLIENT_TAG])

  const event = new NDKEvent(ndk)
  event.kind = 10002
  event.content = ''
  event.created_at = Math.floor(Date.now() / 1000)
  event.tags = tags

  // Publish to the current write relays + fallbacks. We intentionally also
  // hit fallbacks so a user whose write relays are broken still propagates
  // the repair to third-party clients.
  await connectAndWait(ndk, 3000)
  await signWithTimeout(event)
  // Kind 10002 is the one deliberate full-pool publish in the app: if a user's
  // write relays are broken or stale, we still need the repaired list to
  // propagate through fallback relays so third-party clients can discover
  // their new outbox. Comment above already explains this.
  const publishedTo = await event.publish()
  const confirmed = Array.from(publishedTo).map(r => r.url).filter(Boolean)
  return { relays: confirmed.length ? confirmed : [...FALLBACK_RELAYS] }
}

/**
 * Curated NIP-17 DM relays surfaced when the user has no kind 10050 yet.
 * Same shape as marketplaceRelays.SUPPLEMENTAL_PUBLISH_RELAYS so the same
 * CopyButton + useRelayCopier({kind:'dm'}) machinery renders them inline.
 *
 * Selection criteria: relays known to accept NIP-17 gift-wrap (kind 1059)
 * either by virtue of being chat-focused or by accepting NIP-42 auth.
 * Mirrors the recommendations DmRelayCard already names in its help copy.
 */
export const RECOMMENDED_DM_RELAYS = Object.freeze([
  { url: 'wss://inbox.lol',        label: 'inbox.lol',        hint: 'NIP-17 gift-wrap accepting' },
  { url: 'wss://auth.nostr1.com',  label: 'auth.nostr1.com',  hint: 'NIP-42 auth, hides metadata from scrapers' },
  { url: 'wss://relay.0xchat.com', label: 'relay.0xchat.com', hint: 'Built for chat clients' },
])

/**
 * Fetch the user's NIP-17 DM relay list (kind 10050). This is a separate
 * event from the main relay list because DM relays have different criteria:
 * they need to accept encrypted gift-wrap events (kind 1059), not have
 * auth-required blocks, and ideally filter spam. Kind 10050 is just a flat
 * list of relay URLs — no read/write markers, since DM relays are inboxes.
 *
 * Returns `{ relays: string[], source: 'nip17' | 'none' }`.
 */
export async function fetchUserDmRelays(pubkey) {
  if (!pubkey) return { relays: [], source: 'none' }
  const ndk = getNDK()
  try {
    await connectAndWait(ndk, 3000)
    const ev = await ndk.fetchEvent({ kinds: [10050], authors: [pubkey] }).catch(() => null)
    if (!ev) return { relays: [], source: 'none' }
    const seen = new Set()
    const relays = []
    for (const tag of ev.tags || []) {
      if (tag[0] !== 'relay' || !tag[1]) continue
      const url = normalizeRelayUrl(tag[1])
      if (!url || seen.has(url)) continue
      seen.add(url)
      relays.push(url)
    }
    return { relays, source: 'nip17' }
  } catch {
    return { relays: [], source: 'none' }
  }
}

/**
 * Publish a NIP-17 kind 10050 DM relay list.
 *
 * @param {object} params
 * @param {string[]} params.relays — plain URL list (no read/write markers)
 * @returns {Promise<{relays: string[]}>}
 */
export async function publishDmRelayList({ relays }) {
  const ndk = getNDK()
  if (!ndk?.signer) throw new Error('Not signed in')
  if (!Array.isArray(relays)) throw new Error('relays must be an array')

  const seen = new Set()
  const tags = []
  for (const raw of relays) {
    const url = normalizeRelayUrl(raw)
    if (!url || seen.has(url)) continue
    seen.add(url)
    tags.push(['relay', url])
  }
  tags.push(['client', CLIENT_TAG])

  const event = new NDKEvent(ndk)
  event.kind = 10050
  event.content = ''
  event.created_at = Math.floor(Date.now() / 1000)
  event.tags = tags

  await connectAndWait(ndk, 3000)
  await signWithTimeout(event)
  // Kind 10050 is replaceable and the user will edit it — publish to their
  // own write relays so future edits reach every copy.
  const publishedTo = await publishToOwnOutbox(event)
  const confirmed = Array.from(publishedTo).map(r => r.url).filter(Boolean)
  return { relays: confirmed.length ? confirmed : [...FALLBACK_RELAYS] }
}

/**
 * Suggest DM relay candidates for a user who hasn't published kind 10050
 * yet. Prefers the user's own kind 10002 write relays (since those relays
 * already accept writes from strangers trying to reach them) filtered to
 * exclude auth-gated and write-restricted relays that wouldn't let DMs
 * through. Falls back to generic well-known relays if nothing qualifies.
 *
 * @param {Array<{url:string,write:boolean}>} writeList — user's kind 10002
 * @param {Object<string, object>} infoByUrl — NIP-11 info map keyed by url
 * @returns {string[]} up to 3 suggested URLs
 */
export function suggestDmRelays(writeList, infoByUrl) {
  const FALLBACK = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']
  const candidates = []
  for (const r of writeList || []) {
    if (!r?.write) continue
    const info = infoByUrl?.[r.url]
    const lim = info?.limitation || {}
    // Skip relays that would silently refuse incoming DMs — the sender
    // (some other user) won't be able to write a kind 1059 to them.
    if (lim.auth_required || lim.restricted_writes) continue
    // If NIP-11 fetch failed we don't know — include them optimistically;
    // a plain unreachable-looking relay that actually serves Nostr fine
    // is more common than a silently-broken one.
    candidates.push({
      url: r.url,
      paid: Boolean(info && (info.payments_url || lim.payment_required || (info.fees && Object.keys(info.fees).length))),
      maxLen: Number(lim.max_message_length) || 0,
    })
  }
  // Prefer paid (less DM spam) then generous max length.
  candidates.sort((a, b) => {
    if (a.paid !== b.paid) return a.paid ? -1 : 1
    return b.maxLen - a.maxLen
  })
  const picked = candidates.slice(0, 3).map(c => c.url)
  if (picked.length) return picked
  return FALLBACK.slice(0, 3)
}

/**
 * Whether a NIP-11 doc indicates a paid relay. Three signals, any one wins:
 *   - explicit payments_url
 *   - limitation.payment_required flag
 *   - non-empty fees object (admission/publication/subscription tiers)
 */
export function isPaidRelay(info) {
  if (!info || info._error) return false
  const lim = info.limitation || {}
  return Boolean(info.payments_url || lim.payment_required || (info.fees && Object.keys(info.fees).length))
}

/**
 * Best-effort user-facing URL for a paid relay — where the user can find
 * pricing, sign up, or check on a subscription. Paid relays are a real pain
 * point: most users hit them, can't tell what they're paying for, and bounce.
 *
 * Order of preference:
 *   1. payments_url     — NIP-11's explicit "where to pay" link
 *   2. posting_policy   — sometimes the only URL declared (terms/pricing page)
 *   3. relay HTTPS origin — most relays serve a landing page at their root
 *
 * Returns null only when nothing safe is available.
 */
export function paidRelayInfoUrl(info, relayUrl) {
  if (info && !info._error) {
    if (isSafeUrl(info.payments_url))   return info.payments_url
    if (isSafeUrl(info.posting_policy)) return info.posting_policy
  }
  try {
    const u = new URL(relayUrl)
    if (u.protocol === 'wss:') return `https://${u.host}/`
    if (u.protocol === 'ws:')  return `http://${u.host}/`
  } catch {}
  return null
}

// NIP-65: each "r" tag is ["r", "<wss url>"] or ["r", "<wss url>", "read"|"write"].
// No marker = both read and write.
function parseKind10002(ev) {
  const writes = new Set()
  const reads  = new Set()
  for (const tag of ev.tags || []) {
    if (tag[0] !== 'r' || !tag[1]) continue
    const url = normalizeRelayUrl(tag[1])
    if (!url) continue
    const marker = (tag[2] || '').toLowerCase()
    if (marker === 'read')       reads.add(url)
    else if (marker === 'write') writes.add(url)
    else { reads.add(url); writes.add(url) }
  }
  return mergeReadWrite(reads, writes)
}

// Legacy kind 3 relay blob: JSON object of { "<url>": { read: bool, write: bool } }.
// Anything unparseable → empty list (kind 3 content is free-form and sometimes empty).
function parseKind3Content(ev) {
  let obj
  try { obj = JSON.parse(ev.content || '{}') } catch { return [] }
  if (!obj || typeof obj !== 'object') return []
  const writes = new Set()
  const reads  = new Set()
  for (const [rawUrl, val] of Object.entries(obj)) {
    const url = normalizeRelayUrl(rawUrl)
    if (!url) continue
    // Default both true when the entry is a bare URL or missing flags.
    const r = val && typeof val === 'object' ? val.read  !== false : true
    const w = val && typeof val === 'object' ? val.write !== false : true
    if (r) reads.add(url)
    if (w) writes.add(url)
  }
  return mergeReadWrite(reads, writes)
}

function mergeReadWrite(reads, writes) {
  const all = new Set([...reads, ...writes])
  return [...all].map(url => ({
    url,
    read:  reads.has(url),
    write: writes.has(url),
  }))
}
