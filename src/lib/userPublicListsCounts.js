/**
 * Count a user's public *named* lists — Calendars (kind 31924) and
 * Marketplace Collections (kind 30405) — alongside the total number
 * of items referenced inside each.
 *
 * Distinct from `userBookmarkCounts.js`:
 *   - Bookmarks (NIP-51 kinds 10003 / 30001 / 30003) are private-to-
 *     curate / public-to-share lists of arbitrary refs across kinds.
 *   - Calendars and Collections are durable public-curation surfaces
 *     specific to one module — they ARE the public face of "what this
 *     user has organized for the public to discover."
 *
 * Returns:
 *   {
 *     calendarLists:    number,   // how many kind 31924 events
 *     calendarItems:    number,   // distinct event refs across them
 *     collectionLists:  number,   // how many kind 30405 events
 *     collectionItems:  number,   // distinct product refs across them
 *   }
 *
 * `null` on failure so the caller can render "—" in cells.
 */
import { getNDK, connectAndWait } from './ndk.js'
import { withTimeout } from './utils.js'

const KIND_CALENDAR        = 31924
const KIND_COLLECTION      = 30405
const KIND_DATE_EVENT      = 31922
const KIND_TIME_EVENT      = 31923
const KIND_PRODUCT         = 30402
const FETCH_LIMIT          = 200
const FETCH_TIMEOUT_MS     = 6000

export async function fetchUserPublicListsCounts(pubkey) {
  if (!pubkey) return null
  const ndk = getNDK()
  try {
    await connectAndWait(ndk, 3000)
    // One round-trip for both kinds — relays don't care about the union
    // and we save a wall-clock RTT compared to two parallel fetches.
    const events = await withTimeout(
      ndk.fetchEvents({
        kinds: [KIND_CALENDAR, KIND_COLLECTION],
        authors: [pubkey],
        limit: FETCH_LIMIT,
      }),
      FETCH_TIMEOUT_MS,
    )

    // Replaceable lists — dedupe by (kind, d-tag), keep newest. Without
    // this, a relay echoing older churned copies of a calendar inflates
    // the list count.
    const latestByListId = new Map()
    for (const ev of events) {
      const dTag = ev.tags?.find(t => t[0] === 'd')?.[1] || ''
      if (!dTag) continue   // d-tag is mandatory on these kinds; skip malformed
      const id = `${ev.kind}:${dTag}`
      const existing = latestByListId.get(id)
      if (!existing || (ev.created_at || 0) > (existing.created_at || 0)) {
        latestByListId.set(id, ev)
      }
    }

    let calendarLists    = 0
    let collectionLists  = 0
    const calendarItems   = new Set()  // dedupes events that appear in >1 calendar
    const collectionItems = new Set()  // dedupes products in >1 collection

    for (const [, ev] of latestByListId) {
      const tags = ev.tags || []
      // Skip tombstones — a list that's been emptied still occupies a
      // d-tag slot but shouldn't count toward "lists you maintain."
      // Heuristic: only a `d` tag and empty content. Calendars often
      // also keep `title` / `image`, so a list with just chrome but no
      // refs is treated as a real list (the user explicitly created it).
      const onlyDTag = tags.length === 1 && tags[0]?.[0] === 'd'
      if (onlyDTag && (!ev.content || ev.content === '')) continue

      if (ev.kind === KIND_CALENDAR) {
        calendarLists++
        for (const t of tags) {
          if (t[0] !== 'a' || typeof t[1] !== 'string') continue
          if (t[1].startsWith(`${KIND_DATE_EVENT}:`) ||
              t[1].startsWith(`${KIND_TIME_EVENT}:`)) {
            calendarItems.add(t[1])
          }
        }
      } else if (ev.kind === KIND_COLLECTION) {
        collectionLists++
        for (const t of tags) {
          if (t[0] !== 'a' || typeof t[1] !== 'string') continue
          if (t[1].startsWith(`${KIND_PRODUCT}:`)) {
            collectionItems.add(t[1])
          }
        }
      }
    }

    return {
      calendarLists,
      calendarItems:    calendarItems.size,
      collectionLists,
      collectionItems:  collectionItems.size,
    }
  } catch {
    return null
  }
}
