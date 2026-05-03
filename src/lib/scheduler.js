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
 *   localStorage `mynostr_scheduled_<npub>` is a JSON array of
 *   `{ eventId, scheduledFor, content }` objects. The drafts tray
 *   reads this for "Scheduled" rendering; we sync from the worker
 *   on tab focus to catch cross-device cancellations.
 *
 * Worker URL comes from VITE_SCHEDULER_URL. Without it, all entry
 * points throw a clear error so the UI can disable Schedule.
 */
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { getNDK, signWithTimeout } from './ndk.js'

// 15 minutes — must match the worker's MIN_LEAD_SECONDS.
export const MIN_LEAD_SECONDS = 900
export const MAX_FUTURE_SECONDS = 30 * 24 * 3600

const STORAGE_PREFIX = 'mynostr_scheduled_'

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

function storageKey(pubkey) {
  if (!pubkey) return null
  try { return `${STORAGE_PREFIX}${nip19.npubEncode(pubkey)}` }
  catch { return null }
}

export function readLocalScheduled(pubkey) {
  const key = storageKey(pubkey)
  if (!key) return []
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function writeLocalScheduled(pubkey, list) {
  const key = storageKey(pubkey)
  if (!key) return
  try { localStorage.setItem(key, JSON.stringify(list)) }
  catch {}
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

import { FALLBACK_RELAYS } from './ndk.js'

async function resolveOutboxRelays() {
  const ndk = getNDK()
  try {
    const list = await ndk.activeUser?.relayList?.()
    const writes = list?.writeRelayUrls
    if (Array.isArray(writes) && writes.length) {
      return writes.filter(r => typeof r === 'string' && r.startsWith('wss://'))
    }
  } catch {}
  return [...FALLBACK_RELAYS]
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

  const relays = await resolveOutboxRelays()

  const res = await fetch(`${workerUrl()}/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: ev.rawEvent(),
      publishAt: publishUnixSec,
      relays,
    }),
  })
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}))
    throw new Error(errBody.error || `Scheduler returned ${res.status}`)
  }
  const data = await res.json()
  const pubkey = ndk.activeUser?.pubkey
  if (pubkey) {
    addLocal(pubkey, {
      eventId: data.eventId,
      scheduledFor: data.scheduledFor,
      content: content.slice(0, 200),
    })
  }
  return data
}

/**
 * Fetch scheduled events for a pubkey from the worker, refresh the
 * local index, and return the merged view.
 */
export async function listScheduled(pubkey) {
  if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) return []
  const res = await fetch(`${workerUrl()}/scheduled?pubkey=${pubkey}`)
  if (!res.ok) {
    // Network error or worker down — fall back to local cache so the
    // tray still shows something.
    return readLocalScheduled(pubkey)
  }
  const data = await res.json()
  const items = Array.isArray(data.scheduled) ? data.scheduled : []
  // Refresh the local cache to match server state — drops any local
  // entries the server doesn't know about (e.g. cancelled on another device).
  writeLocalScheduled(pubkey, items.map(it => ({
    eventId: it.eventId,
    scheduledFor: it.scheduledFor,
    content: it.contentPreview || '',
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
  // Web btoa on Unicode → first encode UTF-8 manually.
  const authB64 = btoa(unescape(encodeURIComponent(authJson)))

  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Nostr ${authB64}` },
  })
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}))
    throw new Error(errBody.error || `Cancel failed (${res.status})`)
  }
  removeLocal(pubkey, eventId)
  return await res.json()
}
