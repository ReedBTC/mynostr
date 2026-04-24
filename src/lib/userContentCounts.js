import { getNDK, connectAndWait } from './ndk.js'
import { withTimeout } from './utils.js'

/**
 * Count a user's authored content across the parameterized-replaceable
 * kinds our modules care about (articles, events, marketplace listings).
 * Primal's stats event only tracks kind 1 / follow counts, so for these we
 * pull directly from the user's write relays via NDK.
 *
 * All three kinds are parameterized-replaceable (NIP-33), so we dedupe by
 * d-tag before counting — multiple relay copies of the same article under
 * the same d-tag would otherwise be counted twice.
 *
 * Returns null on error so the caller can render "—" without special-casing.
 */
// Per-kind soft cap on how many events we ask relays to return. Most users
// have fewer than a hundred of each; a power-user with thousands still gets
// an approximate count and we stay bounded. The UI treats these as counts,
// not a catalog, so partial is fine.
const FETCH_LIMIT = 500

export async function fetchUserContentCounts(pubkey) {
  if (!pubkey) return null
  const ndk = getNDK()
  try {
    await connectAndWait(ndk, 3000)
    const events = await withTimeout(
      ndk.fetchEvents({
        kinds: [30023, 31923, 30402],
        authors: [pubkey],
        limit: FETCH_LIMIT,
      }),
      6000,
    )
    const dTagsByKind = {
      30023: new Set(),  // long-form articles
      31923: new Set(),  // calendar events
      30402: new Set(),  // marketplace listings
    }
    for (const ev of events) {
      const bucket = dTagsByKind[ev.kind]
      if (!bucket) continue
      const d = ev.tags?.find(t => t[0] === 'd')?.[1] || ev.id
      bucket.add(d)
    }
    return {
      articles: dTagsByKind[30023].size,
      events:   dTagsByKind[31923].size,
      listings: dTagsByKind[30402].size,
    }
  } catch {
    return null
  }
}
