/**
 * useListingProfiles — batch-fetch kind-0 profiles for the authors of
 * a list of marketplace listings (or any { event } shape).
 *
 * Returns a Map<pubkey, profile>. Profiles get added as they resolve;
 * unresolved authors render an "Anonymous" placeholder until the
 * Primal cache returns. Using fetchProfiles (Primal user_infos) for
 * the ranked-by-followers + bulk shape — same source the rest of the
 * app uses. Fast path: Primal cache hits the in-memory dedupe map
 * regardless of how many tabs are calling this concurrently.
 *
 * Why a single hook for SellingTab / CollectionView / SearchTab:
 * each was about to grow its own fetch+cache code. Centralizing
 * keeps the lookup behavior consistent (same fallback shape, same
 * error handling) and the cache accumulates across re-fetches —
 * scrolling a search feed doesn't re-query authors we've already
 * resolved.
 */
import { useEffect, useMemo, useState } from 'react'
import { fetchProfiles } from './primal.js'

// Soft cap on the profile cache to prevent unbounded growth on long
// sessions (deep search-feed scrolling, browsing many sellers, etc.).
// At ~200 bytes per profile this is ~100 KB worst case — generous
// for the working set, tight enough that it's not a memory concern.
// Eviction is FIFO by Map insertion order (Map preserves insertion
// order in modern JS), trimming back to MAX whenever we cross it.
const PROFILE_CACHE_MAX = 500

export function useListingProfiles(listings) {
  const [profileMap, setProfileMap] = useState(() => new Map())

  // Stable string key over the unique pubkey set so the effect only
  // re-runs when the *set* of authors changes — not when listings
  // re-orders (sort changes), filters apply, or pagination appends
  // events whose authors we already know.
  const pubkeysKey = useMemo(() => {
    const set = new Set()
    for (const l of (listings || [])) {
      const pk = l?.event?.pubkey
      if (pk) set.add(pk)
    }
    return Array.from(set).sort().join('|')
  }, [listings])

  useEffect(() => {
    if (!pubkeysKey) return
    const pubkeys = pubkeysKey.split('|').filter(Boolean)
    if (pubkeys.length === 0) return
    let cancelled = false
    fetchProfiles(pubkeys).then(fetched => {
      if (cancelled) return
      setProfileMap(prev => {
        // Merge new entries over existing — repeated lookups for
        // already-cached pubkeys are a no-op in the resulting Map but
        // we always replace with the latest fetched record (cache may
        // have refreshed metadata since last call).
        const next = new Map(prev)
        for (const [k, v] of fetched) next.set(k, v)
        // FIFO trim back to MAX. Map iteration is insertion order, so
        // shifting the head drops the oldest entries first.
        if (next.size > PROFILE_CACHE_MAX) {
          const overflow = next.size - PROFILE_CACHE_MAX
          const iter = next.keys()
          for (let i = 0; i < overflow; i++) {
            const oldest = iter.next().value
            if (oldest === undefined) break
            next.delete(oldest)
          }
        }
        return next
      })
    }).catch(() => {
      // Silent — profiles are nice-to-have; rendering falls back to
      // the "Anonymous + truncated pubkey" path when missing.
    })
    return () => { cancelled = true }
  }, [pubkeysKey])

  return profileMap
}
