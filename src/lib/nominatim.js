/**
 * nominatim — debounced address search via OpenStreetMap's free
 * Nominatim service.
 *
 * No API key, no signup; the only obligations are usage policy
 * (≤1 req/sec, identify the app via User-Agent / Referer, cache
 * client-side) and respect for the 503 "back off" responses. We
 * cache by query in an LRU and rate-limit to one request per
 * `MIN_INTERVAL_MS`. Same approach Plektos uses.
 */
import { createLRU } from './utils.js'

const ENDPOINT = 'https://nominatim.openstreetmap.org/search'
const CACHE = createLRU(50)
const CACHE_TTL_MS = 30 * 60 * 1000   // 30m — plenty for one composer session
const MIN_INTERVAL_MS = 1100          // Nominatim asks for ≤1 req/sec
let _lastRequestAt = 0

/**
 * Search for places by query string. Returns `[]` when the query is
 * too short, the network fails, or Nominatim asks us to back off.
 * Each result: { displayName, lat, lon, type, importance }.
 *
 * Caller should debounce (e.g. 300ms) before invoking — this helper
 * intentionally does no debouncing of its own so it composes with
 * any framework's effect timing.
 */
export async function searchPlaces(query, { signal, limit = 8 } = {}) {
  const q = String(query || '').trim()
  if (q.length < 2) return []

  const cacheKey = `${q}|${limit}`
  const cached = CACHE.get(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.results

  // Soft rate limit. If a caller fires two searches within MIN_INTERVAL_MS,
  // delay the second one — saves 503s and keeps the project welcome on
  // Nominatim's free tier.
  const now = Date.now()
  const wait = Math.max(0, _lastRequestAt + MIN_INTERVAL_MS - now)
  if (wait > 0) await sleep(wait, signal)
  _lastRequestAt = Date.now()

  const url = `${ENDPOINT}?format=json&addressdetails=0&limit=${encodeURIComponent(limit)}&q=${encodeURIComponent(q)}`
  try {
    const res = await fetch(url, { signal, headers: { 'Accept': 'application/json' } })
    if (!res.ok) return []
    const json = await res.json()
    if (!Array.isArray(json)) return []
    const results = json.map(r => ({
      displayName: String(r.display_name || ''),
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      type: String(r.type || ''),
      importance: Number(r.importance || 0),
    })).filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon))
    CACHE.set(cacheKey, { fetchedAt: Date.now(), results })
    return results
  } catch {
    return []
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms)
    if (signal) signal.addEventListener('abort', () => { clearTimeout(id); reject(new DOMException('aborted', 'AbortError')) }, { once: true })
  })
}

// Geohash encoder (geohash.org base32) — used for the NIP-52 `g` tag.
// Same precision rule as Plektos: 9 chars ≈ ±2.4m. Plenty for venue
// pinning and small enough that humans can copy/paste it.
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'

export function encodeGeohash(lat, lon, precision = 9) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return ''
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180
  let bit = 0, ch = 0, evenBit = true
  let geohash = ''
  while (geohash.length < precision) {
    if (evenBit) {
      const mid = (lonMin + lonMax) / 2
      if (lon >= mid) { ch = (ch << 1) | 1; lonMin = mid }
      else            { ch = (ch << 1);     lonMax = mid }
    } else {
      const mid = (latMin + latMax) / 2
      if (lat >= mid) { ch = (ch << 1) | 1; latMin = mid }
      else            { ch = (ch << 1);     latMax = mid }
    }
    evenBit = !evenBit
    if (++bit === 5) {
      geohash += BASE32[ch]
      bit = 0; ch = 0
    }
  }
  return geohash
}
