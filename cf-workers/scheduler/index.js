/**
 * Cloudflare Worker — Note Scheduler
 *
 * Stores pre-signed Nostr events and publishes them at their scheduled
 * time. Cron fires every 15 min; client schedules with ≥15 min lead.
 *
 * Endpoints:
 *   POST   /schedule        — store a pre-signed event + relay list
 *   GET    /scheduled       — list pending events for a pubkey
 *   DELETE /cancel/:eventId — remove a pending or failed event
 *   (cron)                  — publish due events to their stored relays
 *
 * Trust model: signed-but-not-yet-broadcast events sit in KV until
 * publish time. Worst case: a KV compromise lets the attacker read
 * notes that haven't yet been broadcast — i.e. they leak slightly
 * earlier than intended. The signed payload itself can't be forged
 * (we re-verify Schnorr on POST) and can't be tampered (re-deriving
 * the event id off the canonical serialization happens server-side).
 *
 * KV value shape (per scheduled event):
 *   {
 *     event:    <signed Nostr event>,
 *     relays:   string[],         // user's outbox at schedule time
 *     attempts: number,           // publish attempts so far (0..MAX)
 *     status:   'pending' | 'failed',
 *   }
 *
 * KV key shape:
 *   sched:{pubkey}:{bucketTs}:{eventId}
 *   - pubkey first → list({prefix:'sched:{pubkey}:'}) is per-user O(n)
 *   - bucketTs is the scheduled publish time rounded down to the
 *     nearest 15-minute boundary, e.g. 2026-05-03-14-15
 *   - eventId disambiguates if a user schedules >1 note for the same
 *     bucket
 */

import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'

// ─── Constants ────────────────────────────────────────────────────────────────

// Per-publish ack timeout. Keep tight — cron has a hard wall-clock
// limit on Cloudflare and we may be publishing N notes × M relays.
const RELAY_OK_TIMEOUT_MS = 4_000

// Max relays we'll accept per scheduled event. Bounds cron worst-case
// fan-out and stops a malicious client from POSTing 100s of relays per
// event to amplify the worker's outbound WS load. 24 covers even
// prolific power users — typical kind 10002 lists are 5-15.
const MAX_RELAYS_PER_EVENT = 24

// Max KV value size we'll write (60 KB — KV's hard limit is 25 MB but
// we don't want to be storing huge bodies; nostr events are small).
const MAX_VALUE_SIZE_BYTES = 60 * 1024

// ─── CORS ────────────────────────────────────────────────────────────────────

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || ''
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
  const isAllowed =
    allowed.includes(origin) ||
    origin.startsWith('http://localhost') ||
    origin.startsWith('http://127.0.0.1') ||
    origin.startsWith('http://192.168.')   // LAN dev
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : '',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  }
}

// ─── Hex helpers ─────────────────────────────────────────────────────────────

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2) throw new Error('bad hex')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ─── Nostr verification (id + Schnorr sig) ───────────────────────────────────

/**
 * Recompute event.id from the canonical NIP-01 serialization and verify
 * it matches the claimed id. Then verify the BIP-340 Schnorr signature
 * over that id. Returns true only if both pass.
 */
async function verifyEvent(event) {
  if (!event || typeof event !== 'object') return false
  if (typeof event.id !== 'string' || !/^[0-9a-f]{64}$/.test(event.id)) return false
  if (typeof event.pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(event.pubkey)) return false
  if (typeof event.sig !== 'string' || !/^[0-9a-f]{128}$/.test(event.sig)) return false
  if (!Number.isInteger(event.created_at)) return false
  if (!Number.isInteger(event.kind)) return false

  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    Array.isArray(event.tags) ? event.tags : [],
    typeof event.content === 'string' ? event.content : '',
  ])
  const idBytes = sha256(new TextEncoder().encode(serialized))
  if (bytesToHex(idBytes) !== event.id) return false

  try {
    return schnorr.verify(hexToBytes(event.sig), idBytes, hexToBytes(event.pubkey))
  } catch {
    return false
  }
}

// ─── Bucket helpers ──────────────────────────────────────────────────────────

/**
 * Round a unix-seconds timestamp down to the nearest 15-minute boundary
 * and format as `YYYY-MM-DD-HH-MM` for use as a sortable KV key segment.
 */
function bucketFromUnixSec(unixSec) {
  const d = new Date(unixSec * 1000)
  const minutes = Math.floor(d.getUTCMinutes() / 15) * 15
  d.setUTCMinutes(minutes, 0, 0)
  const pad = (n) => String(n).padStart(2, '0')
  return [
    d.getUTCFullYear(),
    pad(d.getUTCMonth() + 1),
    pad(d.getUTCDate()),
    pad(d.getUTCHours()),
    pad(d.getUTCMinutes()),
  ].join('-')
}

