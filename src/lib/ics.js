/**
 * .ics file builder for NIP-52 calendar events.
 *
 * Produces RFC 5545 (iCalendar) output compatible with Google Calendar,
 * Apple Calendar, Outlook, Fantastical, etc. Two flavors based on the
 * source event's kind:
 *
 *   31922 (date-based)   → DTSTART;VALUE=DATE:YYYYMMDD
 *                          DTEND;VALUE=DATE:YYYYMMDD (exclusive end)
 *   31923 (time-based)   → DTSTART:YYYYMMDDTHHMMSSZ (UTC stamp)
 *                          DTEND:YYYYMMDDTHHMMSSZ
 *
 * The UID is derived from the event's addressable coordinate so adding
 * the same event twice (or re-adding after the host edits it) lets the
 * user's calendar app DTSTAMP-match and update in place rather than
 * creating duplicates.
 *
 * Why we don't emit a TZID: the source data is already epoch seconds
 * (kind 31923), so emitting in UTC is unambiguous and avoids dragging
 * in a VTIMEZONE block. Calendar apps display UTC times in the user's
 * local zone automatically. For date-based events we stay tz-naive.
 */
import { titleToSlug } from './utils.js'

const PRODID = '-//mynostr//Events//EN'

/**
 * Build a complete .ics document (one VEVENT inside a VCALENDAR) from
 * a parsed calendar event. Returns the raw text — caller decides what
 * to do with it (Blob+download, Web Share API, etc).
 */
export function buildEventIcs(parsed) {
  if (!parsed) return ''
  const lines = []
  lines.push('BEGIN:VCALENDAR')
  lines.push('VERSION:2.0')
  lines.push(`PRODID:${PRODID}`)
  lines.push('CALSCALE:GREGORIAN')
  lines.push('METHOD:PUBLISH')
  lines.push('BEGIN:VEVENT')

  // UID — addressable coordinate keeps repeat-imports idempotent.
  // Falls back to the event id if the coordinate isn't reconstructible.
  const uid = (parsed.kind && parsed.pubkey && parsed.dTag)
    ? `${parsed.kind}-${parsed.pubkey}-${parsed.dTag}@mynostr`
    : `${parsed.id || 'unknown'}@mynostr`
  lines.push(`UID:${uid}`)

  // DTSTAMP — when this .ics was generated. Required by RFC 5545.
  lines.push(`DTSTAMP:${formatUtcStamp(new Date())}`)

  // SUMMARY (title) and DESCRIPTION (content)
  if (parsed.title) lines.push(`SUMMARY:${escapeText(parsed.title)}`)
  const description = [parsed.summary, parsed.content].filter(Boolean).join('\n\n')
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`)

  // LOCATION — free-form, capped to a sensible length so CRLF folding
  // doesn't go wild on a pathological 2KB venue blurb.
  if (parsed.location) {
    const loc = parsed.location.length > 500 ? parsed.location.slice(0, 500) : parsed.location
    lines.push(`LOCATION:${escapeText(loc)}`)
  }

  // GEO — semicolon-separated lat;lon. Decode geohash if present.
  if (parsed.geohash) {
    const coords = decodeGeohashLatLon(parsed.geohash)
    if (coords) {
      lines.push(`GEO:${coords.lat.toFixed(6)};${coords.lon.toFixed(6)}`)
    }
  }

  // CATEGORIES — joined hashtags
  if (Array.isArray(parsed.hashtags) && parsed.hashtags.length > 0) {
    lines.push(`CATEGORIES:${parsed.hashtags.map(escapeText).join(',')}`)
  }

  // ATTENDEE rows — one per p-tag participant. Use a synthetic mailto
  // since we have pubkeys, not emails; CN carries the role if present.
  for (const p of parsed.participants || []) {
    if (!p?.pubkey) continue
    const cn = p.role ? p.role : 'attendee'
    lines.push(`ATTENDEE;CN=${escapeParam(cn)}:nostr:${p.pubkey}`)
  }

  // Date / time block. Date-based events use VALUE=DATE; time-based
  // emit UTC stamps. End is optional in NIP-52 — if missing, omit
  // DTEND and let the calendar app default to a 1-hour block.
  if (parsed.isDateBased) {
    const startYmd = ymdCompact(parsed.start)
    if (startYmd) lines.push(`DTSTART;VALUE=DATE:${startYmd}`)
    if (parsed.end) {
      // RFC 5545 DTEND for VALUE=DATE is *exclusive*. NIP-52 stores
      // the inclusive last day, so add one day for the .ics.
      const endYmd = addOneDay(parsed.end)
      if (endYmd) lines.push(`DTEND;VALUE=DATE:${endYmd}`)
    }
  } else {
    if (Number.isFinite(parsed.startUnix)) {
      lines.push(`DTSTART:${formatUtcStamp(new Date(parsed.startUnix * 1000))}`)
    }
    if (Number.isFinite(parsed.endUnix)) {
      lines.push(`DTEND:${formatUtcStamp(new Date(parsed.endUnix * 1000))}`)
    }
  }

  lines.push('END:VEVENT')
  lines.push('END:VCALENDAR')

  // RFC 5545 mandates CRLF line endings + soft-folding at 75 octets.
  return lines.flatMap(foldLine).join('\r\n') + '\r\n'
}

/**
 * Trigger a browser download of the .ics. Filename derived from the
 * event title.
 */
export function downloadEventIcs(parsed) {
  if (!parsed) return
  const text = buildEventIcs(parsed)
  if (!text) return
  const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const slug = titleToSlug(parsed.title) || 'event'
  const a = document.createElement('a')
  a.href = url
  a.download = `${slug}.ics`
  a.click()
  // Revoke after a tick — Safari is twitchy about revoking before the
  // download actually fires.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ── Helpers ───────────────────────────────────────────────────────────

// RFC 5545 TEXT escape: backslash, semicolon, comma, newline. We
// strip carriage returns rather than escaping them — most calendar
// apps treat \r\n line breaks as one logical break, and emitting
// `\r\n` as `\\r\\n` produces empty visible lines in some parsers.
// Stripping is the simpler spec-compliant path.
function escapeText(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
}

// Param-value escape — only needs CN-style parameters; commas and
// semicolons get quoted.
function escapeParam(s) {
  const v = String(s)
  return /[,;:]/.test(v) ? `"${v.replace(/"/g, '')}"` : v
}

