/**
 * eventTypes — NIP-52 calendar-event helpers.
 *
 * Mynostr's events module deals with four addressable Nostr kinds:
 *
 *   31922 — date-based event (full-day, no timezone)
 *   31923 — time-based event (Unix-second precision, IANA tzid)
 *   31924 — calendar (a list of events; bookmark-mechanism in Phase 2)
 *   31925 — RSVP
 *
 * This module is the parse-side: turn an NDKEvent into a normalized
 * shape the UI can render without each component re-grokking the tag
 * format. The publish-side lives in eventPublish.js.
 *
 * Spec gaps we close locally (see project_events_plan when written):
 *   • NIP-52 doesn't define recurrence — we treat each event as a
 *     standalone occurrence (Phase 4 will explode a recurring config
 *     into N independent kind 31923 events).
 *   • NIP-52 doesn't define cancellation — we use kind 5 deletion,
 *     matching Plektos.
 */
import { nip19 } from 'nostr-tools'

export const KIND_DATE_EVENT = 31922
export const KIND_TIME_EVENT = 31923
export const KIND_CALENDAR   = 31924
export const KIND_RSVP       = 31925

const SECONDS_PER_DAY = 86400

export function isCalendarEventKind(k) {
  return k === KIND_DATE_EVENT || k === KIND_TIME_EVENT
}

function tagValue(ev, name) {
  return ev?.tags?.find(t => t[0] === name)?.[1] || ''
}
function tagValues(ev, name) {
  if (!ev?.tags) return []
  return ev.tags.filter(t => t[0] === name && typeof t[1] === 'string').map(t => t[1])
}

/**
 * Parse a raw NDKEvent (or {kind, pubkey, tags, content, created_at, id})
 * into a normalized shape. Returns null if the event isn't a valid
 * 31922/31923 — callers can skip rather than render garbage.
 *
 * Returned shape:
 *   {
 *     id, pubkey, kind, dTag, naddr,
 *     title, summary, content, image, location, geohash,
 *     hashtags: string[], references: string[],
 *     participants: [{ pubkey, relay, role }],
 *     isDateBased, start, end, startTzid, endTzid,
 *     // Sortable / display helpers:
 *     startUnix,        // best-effort epoch seconds
 *     endUnix,          // null when open-ended
 *     createdAt,
 *   }
 */
export function parseCalendarEvent(ev) {
  if (!ev || !isCalendarEventKind(ev.kind)) return null
  const dTag = tagValue(ev, 'd')
  if (!dTag) return null
  const title = tagValue(ev, 'title')
  if (!title) return null
  const startRaw = tagValue(ev, 'start')
  if (!startRaw) return null

  const isDateBased = ev.kind === KIND_DATE_EVENT
  const endRaw = tagValue(ev, 'end')

  // Time-based: start/end are Unix seconds. Date-based: start/end are
  // ISO 8601 (YYYY-MM-DD). For sorting we coerce everything to a unix
  // epoch — date-based events anchor at midnight UTC of the start day.
  let startUnix, endUnix = null, startTzid = '', endTzid = ''
  if (isDateBased) {
    startUnix = ymdToUnixUtc(startRaw)
    endUnix   = endRaw ? ymdToUnixUtc(endRaw) + SECONDS_PER_DAY - 1 : null
  } else {
    startUnix = parseUnixSeconds(startRaw)
    endUnix   = endRaw ? parseUnixSeconds(endRaw) : null
    // Sanitize tzids at parse time — events in the wild carry junk like
    // "Munich, DE" or "EST" instead of IANA ids. Intl.DateTimeFormat
    // throws RangeError on invalid zones, which would crash any feed
    // containing a single bad event. Drop invalid tzids to '' so the
    // display layer falls back to the viewer's local zone.
    startTzid = sanitizeTzid(tagValue(ev, 'start_tzid'))
    endTzid   = sanitizeTzid(tagValue(ev, 'end_tzid')) || startTzid
  }
  if (!Number.isFinite(startUnix)) return null

  // Participants from p-tags. NIP-52 shape: ["p", pubkey, relay?, role?]
  const participants = (ev.tags || [])
    .filter(t => t[0] === 'p' && typeof t[1] === 'string' && t[1].length === 64)
    .map(t => ({ pubkey: t[1], relay: t[2] || '', role: t[3] || '' }))

  let naddr = ''
  try {
    naddr = nip19.naddrEncode({ kind: ev.kind, pubkey: ev.pubkey, identifier: dTag })
  } catch {
    // Should never happen for a valid event, but a bad pubkey shouldn't
    // crash the feed.
  }

  return {
    id: ev.id || '',
    pubkey: ev.pubkey || '',
    kind: ev.kind,
    dTag,
    naddr,
    title,
    summary: tagValue(ev, 'summary'),
    content: ev.content || '',
    image: tagValue(ev, 'image'),
    location: tagValue(ev, 'location'),
    geohash: tagValue(ev, 'g'),
    hashtags: tagValues(ev, 't'),
    references: tagValues(ev, 'r'),
    participants,
    isDateBased,
    start: startRaw,
    end: endRaw,
    startTzid,
    endTzid,
    startUnix,
    endUnix,
    createdAt: ev.created_at || 0,
  }
}

