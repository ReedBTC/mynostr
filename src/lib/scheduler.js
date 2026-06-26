/**
 * Note scheduler — client-side helpers for the mynostr-scheduler worker.
 *
 * Responsibilities:
 *   - scheduleNote()  — sign a kind 1 with future created_at, POST to
 *     the worker with the user's outbox relay list.
 *   - listScheduled() — fetch pending events from the worker for the
 *     current pubkey.
 *   - cancelScheduled() — DELETE a pending event with NIP-98 auth.
 *
 * Persistence (per-pubkey, matches the project rule):
 *   localStorage storageKey(`scheduled_<npub>`) is a JSON array of
 *   `{ eventId, scheduledFor, content }` objects. The drafts tray
 *   reads this for "Scheduled" rendering; we sync from the worker
 *   on tab focus to catch cross-device cancellations.
 *
 * Worker URL comes from VITE_SCHEDULER_URL. Without it, all entry
 * points throw a clear error so the UI can disable Schedule.
 */
import { storageKey } from './brand.js'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { getNDK, signWithTimeout } from './ndk.js'

// 15 minutes — must match the worker's MIN_LEAD_SECONDS.
export const MIN_LEAD_SECONDS = 900
// 1 year — must match the worker's MAX_FUTURE_SECONDS.
export const MAX_FUTURE_SECONDS = 365 * 24 * 3600

// Bound every worker round-trip so a misbehaving / unreachable worker
// can't wedge the UI on "Scheduling…" / "Loading…" forever.
const FETCH_TIMEOUT_MS = 10_000

const STORAGE_PREFIX = storageKey('scheduled_')

function workerUrl() {
  const u = import.meta.env.VITE_SCHEDULER_URL
  if (!u) throw new Error('Scheduler not configured (VITE_SCHEDULER_URL missing).')
  return u.replace(/\/$/, '')
}

export function isSchedulerConfigured() {
  return !!import.meta.env.VITE_SCHEDULER_URL
}

// ─── Local index (per-pubkey) ────────────────────────────────────────────────
// Mirror of the worker's view, kept in localStorage so the drafts tray
// renders fast on cold load. Worker is the source of truth — any
// inconsistency is reconciled by listScheduled() when the tab gains focus.
//
// Pub/sub: any local mutation notifies subscribers so React surfaces
// (DraftsTray, NotesModule) re-read the mirror immediately rather than
// waiting for a focus event. Without this, scheduling a new note shows
// a sluggish "card appears on next refresh" UX, and a cron-published
// item lingers until the next tab focus.

const localSubscribers = new Set()
function notifyLocalChange() {
  for (const fn of localSubscribers) {
    try { fn() } catch {}
  }
}

/** Subscribe to local-mirror mutations. Returns an unsubscribe fn. */
export function onLocalChange(fn) {
  localSubscribers.add(fn)
  return () => localSubscribers.delete(fn)
}

function storageKeyFor(pubkey) {
  if (!pubkey) return null
  try { return `${STORAGE_PREFIX}${nip19.npubEncode(pubkey)}` }
  catch { return null }
}

