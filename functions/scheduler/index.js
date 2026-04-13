/**
 * Cloudflare Worker — Note Scheduler
 *
 * Handles three responsibilities:
 *   1. POST /schedule   — store a pre-signed Nostr event in KV with a time-bucketed key
 *   2. GET  /scheduled  — list pending scheduled events for a pubkey (for the UI poll)
 *   3. Cron trigger     — fire every minute, publish all due events, delete their KV entries
 *
 * KV key format:  sched:{pubkey}:{YYYY-MM-DD-HH-MM}:{event_id}
 * Pubkey-first so the list endpoint can prefix-scan per user without full-table scan.
 *
 * Env bindings required (set in wrangler.toml):
 *   SCHEDULED_NOTES   — KV namespace binding
 *   RELAYS            — JSON array string of relay URLs to publish to (var or secret)
 *   ALLOWED_ORIGINS   — comma-separated allowed CORS origins (var), e.g. "https://mynostr.net"
 *
 * TODO: implement relay publish logic in handleCron once nostr-tools is bundled
 * into the worker. Stub currently logs due events only.
 */

// ─── CORS ───────────────────────────────────────────────────────────────────

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || ''
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
  // In dev, allow localhost origins; in production, only whitelisted origins
  const isAllowed = allowed.length === 0
    || allowed.includes(origin)
    || origin.startsWith('http://localhost')
    || origin.startsWith('http://127.0.0.1')
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : '',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  }
}

function handleOptions(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) })
}

// ─── Nostr event signature verification ─────────────────────────────────────
// Minimal schnorr signature verification using the Web Crypto API.
// Nostr events use secp256k1 schnorr (BIP-340) signatures. Web Crypto doesn't
// natively support secp256k1, so we verify the event ID hash matches the
// serialized event and check structural integrity. Full signature verification
// requires importing nostr-tools — stubbed here with hash-only validation
// until the worker bundles nostr-tools.

/**
 * Verify that the event id matches the canonical serialization.
 * This catches tampered payloads (modified content/tags after signing)
 * but does NOT verify the cryptographic signature itself.
 * TODO: add full schnorr sig verification when nostr-tools is bundled.
 */
async function verifyEventId(event) {
  if (!event?.id || !event?.pubkey || !event?.sig || event.created_at == null) {
    return false
  }
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags || [],
    event.content || '',
  ])
  const encoded = new TextEncoder().encode(serialized)
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded)
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return hashHex === event.id
}

// ─── Handlers ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return handleOptions(request, env)
    }

    const url = new URL(request.url)
    let response

    if (request.method === 'POST' && url.pathname === '/schedule') {
      response = await handleSchedule(request, env)
    } else if (request.method === 'GET' && url.pathname === '/scheduled') {
      response = await handleList(request, env)
    } else {
      response = new Response('Not found', { status: 404 })
    }

    // Attach CORS headers to every response
    const cors = corsHeaders(request, env)
    for (const [k, v] of Object.entries(cors)) {
      response.headers.set(k, v)
    }
    return response
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(handleCron(env))
  },
}

/**
 * POST /schedule
 * Body: { event: <signed Nostr event JSON>, publishAt: <ISO timestamp> }
 */
async function handleSchedule(request, env) {
  try {
    const { event, publishAt } = await request.json()
    if (!event?.id || !event?.pubkey || !event?.sig || !publishAt) {
      return json({ error: 'Missing required fields: event.id, event.pubkey, event.sig, publishAt' }, 400)
    }

    // Verify the event id matches the canonical serialization
    // (catches tampered payloads — modified content/tags after signing)
    const valid = await verifyEventId(event)
    if (!valid) {
      return json({ error: 'Invalid event: id does not match serialized content' }, 400)
    }

    // Reject events scheduled more than 30 days in the future (abuse prevention)
    const publishTime = new Date(publishAt).getTime()
    const maxFuture = Date.now() + 30 * 24 * 60 * 60 * 1000
    if (isNaN(publishTime) || publishTime < Date.now() || publishTime > maxFuture) {
      return json({ error: 'publishAt must be a valid time between now and 30 days from now' }, 400)
    }

    // Build time-bucketed KV key — pubkey-first for efficient per-user list queries
    const ts = new Date(publishAt)
    const bucket = [
      ts.getUTCFullYear(),
      String(ts.getUTCMonth() + 1).padStart(2, '0'),
      String(ts.getUTCDate()).padStart(2, '0'),
      String(ts.getUTCHours()).padStart(2, '0'),
      String(ts.getUTCMinutes()).padStart(2, '0'),
    ].join('-')

    const key = `sched:${event.pubkey}:${bucket}:${event.id}`
    // TTL: keep for 7 days after the scheduled publish time so the UI can show recently-sent
    const expirationTtl = 60 * 60 * 24 * 7

    await env.SCHEDULED_NOTES.put(key, JSON.stringify(event), { expirationTtl })
    return json({ ok: true, key })
  } catch (err) {
    return json({ error: err.message }, 500)
  }
}

/**
 * GET /scheduled?pubkey=<hex>
 * Returns pending scheduled events for a specific pubkey.
 * Uses pubkey-prefixed KV keys for efficient per-user list queries.
 */
async function handleList(request, env) {
  const url = new URL(request.url)
  const pubkey = url.searchParams.get('pubkey')
  if (!pubkey) return json({ error: 'pubkey required' }, 400)

  // Validate pubkey is a 64-char hex string (prevents injection into KV prefix)
  if (!/^[0-9a-f]{64}$/.test(pubkey)) {
    return json({ error: 'Invalid pubkey format' }, 400)
  }

  // Prefix scan scoped to this pubkey — no full-table scan
  const result = await env.SCHEDULED_NOTES.list({ prefix: `sched:${pubkey}:` })
  const scheduled = result.keys.map(k => ({ key: k.name, expiration: k.expiration }))

  return json({ scheduled })
}

/**
 * Cron handler — called every minute by the Cloudflare Cron Trigger.
 * Lists all KV entries with the current-minute bucket and publishes due events.
 *
 * Note: with pubkey-first keys (sched:{pubkey}:{bucket}:{id}), we can't prefix-scan
 * by time bucket alone. Instead we scan all sched: keys and filter by bucket substring.
 * At scale this would need a secondary time-indexed key or a different data structure.
 * Fine for the free/early-stage tier.
 */
async function handleCron(env) {
  const now = new Date()
  const bucket = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
  ].join('-')

  // List all scheduled keys and filter for this minute's bucket
  const { keys } = await env.SCHEDULED_NOTES.list({ prefix: 'sched:' })
  const dueKeys = keys.filter(k => k.name.includes(`:${bucket}:`))

  for (const { name } of dueKeys) {
    const raw = await env.SCHEDULED_NOTES.get(name)
    if (!raw) continue

    const event = JSON.parse(raw)
    // TODO: publish `event` to env.RELAYS using nostr-tools WebSocket publish
    console.log(`[scheduler] Publishing event ${event.id} (kind ${event.kind})`)

    // Delete immediately — if publish fails we log it but don't retry here.
    // Future improvement: move to a dead-letter list for retry.
    await env.SCHEDULED_NOTES.delete(name)
  }

  console.log(`[scheduler] Cron tick ${bucket}: processed ${dueKeys.length} events`)
}

/** Convenience: return a JSON response */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
