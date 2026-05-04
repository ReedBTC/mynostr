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
import { MIN_LEAD_SECONDS, MAX_FUTURE_SECONDS } from './scheduler.js'

const ONE_HOUR_SEC     = 3600
const ONE_DAY_SEC      = 86400
const FIFTEEN_MIN_SEC  = 15 * 60

/**
 * Round UP to the next 15-minute slot on the wall clock. Works in any
 * IANA timezone because every IANA offset is divisible by 15 minutes
 * (Nepal +5:45 and Newfoundland −3:30 are still grid-aligned), so
 * `ceil(unix / 900)` lands on a wall-clock 15-min boundary regardless
 * of which tz the picker renders in.
 */
function ceilTo15MinSlot(unixSec) {
  return Math.ceil(unixSec / FIFTEEN_MIN_SEC) * FIFTEEN_MIN_SEC
}

/**
 * Compute the publishAt (unix seconds) for a reminder.
 *
 *   • Default: event.start − 24h
 *   • Floor:   the next 15-min slot ≥ MIN_LEAD_SECONDS from now —
 *              same rule the manual scheduler uses, so the prefilled
 *              time always lands cleanly on a TimePicker slot rather
 *              than off-grid (e.g. 1:03 PM → 1:30 PM, 2:59 PM → 3:15 PM).
 *   • Skip:    event is <1h away → return null so the composer opens
 *              with schedule UNCHECKED; user can publish immediately or
 *              manually schedule a tighter window.
 *   • Skip:    publishAt would exceed the scheduler's 1-year horizon →
 *              return null. User can come back closer to the event.
 */
export function computeReminderPublishAt(parsed, nowSec = Math.floor(Date.now() / 1000)) {
  if (!parsed || !Number.isFinite(parsed.startUnix)) return null
  if (parsed.startUnix < nowSec + ONE_HOUR_SEC) return null
  const dayBefore = parsed.startUnix - ONE_DAY_SEC
  const minSlot   = ceilTo15MinSlot(nowSec + MIN_LEAD_SECONDS)
  // Snap the final candidate too, so an off-grid event time (e.g. an
  // event at 5:03 PM) still produces a grid-aligned reminder time.
  const candidate = ceilTo15MinSlot(Math.max(dayBefore, minSlot))
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