function bucketIsAtOrBefore(bucket, now) {
  // Lexicographic compare works because format is fixed-width.
  return bucket <= now
}

// ─── NIP-98 (HTTP auth) verification ─────────────────────────────────────────
// For DELETE /cancel/:eventId. Header shape:
//   Authorization: Nostr <base64(nostr-event-json)>
// The event must be kind 27235, with `u` tag matching the request URL,
// `method` tag matching the HTTP method, and created_at within 60s.

async function verifyNip98(request, expectedPubkey) {
  const auth = request.headers.get('Authorization') || ''
  const m = auth.match(/^Nostr\s+([A-Za-z0-9+/=_-]+)$/)
  if (!m) return { ok: false, reason: 'missing-or-malformed-auth-header' }
  let event
  try {
    const json = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))
    event = JSON.parse(json)
  } catch {
    return { ok: false, reason: 'auth-event-decode-failed' }
  }
  if (event.kind !== 27235) return { ok: false, reason: 'wrong-kind' }
  if (event.pubkey !== expectedPubkey) {
    return { ok: false, reason: 'pubkey-mismatch' }
  }
  const nowSec = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - (event.created_at || 0)) > 60) {
    return { ok: false, reason: 'auth-event-stale' }
  }
  const uTag = event.tags?.find(t => t[0] === 'u')?.[1]
  const methodTag = event.tags?.find(t => t[0] === 'method')?.[1]
  if (!uTag || uTag !== request.url) return { ok: false, reason: 'url-mismatch' }
  if (!methodTag || methodTag.toUpperCase() !== request.method.toUpperCase()) {
    return { ok: false, reason: 'method-mismatch' }
  }
  const sigOk = await verifyEvent(event)
  if (!sigOk) return { ok: false, reason: 'auth-event-bad-signature' }
  return { ok: true }
}

// ─── HTTP entry point ────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }), request, env)
    }

    const url = new URL(request.url)
    let response

    try {
      if (request.method === 'POST' && url.pathname === '/schedule') {
        response = await handleSchedule(request, env)
      } else if (request.method === 'GET' && url.pathname === '/scheduled') {
        response = await handleList(request, env)
      } else if (request.method === 'DELETE' && url.pathname.startsWith('/cancel/')) {
        const eventId = url.pathname.slice('/cancel/'.length)
        response = await handleCancel(request, env, eventId)
      } else {
        response = json({ error: 'Not found' }, 404)
      }
    } catch (err) {
      response = json({ error: err.message || 'internal error' }, 500)
    }

    return withCors(response, request, env)
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(handleCron(env))
  },
}

function withCors(response, request, env) {
  const headers = new Headers(response.headers)
  for (const [k, v] of Object.entries(corsHeaders(request, env))) {
    headers.set(k, v)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

// ─── POST /schedule ──────────────────────────────────────────────────────────

async function handleSchedule(request, env) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'invalid-json' }, 400)
  }
  const { event, publishAt, relays } = body || {}

  if (!event || !publishAt || !Array.isArray(relays)) {
    return json({ error: 'missing-fields', expected: 'event, publishAt, relays[]' }, 400)
  }

  // Validate publishAt — accept either ISO string or unix seconds number.
  const publishUnixSec = typeof publishAt === 'number'
    ? Math.floor(publishAt)
    : Math.floor(new Date(publishAt).getTime() / 1000)
  if (!Number.isFinite(publishUnixSec) || publishUnixSec <= 0) {
    return json({ error: 'invalid-publishAt' }, 400)
  }

  const nowSec = Math.floor(Date.now() / 1000)
  const minLead = parseInt(env.MIN_LEAD_SECONDS || '900', 10)
  const maxFuture = parseInt(env.MAX_FUTURE_SECONDS || '2592000', 10)
  if (publishUnixSec < nowSec + minLead) {
    return json({ error: 'publish-too-soon', minLeadSeconds: minLead }, 400)
  }
  if (publishUnixSec > nowSec + maxFuture) {
    return json({ error: 'publish-too-far', maxFutureSeconds: maxFuture }, 400)
  }

  // Cross-check: the event's created_at SHOULD match publishAt. We use
  // event.created_at as the canonical schedule time when we publish, so
  // a mismatch would mean the relay sees a different timestamp than the
  // user requested. Reject obvious drift but tolerate small skew.
  if (Math.abs((event.created_at ?? 0) - publishUnixSec) > 60) {
    return json({ error: 'created_at-publishAt-mismatch' }, 400)
  }

  // Validate relays — must all be wss:// URLs, capped count.
  if (relays.length === 0) {
    return json({ error: 'No write relays found in your kind 10002 list.' }, 400)
  }
  if (relays.length > MAX_RELAYS_PER_EVENT) {
    return json({
      error: `Scheduler limit is ${MAX_RELAYS_PER_EVENT} write relays per note.`,
    }, 400)
  }
  for (const r of relays) {
    if (typeof r !== 'string' || !/^wss:\/\/[^\s]+$/.test(r)) {
      return json({ error: `Invalid relay URL in your list: ${r}` }, 400)
    }
  }

  // Re-verify event id + signature server-side. Don't trust the client.
  const sigOk = await verifyEvent(event)
  if (!sigOk) {
    return json({ error: 'invalid-event-signature' }, 400)
  }

  const value = JSON.stringify({
    event,
    relays: Array.from(new Set(relays)),
    attempts: 0,
    status: 'pending',
  })
  if (value.length > MAX_VALUE_SIZE_BYTES) {
    return json({ error: 'event-too-large' }, 413)
  }

  const bucket = bucketFromUnixSec(publishUnixSec)
  const key = `sched:${event.pubkey}:${bucket}:${event.id}`

  // KV TTL: keep for the scheduled time + 7 days. After that we don't
  // care — failed entries get cleaned up automatically.
  const expirationTtl = Math.max(60, (publishUnixSec - nowSec) + 7 * 86400)

  await env.SCHEDULED_NOTES.put(key, value, { expirationTtl })
  return json({ ok: true, eventId: event.id, scheduledFor: publishUnixSec })
}

