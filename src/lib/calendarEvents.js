/**
 * Batch-fetch and parse calendar event refs.
 *
 * Given a list of NIP-52 calendar event refs (kind:author:dTag coordinates),
 * group by kind, fetch in one round-trip per kind, dedup latest-wins per
 * coord, parse, and return the resulting parsed-event array sorted with
 * future events ascending, then past events most-recent-first.
 *
 * Used by:
 *   - CalendarDetailView (one calendar's refs)
 *   - CalendarsTab (the union of all calendars' refs, then grouped by dTag)
 *
 * Best-effort: a relay timeout returns whatever subset arrived; never throws.
 */

import { getNDK, connectAndWait } from './ndk.js'
import { withTimeout } from './utils.js'
import {
  KIND_DATE_EVENT,
  KIND_TIME_EVENT,
  parseCalendarEvent,
  isFutureEvent,
} from './eventTypes.js'

const FETCH_TIMEOUT_MS = 8000

/**
 * @param {string[]} refs - Array of "<kind>:<pubkey>:<dTag>" coords
 * @returns {Promise<{
 *   eventsByCoord: Map<string, ParsedEvent>,
 *   sorted: ParsedEvent[],
 * }>}
 */
export async function fetchEventsForRefs(refs) {
  if (!Array.isArray(refs) || refs.length === 0) {
    return { eventsByCoord: new Map(), sorted: [] }
  }
  const ndk = getNDK()
  await connectAndWait(ndk, 3000).catch(() => {})

  // Group refs by kind so we can issue one fetch per kind with #d arrays.
  const byKind = new Map()
  for (const ref of refs) {
    const m = /^(\d+):([0-9a-f]{64}):(.+)$/i.exec(ref)
    if (!m) continue
    const kind = parseInt(m[1], 10)
    if (kind !== KIND_DATE_EVENT && kind !== KIND_TIME_EVENT) continue
    const author = m[2]
    const dT = m[3]
    const k = byKind.get(kind) || { authors: new Set(), ds: new Set() }
    k.authors.add(author)
    k.ds.add(dT)
    byKind.set(kind, k)
  }

  const rawByCoord = new Map()
  for (const [kind, { authors, ds }] of byKind) {
    if (authors.size === 0 || ds.size === 0) continue
    try {
      const set = await withTimeout(
        ndk.fetchEvents({
          kinds: [kind],
          authors: [...authors],
          '#d': [...ds],
          limit: 500,
        }),
        FETCH_TIMEOUT_MS,
        'fetch-timeout',
      )
      for (const ev of set || []) {
        const dT = ev.tags?.find(t => t[0] === 'd')?.[1]
        if (!dT) continue
        const key = `${ev.kind}:${ev.pubkey}:${dT}`
        const prev = rawByCoord.get(key)
        if (!prev || (ev.created_at || 0) > (prev.created_at || 0)) {
          rawByCoord.set(key, ev)
        }
      }
    } catch {
      // Best-effort — continue with whatever did land.
    }
  }

  const eventsByCoord = new Map()
  for (const ref of refs) {
    const ev = rawByCoord.get(ref)
    if (!ev) continue
    const p = parseCalendarEvent({
      id: ev.id,
      pubkey: ev.pubkey,
      kind: ev.kind,
      tags: ev.tags || [],
      content: ev.content || '',
      created_at: ev.created_at,
    })
    if (p) eventsByCoord.set(ref, p)
  }

  const sorted = sortFutureFirst([...eventsByCoord.values()])
  return { eventsByCoord, sorted }
}

/**
 * Sort an array of parsed calendar events: future events ascending by
 * start, then past events descending (most recent first). Pure — returns
 * a new array.
 */
export function sortFutureFirst(parsed) {
  const now = Math.floor(Date.now() / 1000)
  return [...parsed].sort((a, b) => {
    const aFut = isFutureEvent(a, now)
    const bFut = isFutureEvent(b, now)
    if (aFut && !bFut) return -1
    if (!aFut && bFut) return 1
    if (aFut) return a.startUnix - b.startUnix
    return b.startUnix - a.startUnix
  })
}

/**
 * Bucket parsed events by their calendar's eventRefs membership.
 * Returns a Map<calendarDTag, ParsedEvent[]> with each calendar's events
 * pre-sorted future-first.
 */
export function groupByCalendar(calendars, eventsByCoord) {
  const map = new Map()
  for (const { decoded } of calendars) {
    const events = []
    for (const ref of decoded.eventRefs || []) {
      const p = eventsByCoord.get(ref)
      if (p) events.push(p)
    }
    map.set(decoded.dTag, sortFutureFirst(events))
  }
  return map
}
