/**
 * Cloudflare Worker — NIP-11 Relay Info Proxy
 *
 * The browser can't reliably fetch NIP-11 documents directly: many relays
 * serve the JSON happily but don't send `Access-Control-Allow-Origin`, so the
 * browser drops the response. This worker fetches server-side (no CORS), caches
 * the result at the edge, and re-serves it to mynostr with our own CORS headers.
 *
 * Endpoint:
 *   GET /?relay=<wss://relay.example.com>
 *
 * Response (always 200 with CORS headers):
 *   {...NIP-11 JSON...}            on success
 *   { _error: "timeout|..." }      on any failure — matches the client's
 *                                   existing fetchNip11 error shape
 *
 * Edge caching via `caches.default`:
 *   - Successful responses: Cache-Control: public, max-age=3600 (1h)
 *   - Failure sentinels:    Cache-Control: public, max-age=300  (5m)
 * The client has its own in-memory LRU on top, so an edge hit is already cheap.
 *
 * Env bindings (wrangler.toml):
 *   ALLOWED_ORIGINS — comma-separated CORS allowlist (e.g. "https://mynostr.app")
 */

const FETCH_TIMEOUT_MS = 5000
const MAX_BODY_BYTES   = 64 * 1024   // NIP-11 docs are tiny — cap for safety
const SUCCESS_TTL_S    = 60 * 60
const FAILURE_TTL_S    = 5 * 60

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || ''
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
  const isAllowed = allowed.length === 0
    || allowed.includes(origin)
    || origin.startsWith('http://localhost')
    || origin.startsWith('http://127.0.0.1')
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : '',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  }
}

function json(body, { status = 200, ttl = SUCCESS_TTL_S, cors }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${ttl}`,
      ...cors,
    },
  })
}

function normalizeRelay(raw) {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')
    return `${u.protocol}//${u.host}${path}`.toLowerCase()
  } catch {
    return null
  }
}

function httpForRelay(wssUrl) {
  if (wssUrl.startsWith('wss://')) return 'https://' + wssUrl.slice(6)
  if (wssUrl.startsWith('ws://'))  return 'http://'  + wssUrl.slice(5)
  return wssUrl
}

async function readCapped(response, max) {
  // Stream-read so we reject oversized bodies without buffering them whole.
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      try { await reader.cancel() } catch {}
      throw new Error('too large')
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { buf.set(c, offset); offset += c.byteLength }
  return new TextDecoder('utf-8').decode(buf)
}

async function fetchNip11Upstream(relayUrl) {
  const httpUrl = httpForRelay(relayUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(httpUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/nostr+json' },
      signal: controller.signal,
      redirect: 'follow',
      cf: { cacheTtl: 0, cacheEverything: false },
    })
    if (!res.ok) return { _error: `HTTP ${res.status}` }
    const ct = (res.headers.get('Content-Type') || '').toLowerCase()
    // Some relays misreport as text/plain — accept anything JSON-ish.
    if (!ct.includes('json') && !ct.includes('text')) {
      return { _error: `bad content-type: ${ct || 'missing'}` }
    }
    const body = await readCapped(res, MAX_BODY_BYTES)
    let data
    try { data = JSON.parse(body) } catch { return { _error: 'bad json' } }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { _error: 'bad json shape' }
    }
    return data
  } catch (e) {
    if (e.name === 'AbortError') return { _error: 'timeout' }
    return { _error: e.message || 'fetch failed' }
  } finally {
    clearTimeout(timer)
  }
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }
    if (request.method !== 'GET') {
      return json({ _error: 'method not allowed' }, { status: 405, ttl: 0, cors })
    }

    const url = new URL(request.url)
    const rawRelay = url.searchParams.get('relay') || ''
    const relay = normalizeRelay(rawRelay)
    if (!relay) {
      return json({ _error: 'invalid relay url' }, { status: 400, ttl: 0, cors })
    }

    // Use Cloudflare's edge cache keyed by normalized relay URL. Keeping the
    // cache key on our own domain (not the upstream https://) lets us serve
    // identical payloads no matter which allowed Origin made the request.
    const cacheKey = new Request(`https://relay-info.cache/?relay=${encodeURIComponent(relay)}`, {
      method: 'GET',
    })
    const cache = caches.default
    const cached = await cache.match(cacheKey)
    if (cached) {
      // Re-serve with per-request CORS headers (cached response has its own).
      const body = await cached.text()
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': cached.headers.get('Cache-Control') || `public, max-age=${SUCCESS_TTL_S}`,
          'X-Cache': 'HIT',
          ...cors,
        },
      })
    }

    const data = await fetchNip11Upstream(relay)
    const ttl = data?._error ? FAILURE_TTL_S : SUCCESS_TTL_S
    const payload = JSON.stringify(data)

    // Store in edge cache (no CORS headers so cache is origin-independent).
    const toCache = new Response(payload, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${ttl}`,
      },
    })
    ctx.waitUntil(cache.put(cacheKey, toCache.clone()))

    return new Response(payload, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${ttl}`,
        'X-Cache': 'MISS',
        ...cors,
      },
    })
  },
}