export function readLocalScheduled(pubkey) {
  const key = storageKeyFor(pubkey)
  if (!key) return []
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function writeLocalScheduled(pubkey, list) {
  const key = storageKeyFor(pubkey)
  if (!key) return
  try { localStorage.setItem(key, JSON.stringify(list)) }
  catch {}
  notifyLocalChange()
}

function addLocal(pubkey, entry) {
  const list = readLocalScheduled(pubkey)
  if (list.some(e => e.eventId === entry.eventId)) return
  list.push(entry)
  list.sort((a, b) => a.scheduledFor - b.scheduledFor)
  writeLocalScheduled(pubkey, list)
}

function removeLocal(pubkey, eventId) {
  const list = readLocalScheduled(pubkey).filter(e => e.eventId !== eventId)
  writeLocalScheduled(pubkey, list)
}

// ─── User's outbox at schedule time ──────────────────────────────────────────
// We persist the relay list alongside the event so cron publishes to
// the right places even if the user changes their kind 10002 later.
// Falls back to FALLBACK_RELAYS if no kind 10002 is found — better to
// publish *somewhere* than to fail.

import { FALLBACK_RELAYS, getOwnWriteRelays } from './ndk.js'

// Mirror of MAX_RELAYS_PER_EVENT in cf-workers/scheduler/index.js.
// Keep in sync — the worker enforces this same cap server-side, so
// posting more than this triggers a server-side rejection. We slice
// + warn client-side so the user gets a useful surface ("first 24
// of your 30 relays were used") instead of a flat error.
export const MAX_SCHEDULER_RELAYS = 24

/**
 * Resolve the user's write relays for the scheduler payload. Dedupes
 * via Set + filters to wss:// only. Uses the direct kind-10002 fetch
 * (getOwnWriteRelays) rather than NDK's activeUser.relayList() helper —
 * the helper has a known habit of returning stale or duplicate URLs
 * after a session-long edit, which is exactly what made Reed see
 * "limit is 24 write relays" with fewer than 24 actual relays.
 *
 * Returns:
 *   { relays: string[], total: number, source: 'kind10002'|'fallback' }
 *   - `relays`: deduped wss-only list, ALREADY SLICED to MAX_SCHEDULER_RELAYS
 *   - `total`:  pre-slice count (so callers can warn when > MAX)
 *   - `source`: where the relays came from (kind10002 vs fallback pool)
 */
async function resolveOutboxRelays() {
  const ndk = getNDK()
  let urls = await getOwnWriteRelays(ndk)
  let source = 'kind10002'
  if (!Array.isArray(urls) || urls.length === 0) {
    urls = [...FALLBACK_RELAYS]
    source = 'fallback'
  }
  const seen = new Set()
  const deduped = []
  for (const u of urls) {
    if (typeof u !== 'string') continue
    if (!/^wss:\/\//i.test(u)) continue
    const norm = u.trim()
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    deduped.push(norm)
  }
  const total = deduped.length
  const sliced = deduped.slice(0, MAX_SCHEDULER_RELAYS)
  return { relays: sliced, total, source }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Sign a scheduled note and POST it to the worker.
 *
 * @param {object}   args
 * @param {string}   args.content    — note body (already-rendered final text)
 * @param {Array}    args.tags       — final tag array (mentions, splits, etc.)
 * @param {number}   args.publishUnixSec — when to publish, in unix seconds
 * @returns {Promise<{ eventId: string, scheduledFor: number }>}
 */
export async function scheduleNote({ content, tags, publishUnixSec }) {
  const ndk = getNDK()
  if (!ndk?.signer) throw new Error('Sign in first — scheduling requires a signer.')

  const nowSec = Math.floor(Date.now() / 1000)
  if (!Number.isFinite(publishUnixSec) || publishUnixSec < nowSec + MIN_LEAD_SECONDS) {
    throw new Error(`Schedule at least ${MIN_LEAD_SECONDS / 60} minutes in the future.`)
  }
  if (publishUnixSec > nowSec + MAX_FUTURE_SECONDS) {
    throw new Error('Schedule no more than 30 days out.')
  }

  // Build + sign the kind 1 with the future created_at. The worker
  // re-verifies the Schnorr signature server-side, so a tampered
  // event between signing and POST won't get accepted.
  const ev = new NDKEvent(ndk)
  ev.kind       = 1
  ev.content    = content
  ev.created_at = publishUnixSec
  ev.tags       = Array.isArray(tags) ? tags : []
  await signWithTimeout(ev)

  const { relays, total: totalRelays, source: relaySource } = await resolveOutboxRelays()

  // Soft cap warning — the worker enforces MAX_SCHEDULER_RELAYS too
  // (same constant), but slicing client-side means a user with 30
  // write relays gets a graceful "first 24 used" message instead of
  // a flat error. Warning is non-blocking; schedule still succeeds.
  let warning = null
  if (totalRelays > MAX_SCHEDULER_RELAYS) {
    warning = `You have ${totalRelays} write relays in your kind-10002 list, but the scheduler can only publish to ${MAX_SCHEDULER_RELAYS} per note. Your note will land on the first ${MAX_SCHEDULER_RELAYS} of your write relays. To use a different set, trim your relay list (Profile → Relays).`
  }

  let res
  try {
    res = await fetch(`${workerUrl()}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: ev.rawEvent(),
        publishAt: publishUnixSec,
        relays,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (e) {
    if (e?.name === 'TimeoutError') {
      throw new Error('Scheduler didn\'t respond. Try again in a moment.')
    }
    throw e
  }
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}))
    throw new Error(errBody.error || `Scheduler returned ${res.status}`)
  }
  const data = await res.json()
  // Surface relay-source + warning so the success view can render
  // useful context. relaySource='fallback' lets us hint that the user
  // should publish a kind 10002 if they care about their notes
  // landing on their followers' read relays.
  data.warning = warning
  data.relaysUsed = relays.length
  data.relayTotal = totalRelays
  data.relaySource = relaySource
  const pubkey = ndk.activeUser?.pubkey
  if (pubkey) {
    addLocal(pubkey, {
      eventId: data.eventId,
      scheduledFor: data.scheduledFor,
      content,
      // Stash the full signed event so click-to-hydrate the editor
      // doesn't need a worker round-trip. This is also what we need
      // to convert a scheduled item back into an editable draft on
      // cancel-and-edit.
      event: ev.rawEvent(),
      status: 'pending',
    })
  }
  return data
}

/** Look up a single scheduled entry from the local mirror. Returns null
 *  if not found locally — caller can fall back to listScheduled() to
 *  refresh from the worker. */
export function getScheduledEntryLocal(pubkey, eventId) {
  if (!pubkey || !eventId) return null
  return readLocalScheduled(pubkey).find(e => e.eventId === eventId) || null
}

/**
 * Fetch scheduled events for a pubkey from the worker, refresh the
 * local index, and return the merged view.
 */
export async function listScheduled(pubkey) {
  if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) return []
  let res
  try {
    res = await fetch(`${workerUrl()}/scheduled?pubkey=${pubkey}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (e) {
    // Timeout or network error — fall back to local cache so the
    // tray still shows what we know.
    return readLocalScheduled(pubkey)
  }
  if (!res.ok) {
    // Network error or worker down — fall back to local cache so the
    // tray still shows something.
    return readLocalScheduled(pubkey)
  }
  const data = await res.json()
  const items = Array.isArray(data.scheduled) ? data.scheduled : []
  // Refresh the local cache to match server state — drops any local
  // entries the server doesn't know about (e.g. cancelled on another
  // device). Stash the full signed event for click-to-hydrate.
  writeLocalScheduled(pubkey, items.map(it => ({
    eventId: it.eventId,
    scheduledFor: it.scheduledFor,
    content: it.event?.content || '',
    event: it.event || null,
    status: it.status,
    attempts: it.attempts,
  })))
  return items
}

/**
 * Cancel a pending scheduled event. Builds a NIP-98 auth event, signs
 * it, and DELETEs the worker entry.
 */
export async function cancelScheduled(eventId, pubkey) {
  if (!eventId || !/^[0-9a-f]{64}$/.test(eventId)) {
    throw new Error('Invalid event id.')
  }
  if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) {
    throw new Error('Invalid pubkey.')
  }
  const ndk = getNDK()
  if (!ndk?.signer) throw new Error('Sign in first — cancelling requires a signer.')

  const url = `${workerUrl()}/cancel/${eventId}?pubkey=${pubkey}`

  // NIP-98: kind 27235 with `u` (full URL incl. query) and `method` tags.
  const auth = new NDKEvent(ndk)
  auth.kind       = 27235
  auth.created_at = Math.floor(Date.now() / 1000)
  auth.content    = ''
  auth.tags       = [
    ['u', url],
    ['method', 'DELETE'],
  ]
  await signWithTimeout(auth)
  const authJson = JSON.stringify(auth.rawEvent())
  // Web btoa() expects a Latin-1 binary string. JSON of a NIP-98 event
  // typically only contains ASCII, but defensive UTF-8 → btoa-safe via
  // TextEncoder + per-byte mapping. Replaces the deprecated
  // unescape(encodeURIComponent(...)) trick.
  const authB64 = btoa(
    String.fromCharCode(...new TextEncoder().encode(authJson)),
  )

  let res
  try {
    res = await fetch(url, {
      method: 'DELETE',
      headers: { 'Authorization': `Nostr ${authB64}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (e) {
    if (e?.name === 'TimeoutError') {
      throw new Error('Scheduler didn\'t respond. Try again in a moment.')
    }
    throw e
  }
  if (!res.ok) {
    // 404 means the entry is already gone — most often because cron
    // just published it (race window between user clicking Cancel
    // and the next tick) or another device cancelled. Treat as a
    // success so the local mirror still gets cleaned up and the UI
    // doesn't strand the user in a "can't cancel a thing that
    // doesn't exist" loop.
    if (res.status === 404) {
      removeLocal(pubkey, eventId)
      return { ok: true, alreadyGone: true }
    }
    const errBody = await res.json().catch(() => ({}))
    throw new Error(errBody.error || `Cancel failed (${res.status})`)
  }
  removeLocal(pubkey, eventId)
  return await res.json()
}