/**
 * Parse a NIP-52 RSVP (kind 31925). Returns null on malformed events.
 *
 *   {
 *     id, pubkey, dTag,
 *     targetCoord,        // "31923:authorpk:dtag"
 *     targetEventId,      // optional; e-tag if pinned to a revision
 *     targetAuthor,       // optional; p-tag for query optimization
 *     status,             // accepted | declined | tentative
 *     freeBusy,           // free | busy | ''
 *     createdAt,
 *   }
 */
export function parseRsvp(ev) {
  if (!ev || ev.kind !== KIND_RSVP) return null
  const aTag = tagValue(ev, 'a')
  const status = tagValue(ev, 'status').toLowerCase()
  if (!aTag || !status) return null
  if (status !== 'accepted' && status !== 'declined' && status !== 'tentative') return null
  return {
    id: ev.id || '',
    pubkey: ev.pubkey || '',
    dTag: tagValue(ev, 'd'),
    targetCoord: aTag,
    targetEventId: tagValue(ev, 'e'),
    targetAuthor:  tagValue(ev, 'p'),
    status,
    freeBusy: tagValue(ev, 'fb').toLowerCase(),
    createdAt: ev.created_at || 0,
  }
}

/**
 * Build the addressable coordinate for a parsed calendar event:
 * "<kind>:<authorpk>:<dtag>". Used as the `a` tag value on RSVPs and
 * as the d-tag of mynostr-published RSVPs (so re-RSVPing replaces).
 */
export function coordOf(parsed) {
  if (!parsed) return ''
  return `${parsed.kind}:${parsed.pubkey}:${parsed.dTag}`
}

/**
 * Latest-wins dedup of RSVPs by `(authorpubkey, targetCoord)`. NIP-52
 * doesn't formally specify the d-tag scheme for RSVPs, so different
 * clients use different schemes — Plektos generates a UUID per RSVP
 * (orphan rows accumulate when a user changes their mind), mynostr
 * reuses the target coordinate as d-tag (replacement is automatic on
 * the publishing side). Either way, on the read side we still need
 * latest-wins per (author, target) so the UI shows the user's most
 * recent intent.
 */
export function dedupRsvpsLatest(rsvps) {
  const best = new Map()
  for (const r of rsvps) {
    if (!r) continue
    const key = `${r.pubkey}|${r.targetCoord}`
    const prev = best.get(key)
    if (!prev || r.createdAt > prev.createdAt) best.set(key, r)
  }
  return [...best.values()]
}

/**
 * Future-events filter: events whose start (or end) is at or after now.
 * Open-ended events count as "future" if they started today or later
 * — clients usually want to show today's all-day event even if it's
 * partway through.
 */
export function isFutureEvent(parsed, nowSec = Math.floor(Date.now() / 1000)) {
  if (!parsed) return false
  const cutoff = parsed.endUnix ?? parsed.startUnix
  return cutoff >= nowSec
}

// ── Display helpers ───────────────────────────────────────────────────

/**
 * Human-readable event time. Date-based events render as a date or
 * a date range; time-based events render with the local time and the
 * event's tzid (if declared) so a user in Amsterdam knows that 7pm SF
 * is something other than 7pm local.
 */
