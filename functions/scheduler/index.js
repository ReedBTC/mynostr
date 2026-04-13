/**
 * Cloudflare Worker — Note Scheduler
 *
 * Handles two responsibilities:
 *   1. POST /schedule   — store a pre-signed Nostr event in KV with a time-bucketed key
 *   2. GET  /scheduled  — list pending scheduled events for a pubkey (for the UI poll)
 *   3. Cron trigger     — fire every minute, publish all due events, delete their KV entries
 *
 * KV key format:  sched:{YYYY-MM-DD-HH-MM}:{pubkey}:{event_id}
 * This structure lets the cron handler list only the current-minute bucket
 * with a KV prefix scan — no full-table scan, minimal read cost.
 *
 * Env bindings required (set in wrangler.toml):
 *   SCHEDULED_NOTES  — KV namespace binding
 *   RELAYS           — JSON array string of relay URLs to publish to (var or secret)
 *
 * TODO: implement relay publish logic in handleCron once NDK or nostr-tools
 * is bundled into the worker. Stub currently logs due events only.
 */

export default {
  /** Handle HTTP requests (store/list scheduled notes) */
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/schedule') {
      return handleSchedule(request, env)
    }
    if (request.method === 'GET' && url.pathname === '/scheduled') {
      return handleList(request, env)
    }

    return new Response('Not found', { status: 404 })
  },

  /** Cron trigger — fires every minute via wrangler.toml [triggers] */
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
    if (!event?.id || !event?.pubkey || !publishAt) {
      return json({ error: 'Missing required fields: event.id, event.pubkey, publishAt' }, 400)
    }

    // Build time-bucketed KV key rounded to the nearest minute
    const ts = new Date(publishAt)
    const bucket = [
      ts.getUTCFullYear(),
      String(ts.getUTCMonth() + 1).padStart(2, '0'),
      String(ts.getUTCDate()).padStart(2, '0'),
      String(ts.getUTCHours()).padStart(2, '0'),
      String(ts.getUTCMinutes()).padStart(2, '0'),
    ].join('-')

    const key = `sched:${bucket}:${event.pubkey}:${event.id}`
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
 * Returns all pending scheduled events for a pubkey.
 */
async function handleList(request, env) {
  const url = new URL(request.url)
  const pubkey = url.searchParams.get('pubkey')
  if (!pubkey) return json({ error: 'pubkey required' }, 400)

  // List all sched: keys — filter client-side for this pubkey
  // (KV prefix scan by pubkey segment would require a different key structure)
  const result = await env.SCHEDULED_NOTES.list({ prefix: 'sched:' })
  const mine = result.keys
    .filter(k => k.name.includes(`:${pubkey}:`))
    .map(k => ({ key: k.name, expiration: k.expiration }))

  return json({ scheduled: mine })
}

/**
 * Cron handler — called every minute by the Cloudflare Cron Trigger.
 * Lists the current-minute KV bucket and publishes all due events.
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

  const prefix = `sched:${bucket}:`
  const { keys } = await env.SCHEDULED_NOTES.list({ prefix })

  for (const { name } of keys) {
    const raw = await env.SCHEDULED_NOTES.get(name)
    if (!raw) continue

    const event = JSON.parse(raw)
    // TODO: publish `event` to env.RELAYS using nostr-tools WebSocket publish
    console.log(`[scheduler] Publishing event ${event.id} (kind ${event.kind})`)

    // Delete immediately — if publish fails we log it but don't retry here.
    // Future improvement: move to a dead-letter list for retry.
    await env.SCHEDULED_NOTES.delete(name)
  }

  console.log(`[scheduler] Cron tick ${bucket}: processed ${keys.length} events`)
}

/** Convenience: return a JSON response */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
