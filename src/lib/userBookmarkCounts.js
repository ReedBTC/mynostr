import { getNDK, connectAndWait } from './ndk.js'

/**
 * Count how many items of each target kind a user has bookmarked across
 * their NIP-51 lists (kinds 10003 / 30001 / 30003). Returns deduped totals
 * for:
 *   - notes       — kind 1 ids (from `e` tags or JSON {id, addedAt})
 *   - articles    — kind 30023 refs (from `a` tags "30023:…" or JSON {aTag})
 *   - events      — kind 31923 refs
 *   - listings    — kind 30402 refs
 *
 * Dedup is global across every bookmark list so a note that appears in
 * both "Ungrouped" and a custom category counts once. Returns null on
 * failure so the caller can render "—".
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
    const events = await Promise.race([
      ndk.fetchEvents({ kinds: [10003, 30001, 30003], authors: [pubkey], limit: FETCH_LIMIT }),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 6000)),
    ])

    const notes    = new Set()
    const articles = new Set()
    const events_  = new Set()
    const listings = new Set()

    const bucketForATag = (aTag) => {
      if (typeof aTag !== 'string') return null
      const colon = aTag.indexOf(':')
      if (colon <= 0) return null
      const kind = aTag.slice(0, colon)
      if (kind === '30023') return articles
      if (kind === '31923') return events_
      if (kind === '30402') return listings
      return null
    }

    for (const ev of events) {
      // Skip tombstones (empty replaceable with only a d-tag).
      if (ev.kind !== 10003) {
        const tags = ev.tags || []
        const onlyDTag = tags.length === 1 && tags[0]?.[0] === 'd'
        if (onlyDTag && (!ev.content || ev.content === '')) continue
      }

      for (const t of ev.tags || []) {
        if (t[0] === 'e' && typeof t[1] === 'string' && /^[0-9a-f]{64}$/i.test(t[1])) {
          notes.add(t[1].toLowerCase())
        } else if (t[0] === 'a') {
          const bucket = bucketForATag(t[1])
          if (bucket) bucket.add(t[1])
        }
      }

      try {
        const parsed = JSON.parse(ev.content || '')
        if (Array.isArray(parsed)) {
          for (const it of parsed) {
            if (it?.id && /^[0-9a-f]{64}$/i.test(it.id)) {
              notes.add(it.id.toLowerCase())
            } else if (typeof it?.aTag === 'string') {
              const bucket = bucketForATag(it.aTag)
              if (bucket) bucket.add(it.aTag)
            }
          }
        }
      } catch {}
    }

    return {
      notes:    notes.size,
      articles: articles.size,
      events:   events_.size,
      listings: listings.size,
    }
  } catch {
    return null
  }
}
