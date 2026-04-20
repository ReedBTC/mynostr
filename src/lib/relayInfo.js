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
import { getNDK, connectAndWait } from './ndk.js'
import { createLRU } from './utils.js'

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
 * Returns a normalized array `[{ url, read, write }]`. A relay listed only
 * as a read-marker has `read=true/write=false` and vice versa; a relay with
 * no marker is treated as both (the NIP-65 default).
 *
 * Returns `[]` only if both sources are missing — genuinely new accounts
 * that have never published either event.
 */
export async function fetchUserRelayList(pubkey) {
  if (!pubkey) return []
  const ndk = getNDK()
  try {
    await connectAndWait(ndk, 3000)

    // Race kind 10002 and kind 3 in parallel so legacy-only accounts don't
    // pay the full 10002 timeout before we try the fallback.
    const [list10002, list3] = await Promise.all([
      ndk.fetchEvent({ kinds: [10002], authors: [pubkey] }).catch(() => null),
      ndk.fetchEvent({ kinds: [3],     authors: [pubkey] }).catch(() => null),
    ])

    if (list10002) return parseKind10002(list10002)
    if (list3)     return parseKind3Content(list3)
    return []
  } catch {
    return []
  }
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