// Wrap to 75 octets per RFC 5545. Continuation lines start with a
// space. Folds the UTF-8 byte stream, never splitting a multi-byte
// rune in half — emoji + accented chars + CJK in titles/descriptions
// would otherwise produce invalid UTF-8 and crash strict parsers.
const ICS_ENCODER = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null
const ICS_DECODER = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null
function foldLine(line) {
  if (!ICS_ENCODER || !ICS_DECODER) {
    // Pre-Node-18 / pre-ES2017 environments — fall back to char fold.
    if (line.length <= 75) return [line]
    const out = []
    let rest = line
    out.push(rest.slice(0, 75)); rest = rest.slice(75)
    while (rest.length > 74) { out.push(' ' + rest.slice(0, 74)); rest = rest.slice(74) }
    if (rest.length > 0) out.push(' ' + rest)
    return out
  }
  const bytes = ICS_ENCODER.encode(line)
  if (bytes.length <= 75) return [line]
  const out = []
  let cursor = 0
  let isFirst = true
  while (cursor < bytes.length) {
    const limit = isFirst ? 75 : 74
    let end = Math.min(cursor + limit, bytes.length)
    // Walk back to a UTF-8 char boundary if we landed mid-rune. UTF-8
    // continuation bytes match 10xxxxxx (0x80–0xBF); leading bytes are
    // either 0xxxxxxx or 11xxxxxx. Step back until we're on a leading
    // byte, then end the chunk before it.
    if (end < bytes.length) {
      while (end > cursor && (bytes[end] & 0xC0) === 0x80) end--
    }
    const chunk = bytes.slice(cursor, end)
    out.push((isFirst ? '' : ' ') + ICS_DECODER.decode(chunk))
    cursor = end
    isFirst = false
  }
  return out
}

// Date → "YYYYMMDDTHHMMSSZ"
function formatUtcStamp(date) {
  const y = date.getUTCFullYear()
  const mo = pad2(date.getUTCMonth() + 1)
  const d = pad2(date.getUTCDate())
  const h = pad2(date.getUTCHours())
  const mi = pad2(date.getUTCMinutes())
  const s = pad2(date.getUTCSeconds())
  return `${y}${mo}${d}T${h}${mi}${s}Z`
}

// "YYYY-MM-DD" → "YYYYMMDD"
function ymdCompact(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim())
  return m ? `${m[1]}${m[2]}${m[3]}` : ''
}

// "YYYY-MM-DD" → next day's "YYYYMMDD" (UTC arithmetic, avoids tz drift)
function addOneDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim())
  if (!m) return ''
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3] + 1)
  const d = new Date(utc)
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`
}

function pad2(n) { return String(n).padStart(2, '0') }

// Minimal geohash → {lat, lon} center decoder. Mirrors nominatim.js's
// encodeGeohash so a round-trip lands close to the input. 9-char
// precision = ~2.4m accuracy.
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'
function decodeGeohashLatLon(hash) {
  const s = String(hash || '').trim().toLowerCase()
  if (!s) return null
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180
  let evenBit = true
  for (const ch of s) {
    const idx = BASE32.indexOf(ch)
    if (idx < 0) return null
    for (let i = 4; i >= 0; i--) {
      const bit = (idx >> i) & 1
      if (evenBit) {
        const mid = (lonMin + lonMax) / 2
        if (bit) lonMin = mid; else lonMax = mid
      } else {
        const mid = (latMin + latMax) / 2
        if (bit) latMin = mid; else latMax = mid
      }
      evenBit = !evenBit
    }
  }
  return { lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2 }
}
