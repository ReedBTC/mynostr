import { fetchUserStats as fetchPrimalStats } from './primal.js'
import { getNDK, connectAndWait } from './ndk.js'

/**
 * Aggregate profile stats (notes, replies, followers, follows, …) for a
 * user. The Primal cache's `user_profile` op returns a kind 10000105
 * "UserStats" event whose content is the full stats object — that's the
 * primary source.
 *
 * For extra robustness on follows_count, we also fetch the user's latest
 * kind 3 contacts event in parallel and count p-tags. Primal's own number
 * and the kind 3 p-tag count should match; when Primal's index lags or
 * returns null, the kind 3 count fills in.
 */
export async function fetchAggregateUserStats(pubkey) {
  if (!pubkey) return null

  const ndk = getNDK()
  connectAndWait(ndk, 3000).catch(() => {})  // best-effort, don't block

  const [primalStats, contactsEvent] = await Promise.all([
    fetchPrimalStats(pubkey).catch(() => null),
    fetchLatestContacts(ndk, pubkey),
  ])

  const stats = { ...(primalStats || {}) }

  // Use kind-3 p-tag count only as a fallback when Primal didn't return a
  // follows_count at all. Primal caches the latest kind 3 across its entire
  // relay fleet, which is typically fresher than whatever one or two relays
  // our NDK pool happened to reach — blindly preferring kind 3 can replace
  // an accurate 5k-follow count with a stale 0 from a half-synced relay.
  if (contactsEvent && stats.follows_count == null) {
    const ps = new Set()
    for (const t of contactsEvent.tags || []) {
      if (t[0] === 'p' && t[1]) ps.add(t[1])
    }
    stats.follows_count = ps.size
  }

  return Object.keys(stats).length > 0 ? stats : null
}

async function fetchLatestContacts(ndk, pubkey) {
  try {
    return await Promise.race([
      ndk.fetchEvent({ kinds: [3], authors: [pubkey] }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
    ])
  } catch {
    return null
  }
}