export function formatEventTime(parsed) {
  if (!parsed) return ''
  if (parsed.isDateBased) {
    const startStr = formatYmdHuman(parsed.start)
    if (parsed.end && parsed.end !== parsed.start) {
      return `${startStr} → ${formatYmdHuman(parsed.end)}`
    }
    return startStr
  }
  const start = new Date(parsed.startUnix * 1000)
  const end = parsed.endUnix ? new Date(parsed.endUnix * 1000) : null
  // parseCalendarEvent already strips invalid tzids, so this is a sanity
  // re-probe — `formatEventTime` is also called from places that hand-
  // build a parsed-shaped object, and we don't want one bad consumer
  // taking down the whole feed.
  const tz = isUsableTimezone(parsed.startTzid) ? parsed.startTzid : undefined
  const dateOpts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: tz }
  const timeOpts = { hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }
  try {
    let out = start.toLocaleString(undefined, dateOpts) + ' · ' + start.toLocaleTimeString(undefined, timeOpts)
    if (end) {
      const sameDay =
        start.toLocaleDateString(undefined, { timeZone: tz }) ===
        end.toLocaleDateString(undefined, { timeZone: tz })
      if (sameDay) {
        out += ' – ' + end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: tz })
      } else {
        out += ' → ' + end.toLocaleString(undefined, dateOpts) + ' · ' + end.toLocaleTimeString(undefined, timeOpts)
      }
    }
    return out
  } catch {
    // Last-ditch fallback — render in the viewer's local zone with no
    // tz suffix so we still show *something* readable.
    const localDateOpts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }
    const localTimeOpts = { hour: 'numeric', minute: '2-digit' }
    let out = start.toLocaleString(undefined, localDateOpts) + ' · ' + start.toLocaleTimeString(undefined, localTimeOpts)
    if (end) out += ' → ' + end.toLocaleString(undefined, localDateOpts) + ' · ' + end.toLocaleTimeString(undefined, localTimeOpts)
    return out
  }
}

function isUsableTimezone(tz) {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * Compact "date pill" for cards. Returns { dayNum, monthShort } so the
 * UI can stack them in a calendar-tear-off pill.
 */
export function dateBits(parsed) {
  if (!parsed) return { dayNum: '', monthShort: '' }
  const d = new Date(parsed.startUnix * 1000)
  // For date-based events, the YMD is UTC midnight — render with UTC
  // formatter so the day number doesn't drift across timezones.
  // The try/catch is belt-and-braces: parseCalendarEvent already strips
  // invalid tzids, but a single malformed event sneaking past would
  // otherwise crash the whole feed (RangeError out of toLocaleString).
  const opts = parsed.isDateBased ? { timeZone: 'UTC' } : { timeZone: parsed.startTzid || undefined }
  try {
    return {
      dayNum: d.toLocaleString(undefined, { ...opts, day: 'numeric' }),
      monthShort: d.toLocaleString(undefined, { ...opts, month: 'short' }).toUpperCase(),
    }
  } catch {
    return {
      dayNum: d.toLocaleString(undefined, { day: 'numeric' }),
      monthShort: d.toLocaleString(undefined, { month: 'short' }).toUpperCase(),
    }
  }
}

// ── Internal helpers ──────────────────────────────────────────────────

function parseUnixSeconds(s) {
  const n = parseInt(String(s).trim(), 10)
  return Number.isFinite(n) ? n : NaN
}

/**
 * Validate that a string is an IANA tz id Intl will accept. Wild Nostr
 * events carry strings like "Munich, DE" or "EST" — both are nonsense
 * to Intl, which responds with `RangeError: Invalid time zone specified`
 * rather than a graceful fallback. We probe with DateTimeFormat once
 * at parse time; valid → return as-is, invalid → return '' so the
 * caller can fall back to the viewer's local zone.
 */
function sanitizeTzid(raw) {
  const tz = String(raw || '').trim()
  if (!tz) return ''
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return ''
  }
}

// "YYYY-MM-DD" → unix seconds at UTC midnight. NIP-52 says date-based
// events are timezone-agnostic; we anchor at UTC for sorting purposes
// and let the display layer present them as a local date string.
function ymdToUnixUtc(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim())
  if (!m) return NaN
  const y = +m[1], mo = +m[2], d = +m[3]
  const t = Date.UTC(y, mo - 1, d, 0, 0, 0)
  return Math.floor(t / 1000)
}

function formatYmdHuman(s) {
  if (!s) return ''
  const ymd = ymdToUnixUtc(s)
  if (!Number.isFinite(ymd)) return s
  return new Date(ymd * 1000).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
}

/**
 * Decode an naddr1… string into { kind, pubkey, identifier, relays }.
 * Returns null when the input is not an naddr or fails to decode —
 * callers should fall back to "not found" UX.
 */
export function decodeNaddr(naddr) {
  try {
    const { type, data } = nip19.decode(naddr)
    if (type !== 'naddr' || !data) return null
    return data
  } catch {
    return null
  }
}