// ─── GET /scheduled?pubkey=<hex> ─────────────────────────────────────────────

async function handleList(request, env) {
  const url = new URL(request.url)
  const pubkey = url.searchParams.get('pubkey')
  if (!pubkey) return json({ error: 'pubkey-required' }, 400)
  if (!/^[0-9a-f]{64}$/.test(pubkey)) {
    return json({ error: 'invalid-pubkey' }, 400)
  }

  const result = await env.SCHEDULED_NOTES.list({ prefix: `sched:${pubkey}:` })
  // Resolve values so the UI can render + hydrate the editor for
  // a clicked scheduled item without per-row follow-ups. Returning
  // the full signed event (not just a preview) is what powers the
  // "click a scheduled row → composer opens locked with the original
  // content" UX. Capped — KV.list returns 1000 keys per page; that's
  // our soft limit per pubkey.
  const items = []
  for (const k of result.keys) {
    const raw = await env.SCHEDULED_NOTES.get(k.name)
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw)
      const parts = k.name.split(':')   // sched, pubkey, bucket, eventId
      items.push({
        key: k.name,
        eventId: parts[3] || parsed.event?.id,
        bucket: parts[2],
        scheduledFor: parsed.event?.created_at,
        event: parsed.event,
        relays: parsed.relays || [],
        attempts: parsed.attempts,
        status: parsed.status,
      })
    } catch {}
  }
  return json({ scheduled: items })
}

// ─── DELETE /cancel/:eventId ─────────────────────────────────────────────────

async function handleCancel(request, env, eventId) {
  if (!/^[0-9a-f]{64}$/.test(eventId)) {
    return json({ error: 'invalid-event-id' }, 400)
  }

  // Find the entry first so we know which pubkey to validate against.
  // The eventId alone is unique across users (event hashes don't collide
  // across distinct pubkeys), but key shape is `sched:{pk}:{bucket}:{id}`
  // so we have to scan. Per-pubkey scan would require the client to
  // pass pubkey too — but then anyone can pass anyone's pubkey. Trust
  // model: NIP-98 auth proves the cancel-er IS the author.
  //
  // We use a two-step: client passes pubkey as a hint, we scan their
  // own bucket prefix, then verify NIP-98 from the same pubkey.
  const url = new URL(request.url)
  const pubkey = url.searchParams.get('pubkey')
  if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) {
    return json({ error: 'pubkey-query-param-required' }, 400)
  }

  const auth = await verifyNip98(request, pubkey)
  if (!auth.ok) return json({ error: 'unauthorized', reason: auth.reason }, 401)

  // Locate the entry under this pubkey.
  const list = await env.SCHEDULED_NOTES.list({ prefix: `sched:${pubkey}:` })
  const target = list.keys.find(k => k.name.endsWith(`:${eventId}`))
  if (!target) return json({ error: 'not-found' }, 404)

  await env.SCHEDULED_NOTES.delete(target.name)
  return json({ ok: true, eventId, key: target.name })
}

// ─── Cron — publish due events ───────────────────────────────────────────────

