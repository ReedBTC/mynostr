import { getNDK, connectAndWait } from './ndk.js'
import { withTimeout } from './utils.js'

/**
 * Count how many items of each target kind a user has bookmarked across
 * their NIP-51 lists (kinds 10003 / 30001 / 30003), plus how many distinct
 * category lists each kind appears in. Returns deduped totals for:
 *   - notes       — kind 1 ids (from `e` tags or JSON {id, addedAt})
 *   - articles    — kind 30023 refs (from `a` tags "30023:…" or JSON {aTag})
 *   - events      — kind 31923 refs
 *   - listings    — kind 30402 refs
 *
 * Item dedup is global so a note in multiple categories counts once. Before
 * counting, replaceable lists are deduped by (kind, d-tag) keeping the newest
 * — older relay copies of a churned list no longer inflate totals. The
 * per-kind `*Categories` numbers count how many distinct surviving lists
 * contain at least one item of that kind, which is the "how organized is
 * this person's curation" signal we show under each cell.
 *
 * Returns null on failure so the caller can render "—".
 */
// Cap the number of bookmark-list events we pull from relays. 10003 is
// unique per user; 30001/30003 are parameterized-replaceable, so a
// heavy-bookmarker might have tens of category lists. 200 is ample and
// prevents a runaway when relays echo many replaceable duplicates.
const FETCH_LIMIT = 200

export async function fetchUserBookmarkCounts(pubkey) {
  if (!pubkey) return null
  const ndk = getNDK()
  try {
    await connectAndWait(ndk, 3000)
    const events = await withTimeout(
      ndk.fetchEvents({ kinds: [10003, 30001, 30003], authors: [pubkey], limit: FETCH_LIMIT }),
      6000,
    )

    // Dedupe replaceable lists to the newest (kind, d-tag) per pair. 10003
    // is user-unique so its d-tag slot is empty-string. Without this, relays
    // returning older churned copies would double-count categories.
    const latestByCatId = new Map() // catId -> ev
    for (const ev of events) {
      const dTag = ev.kind === 10003
        ? ''
        : (ev.tags?.find(t => t[0] === 'd')?.[1] || '')
      const catId = `${ev.kind}:${dTag}`
      const existing = latestByCatId.get(catId)
      if (!existing || ev.created_at > existing.created_at) {
        latestByCatId.set(catId, ev)
      }
    }

    const notes    = new Set()
    const articles = new Set()
    const events_  = new Set()
    const listings = new Set()

    // Per-kind: which category ids contain at least one item of that kind.
    const catIdsWithNotes    = new Set()
    const catIdsWithArticles = new Set()
    const catIdsWithEvents   = new Set()
    const catIdsWithListings = new Set()

    const kindForATag = (aTag) => {
      if (typeof aTag !== 'string') return null
      const colon = aTag.indexOf(':')
      if (colon <= 0) return null
      const kind = aTag.slice(0, colon)
      if (kind === '30023') return 'article'
      if (kind === '31923') return 'event'
      if (kind === '30402') return 'listing'
      return null
    }

    for (const [catId, ev] of latestByCatId) {
      // Skip tombstones (empty replaceable with only a d-tag).
      if (ev.kind !== 10003) {
        const tags = ev.tags || []
        const onlyDTag = tags.length === 1 && tags[0]?.[0] === 'd'
        if (onlyDTag && (!ev.content || ev.content === '')) continue
      }

      let hasNote = false, hasArticle = false, hasEvent = false, hasListing = false

      for (const t of ev.tags || []) {
        if (t[0] === 'e' && typeof t[1] === 'string' && /^[0-9a-f]{64}$/i.test(t[1])) {
          notes.add(t[1].toLowerCase())
          hasNote = true
        } else if (t[0] === 'a') {
          const k = kindForATag(t[1])
          if (k === 'article')  { articles.add(t[1]); hasArticle = true }
          else if (k === 'event')   { events_.add(t[1]);  hasEvent   = true }
          else if (k === 'listing') { listings.add(t[1]); hasListing = true }
        }
      }

      try {
        const parsed = JSON.parse(ev.content || '')
        if (Array.isArray(parsed)) {
          for (const it of parsed) {
            if (it?.id && /^[0-9a-f]{64}$/i.test(it.id)) {
              notes.add(it.id.toLowerCase())
              hasNote = true
            } else if (typeof it?.aTag === 'string') {
              const k = kindForATag(it.aTag)
              if (k === 'article')  { articles.add(it.aTag); hasArticle = true }
              else if (k === 'event')   { events_.add(it.aTag);  hasEvent   = true }
              else if (k === 'listing') { listings.add(it.aTag); hasListing = true }
            }
          }
        }
      } catch {}

      if (hasNote)    catIdsWithNotes.add(catId)
      if (hasArticle) catIdsWithArticles.add(catId)
      if (hasEvent)   catIdsWithEvents.add(catId)
      if (hasListing) catIdsWithListings.add(catId)
    }

    return {
      notes:    notes.size,
      articles: articles.size,
      events:   events_.size,
      listings: listings.size,
      noteCategories:    catIdsWithNotes.size,
      articleCategories: catIdsWithArticles.size,
      eventCategories:   catIdsWithEvents.size,
      listingCategories: catIdsWithListings.size,
    }
  } catch {
    return null
  }
}
