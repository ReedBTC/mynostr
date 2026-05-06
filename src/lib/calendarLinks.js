/**
 * Calendar deep-link builders for kind 31922 / 31923 NIP-52 events.
 * Each builder returns a URL that pops the user's calendar provider's
 * event-create form pre-filled with the event details — the provider
 * confirms the add, we don't silently insert.
 *
 * Coverage:
 *   • Google Calendar — calendar.google.com/calendar/render?action=TEMPLATE&...
 *   • Outlook Live    — outlook.live.com/calendar/0/deeplink/compose?...
 *   • Apple / Thunderbird / Fantastical / etc. — the .ics download path
 *     in lib/ics.js handles every RFC 5545-aware client uniformly.
 *
 * Description content mirrors what ics.js emits (summary + content
 * joined by a blank line) so the same payload lands regardless of which
 * path the user takes. Capped at 1024 chars so the resulting URL stays
 * well under the ~2KB practical limit browsers and providers enforce.
 *
 * Time handling: for kind 31923 (time-based) events we emit UTC stamps
 * — both providers display in the user's local zone automatically. For
 * kind 31922 (all-day, date-based) we use the provider's date-only
 * format with the spec-mandated exclusive end (NIP-52 stores the
 * inclusive last day, so we add one day for the URL).
 */

const DESC_CAP = 1024
const DEFAULT_TIME_DURATION_HOURS = 1

function pad2(n) { return String(n).padStart(2, '0') }

// Google Calendar's `dates=` for all-day: YYYYMMDD/YYYYMMDD (end exclusive)
function compactDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim())
  return m ? `${m[1]}${m[2]}${m[3]}` : ''
}

// Google's `dates=` for time-based: YYYYMMDDTHHMMSSZ/YYYYMMDDTHHMMSSZ
function compactUtcStamp(date) {
  return (
    `${date.getUTCFullYear()}` +
    `${pad2(date.getUTCMonth() + 1)}` +
    `${pad2(date.getUTCDate())}` +
    `T${pad2(date.getUTCHours())}` +
    `${pad2(date.getUTCMinutes())}` +
    `${pad2(date.getUTCSeconds())}Z`
  )
}

// Outlook's `startdt`/`enddt` for time-based: ISO 8601 with seconds.
function isoUtcStamp(date) {
  return (
    `${date.getUTCFullYear()}-` +
    `${pad2(date.getUTCMonth() + 1)}-` +
    `${pad2(date.getUTCDate())}` +
    `T${pad2(date.getUTCHours())}:` +
    `${pad2(date.getUTCMinutes())}:` +
    `${pad2(date.getUTCSeconds())}Z`
  )
}

// "YYYY-MM-DD" → next day in same format. UTC arithmetic so DST or
// timezone offsets can't drift the result.
function nextDayIso(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || '').trim())
  if (!m) return ''
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3] + 1)
  const d = new Date(utc)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

function nextDayCompact(ymd) {
  return compactDate(nextDayIso(ymd))
}

function buildDescription(parsed) {
  const text = [parsed?.summary, parsed?.content].filter(Boolean).join('\n\n')
  if (!text) return ''
  return text.length > DESC_CAP ? text.slice(0, DESC_CAP - 1) + '…' : text
}

/**
 * Google Calendar event-create URL.
 * @returns {string} url, or '' if start time can't be derived.
 */
export function buildGoogleCalendarUrl(parsed) {
  if (!parsed) return ''
  const params = new URLSearchParams({ action: 'TEMPLATE' })
  if (parsed.title) params.set('text', parsed.title)

  let dates = ''
  if (parsed.isDateBased) {
    const start = compactDate(parsed.start)
    const end = parsed.end
      ? nextDayCompact(parsed.end)
      : (parsed.start ? nextDayCompact(parsed.start) : '')
    if (start && end) dates = `${start}/${end}`
  } else if (Number.isFinite(parsed.startUnix)) {
    const startDate = new Date(parsed.startUnix * 1000)
    const endDate = Number.isFinite(parsed.endUnix)
      ? new Date(parsed.endUnix * 1000)
      : new Date(parsed.startUnix * 1000 + DEFAULT_TIME_DURATION_HOURS * 3600 * 1000)
    dates = `${compactUtcStamp(startDate)}/${compactUtcStamp(endDate)}`
  }
  if (!dates) return ''
  params.set('dates', dates)

  const description = buildDescription(parsed)
  if (description) params.set('details', description)
  if (parsed.location) params.set('location', parsed.location)

  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

/**
 * Outlook Live (Microsoft 365 / Outlook.com) event-create URL.
 * @returns {string} url, or '' if start time can't be derived.
 */
export function buildOutlookCalendarUrl(parsed) {
  if (!parsed) return ''
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru:  'addevent',
  })
  if (parsed.title) params.set('subject', parsed.title)

  let startSet = false
  if (parsed.isDateBased) {
    const start = parsed.start
    const end = parsed.end
      ? nextDayIso(parsed.end)
      : (start ? nextDayIso(start) : '')
    if (start && end) {
      params.set('startdt', start)
      params.set('enddt',   end)
      params.set('allday',  'true')
      startSet = true
    }
  } else if (Number.isFinite(parsed.startUnix)) {
    const startDate = new Date(parsed.startUnix * 1000)
    const endDate = Number.isFinite(parsed.endUnix)
      ? new Date(parsed.endUnix * 1000)
      : new Date(parsed.startUnix * 1000 + DEFAULT_TIME_DURATION_HOURS * 3600 * 1000)
    params.set('startdt', isoUtcStamp(startDate))
    params.set('enddt',   isoUtcStamp(endDate))
    startSet = true
  }
  if (!startSet) return ''

  const description = buildDescription(parsed)
  if (description) params.set('body', description)
  if (parsed.location) params.set('location', parsed.location)

  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`
}
