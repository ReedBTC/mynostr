/**
 * NIP-52 calendar list (kind 31924) encode / decode.
 *
 * A calendar list is a curated grouping of calendar events — each
 * `a`-tag points to a kind 31922 or 31923 event by coordinate. Same
 * shape as marketplace gamma collections but with NIP-52 event refs
 * instead of product refs.
 *
 * Replaceable per (kind 31924, pubkey, dTag). Updating a calendar
 * republishes at the same dTag; relays replace the prior copy.
 */
import { CLIENT_TAG } from './brand.js'
import { isSafeUrl } from './utils.js'
import { KIND_DATE_EVENT, KIND_TIME_EVENT } from './eventTypes.js'

export const KIND_CALENDAR = 31924

/**
 * Build the addressable coordinate for a calendar.
 *   "31924:<authorpk>:<dtag>"
 */
export function buildCalendarCoord(pubkey, dTag) {
  if (!pubkey || !dTag) return ''
  return `${KIND_CALENDAR}:${pubkey}:${dTag}`
}

/**
 * Encode a UI-shape calendar into the publish-ready event template.
 *
 * @param {object} form
 *   {
 *     dTag: string,                  // required
 *     title: string,                 // required
 *     summary?: string,
 *     image?: string,
 *     eventRefs?: string[],          // ["31923:pk:dtag", ...]
 *     _extraTags?: string[][],       // pass-through unrecognized tags
 *   }
 */
export function encodeCalendar(form) {
  if (!form?.dTag) throw new Error('Calendar dTag required')
  if (!form?.title) throw new Error('Calendar title required')

  const tags = []
  tags.push(['d', String(form.dTag)])
  tags.push(['title', String(form.title).trim()])
  if (form.summary?.trim()) tags.push(['summary', form.summary.trim()])
  if (form.image && isSafeUrl(form.image)) tags.push(['image', form.image])

  for (const ref of form.eventRefs || []) {
    if (typeof ref !== 'string') continue
    if (!isCalendarEventCoord(ref)) continue
    tags.push(['a', ref])
  }

  // Pass-through: preserve tags from foreign clients we don't recognize.
  for (const t of form._extraTags || []) {
    if (Array.isArray(t) && t.length > 0) tags.push(t)
  }

  tags.push(['client', CLIENT_TAG])

  return {
    kind: KIND_CALENDAR,
    content: '',
    tags,
  }
}

// URL-safe dTag charset. Foreign clients can publish kind-31924 with
// arbitrary dTag content (slashes, spaces, encoded entities); our
// routing puts dTags inline in the path as `cal-<dTag>` and React
// Router's path matching doesn't survive a `/` inside the dTag.
// Reject non-conforming dTags at decode time so foreign calendars
// with unsafe ids simply don't appear in the list — better than a
// half-broken click on the calendars tab.
//
// Conservative pattern: alphanumerics + the unreserved RFC 3986 set
// (._~-). Anything else → reject.
const SAFE_DTAG_PATTERN = /^[A-Za-z0-9._~-]+$/
const MAX_DTAG_LENGTH = 256

/**
 * Decode a kind 31924 event into the UI-shape calendar.
 * Returns null if the event isn't a valid calendar list, or if its
 * dTag contains characters that aren't safe to put in a URL.
 *
 * Returned shape:
 *   {
 *     dTag, title, summary, image, eventRefs, _extraTags
 *   }
 */
export function decodeCalendar(ev) {
  if (!ev || ev.kind !== KIND_CALENDAR) return null
  const tags = ev.tags || []
  const get = (name) => tags.find(t => t[0] === name)?.[1] || ''
  const all = (name) => tags.filter(t => t[0] === name && typeof t[1] === 'string').map(t => t[1])

  const dTag = get('d')
  if (!dTag) return null
  if (dTag.length > MAX_DTAG_LENGTH || !SAFE_DTAG_PATTERN.test(dTag)) return null
  const title = get('title')
  if (!title) return null

  const eventRefs = []
  for (const ref of all('a')) {
    if (isCalendarEventCoord(ref)) eventRefs.push(ref)
  }

  // Stash unrecognized tags for round-trip preservation. Don't carry
  // forward d/title/summary/image/a/client — those are recognized and
  // re-emitted from the form.
  const recognized = new Set(['d', 'title', 'summary', 'image', 'a', 'client'])
  const extraTags = tags.filter(t => Array.isArray(t) && t[0] && !recognized.has(t[0]))

  return {
    dTag,
    title,
    summary: get('summary'),
    image: get('image'),
    eventRefs,
    _extraTags: extraTags,
  }
}

/**
 * "31922:<pk>:<dtag>" or "31923:<pk>:<dtag>" — the only `a` tag values
 * we accept on a calendar list. Filters out marketplace coords, naddrs
 * for kinds we don't support, and other junk.
 */
export function isCalendarEventCoord(ref) {
  if (typeof ref !== 'string') return false
  const m = /^(\d+):([0-9a-f]{64}):(.+)$/i.exec(ref)
  if (!m) return false
  const kind = parseInt(m[1], 10)
  return kind === KIND_DATE_EVENT || kind === KIND_TIME_EVENT
}
