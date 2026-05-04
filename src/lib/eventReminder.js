/**
 * eventReminder — prefill helpers for the "Schedule reminder" flow on
 * NIP-52 calendar events. Builds a kind 1 note that quotes the event
 * naddr and is pre-scheduled for ~24h before the event.
 *
 * The prefill flows through NotesModule's `composerPrefill` router
 * state (see NotesModule.jsx) and lands on NoteComposer which auto-
 * toggles schedule mode when `snapshot.publishAt` is in the future.
 */
import { formatEventTime } from './eventTypes.js'
import { MAX_FUTURE_SECONDS } from './scheduler.js'

const ONE_HOUR_SEC = 3600
const ONE_DAY_SEC  = 86400

/**
 * Compute the publishAt (unix seconds) for a reminder.
 *
 *   • Default: event.start − 24h
 *   • Floor:   now + 1h  (so we always schedule a meaningful distance out)
 *   • Skip:    event is <1h away → return null so the composer opens
 *              with schedule UNCHECKED; user can publish immediately or
 *              manually schedule a tighter window.
 *   • Skip:    publishAt would exceed the scheduler's 1-year horizon →
 *              return null. User can come back closer to the event.
 */
export function computeReminderPublishAt(parsed, nowSec = Math.floor(Date.now() / 1000)) {
  if (!parsed || !Number.isFinite(parsed.startUnix)) return null
  const oneHourFromNow = nowSec + ONE_HOUR_SEC
  if (parsed.startUnix < oneHourFromNow) return null
  const dayBefore = parsed.startUnix - ONE_DAY_SEC
  const candidate = Math.max(dayBefore, oneHourFromNow)
  if (candidate > nowSec + MAX_FUTURE_SECONDS) return null
  return candidate
}

/**
 * Build the body text. The naddr is NOT inlined — it flows separately
 * via `quoteInput` so the composer renders it as a structured embedded
 * card and emits a proper q-tag on publish.
 *
 * Example outputs:
 *   "Reminder: Bitcoin Park Meetup — Tue, May 5, 2026 · 7:00 PM CDT · Nashville"
 *   "Reminder: Family Reunion — Sat, Jun 6, 2026"
 */
export function buildReminderBody(parsed) {
  if (!parsed) return ''
  const title = (parsed.title || '').trim() || 'this event'
  const when  = formatEventTime(parsed)
  const where = (parsed.location || '').trim()
  // Title joined to the meta block by em-dash; meta fields joined by
  // middle dot. Skip the em-dash entirely when there's no meta.
  const meta = [when, where].filter(Boolean).join(' · ')
  return meta ? `Reminder: ${title} — ${meta}` : `Reminder: ${title}`
}

/**
 * Build the full prefill payload for NotesModule's composerPrefill state.
 * Returns null if the event lacks an naddr (no quote possible) — caller
 * should hide the menu item in that case.
 *
 * Time-based events forward their start_tzid as `tzid` so the composer's
 * timezone selector reads the event's own zone — keeps the schedule UI
 * aligned with the reminder body's "starts at <event tz time>" framing.
 * Date-based (kind 31922) events have no timezone, so the composer falls
 * back to browser-local.
 */
export function buildReminderPrefill(parsed) {
  if (!parsed?.naddr) return null
  const publishAt = computeReminderPublishAt(parsed)
  const tzid = (!parsed.isDateBased && parsed.startTzid) ? parsed.startTzid : null
  return {
    quote:   parsed.naddr,
    content: buildReminderBody(parsed),
    ...(publishAt && { publishAt }),
    ...(tzid && { tzid }),
  }
}