async function handleCron(env) {
  const nowSec = Math.floor(Date.now() / 1000)
  const nowBucket = bucketFromUnixSec(nowSec)
  const maxAttempts = parseInt(env.MAX_PUBLISH_ATTEMPTS || '4', 10)

  // List all scheduled keys. For alpha volume this is fine (KV.list
  // returns up to 1000 keys per page). When we outgrow that we'll move
  // to a per-bucket secondary index.
  const { keys } = await env.SCHEDULED_NOTES.list({ prefix: 'sched:' })

  let published = 0
  let failedFinal = 0
  let stillPending = 0
  let skipped = 0

  for (const { name } of keys) {
    // sched:{pubkey}:{bucket}:{eventId}
    const parts = name.split(':')
    if (parts.length !== 4) { skipped++; continue }
    const bucket = parts[2]
    if (!bucketIsAtOrBefore(bucket, nowBucket)) { skipped++; continue }   // not yet due

    const raw = await env.SCHEDULED_NOTES.get(name)
    if (!raw) { skipped++; continue }
    let parsed
    try { parsed = JSON.parse(raw) } catch { skipped++; continue }

    if (parsed.status === 'failed') { skipped++; continue }   // already gave up; UI will surface

    const okCount = await publishToRelays(parsed.event, parsed.relays || [])

    if (okCount > 0) {
      // At least one relay accepted — call it published, drop from KV.
      await env.SCHEDULED_NOTES.delete(name)
      published++
      console.log(`[scheduler] published ${parsed.event.id.slice(0, 12)}… to ${okCount}/${parsed.relays.length} relays`)
    } else {
      const attempts = (parsed.attempts || 0) + 1
      const newStatus = attempts >= maxAttempts ? 'failed' : 'pending'
      const updated = JSON.stringify({ ...parsed, attempts, status: newStatus })
      // Preserve the original TTL — KV.put will reset the TTL each time
      // we write. Compute remaining: (publishedTime + 7d) - now.
      const eventTime = parsed.event?.created_at || nowSec
      const expirationTtl = Math.max(60, (eventTime - nowSec) + 7 * 86400)
      await env.SCHEDULED_NOTES.put(name, updated, { expirationTtl })
      if (newStatus === 'failed') {
        failedFinal++
        console.warn(`[scheduler] giving up on ${parsed.event.id.slice(0, 12)}… after ${attempts} attempts`)
      } else {
        stillPending++
        console.log(`[scheduler] retry ${attempts}/${maxAttempts} for ${parsed.event.id.slice(0, 12)}…`)
      }
    }
  }

  console.log(`[scheduler] tick ${nowBucket}: published=${published} failedFinal=${failedFinal} stillPending=${stillPending} skipped=${skipped}`)
}

// ─── WS publish (one event → N relays) ───────────────────────────────────────
// Opens a WS to each relay, sends EVENT, waits for OK with a tight
// timeout. Returns number of relays that ACKed `true`.

async function publishToRelays(event, relays) {
  const results = await Promise.all(relays.map(url => publishOne(event, url)))
  return results.filter(Boolean).length
}

function publishOne(event, relayUrl) {
  return new Promise((resolve) => {
    let ws
    try {
      ws = new WebSocket(relayUrl)
    } catch (e) {
      console.warn(`[scheduler] WS construct failed for ${relayUrl}: ${e?.message}`)
      resolve(false)
      return
    }

    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      try { ws.close() } catch {}
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), RELAY_OK_TIMEOUT_MS)

    ws.addEventListener('open', () => {
      try { ws.send(JSON.stringify(['EVENT', event])) }
      catch (e) {
        console.warn(`[scheduler] send failed on ${relayUrl}: ${e?.message}`)
        clearTimeout(timer)
        finish(false)
      }
    })

    ws.addEventListener('message', (m) => {
      let msg
      try { msg = JSON.parse(m.data) } catch { return }
      if (!Array.isArray(msg)) return
      // Expect ["OK", <eventId>, <bool>, <message>]
      if (msg[0] === 'OK' && msg[1] === event.id) {
        const ok = msg[2] === true
        if (!ok) {
          console.warn(`[scheduler] ${relayUrl} rejected ${event.id.slice(0, 12)}…: ${msg[3] || ''}`)
        }
        clearTimeout(timer)
        finish(ok)
      }
    })

    ws.addEventListener('error', (err) => {
      console.warn(`[scheduler] WS error on ${relayUrl}: ${err?.message || err?.type || 'unknown'}`)
      clearTimeout(timer)
      finish(false)
    })

    ws.addEventListener('close', () => {
      // Closed before OK — treat as fail unless we already finished.
      clearTimeout(timer)
      finish(false)
    })
  })
}

// ─── JSON response helper ────────────────────────────────────────────────────

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
