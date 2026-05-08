/**
 * useMarketSearch — relay fetch + client-side post-filter for the
 * marketplace Search tab.
 *
 * Strategy:
 *   • Relay-side filter handles {kinds, authors, #t, until, limit}.
 *     Cheap and scalable; relays answer with already-narrowed sets.
 *   • Everything else — keyword, price range, currency, NSFW, status,
 *     visibility — is client-side over whatever the relays returned.
 *     Filters that change the relay-side query trigger a fresh fetch;
 *     filters that change only client-side just re-derive the
 *     displayed list (useMemo).
 *
 * Relay set: user's kind-10002 read relays (fresh fetch — same reason
 * as the publish/delete paths) ∪ DEFAULT_MARKETPLACE_RELAYS, deduped.
 *
 * Pagination: cursor on `until` (oldest loaded `created_at` in the
 * accumulated set). Each loadMore fires a new REQ with that cursor.
 * `hasMore` is heuristic — assume more exists if we got a full page;
 * stop when a page comes back smaller than the requested limit.
 *
 * Cancellation: stale fetches (filter changed mid-flight) are
 * discarded by ID before they touch state. No AbortController because
 * NDK's fetchEvents doesn't accept one — the in-flight relay sub
 * lives a few more seconds before timing out, but its result lands in
 * a setEvents that gets ignored.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { NDKRelaySet } from '@nostr-dev-kit/ndk'
import { getNDK } from './ndk.js'
import { withTimeout } from './utils.js'
import { KIND_PRODUCT, decodeProduct } from './gamma.js'
import { DEFAULT_MARKETPLACE_RELAYS } from './marketplaceRelays.js'

const PAGE_SIZE = 60
const FETCH_TIMEOUT_MS = 8000

// Fetch the user's kind-10002 read relays. Fresh, like the
// write-relay path — NDK's cached relayList() can be stale and
// for a discovery feed we want to query the user's actual
// current configuration. Read-marked + unmarked entries count
// (NIP-65: missing marker means both read and write).
async function fetchReadRelays(ndk, pubkey) {
  if (!ndk || !pubkey) return []
  try {
    const ev = await withTimeout(
      ndk.fetchEvent({ kinds: [10002], authors: [pubkey] }),
      5000,
      'fetch-10002-timeout',
    )
    if (!ev) return []
    return (ev.tags || [])
      .filter(t => t[0] === 'r' && (!t[2] || t[2] === 'read'))
      .map(t => t[1])
      .filter(u => typeof u === 'string' && /^wss:\/\//i.test(u))
  } catch {
    return []
  }
}

// Dedup events by (pubkey, dTag), keep latest by created_at.
// Replaceable kind 30402 — multiple relays may serve different
// versions; the canonical "current state" is the latest one.
function mergeAndDedupReplaceables(events) {
  const byCoord = new Map()
  for (const ev of events) {
    const dTag = ev.tags?.find(t => t[0] === 'd')?.[1] || ''
    if (!dTag) continue
    const key = `${ev.pubkey}:${dTag}`
    const existing = byCoord.get(key)
    if (!existing || (ev.created_at || 0) > (existing.created_at || 0)) {
      byCoord.set(key, ev)
    }
  }
  return Array.from(byCoord.values())
}

export function useMarketSearch({
  sessionPubkey,    // for resolving read relays
  authorPubkey,     // hex pubkey to filter to (already decoded by caller)
  category,         // first t-tag value
  // Client-side only — don't trigger refetch:
  keyword,
  withImages,       // checkbox: only listings with at least one image
  withPrice,        // checkbox: only listings with a numeric price
  checkoutReady,    // checkbox: only listings carrying ≥1 shipping_option ref
                    //  (the same "checkout-ready" predicate the compliance
                    //   grader uses — keeps Search and the per-card dot
                    //   in agreement on what "ready" means)
  includeNSFW,
  sort,
}) {
  const [events, setEvents]   = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)
  const [hasMore, setHasMore] = useState(true)
  const fetchIdRef = useRef(0)

  // Cache the resolved relay URL list so we don't re-fetch the user's
  // kind-10002 on every loadMore. Invalidates when sessionPubkey
  // changes (different user's outbox = different relay set).
  const relayCacheRef = useRef({ pubkey: null, urls: null })
  const resolveRelays = useCallback(async () => {
    const cache = relayCacheRef.current
    if (cache.pubkey === sessionPubkey && cache.urls) return cache.urls
    const ndk = getNDK()
    const readRelays = await fetchReadRelays(ndk, sessionPubkey)
    const urls = Array.from(new Set([
      ...readRelays,
      ...DEFAULT_MARKETPLACE_RELAYS,
    ]))
    relayCacheRef.current = { pubkey: sessionPubkey, urls }
    return urls
  }, [sessionPubkey])

  // Reset and fetch when relay-side query changes.
  useEffect(() => {
    let cancelled = false
    const id = ++fetchIdRef.current
    setEvents([])
    setHasMore(true)
    setError(null)
    setLoading(true)

    ;(async () => {
      try {
        const ndk = getNDK()
        const relayUrls = await resolveRelays()
        const relaySet = NDKRelaySet.fromRelayUrls(relayUrls, ndk)

        const filter = { kinds: [KIND_PRODUCT], limit: PAGE_SIZE }
        if (authorPubkey) filter.authors = [authorPubkey]
        if (category)     filter['#t']    = [category]

        const result = await withTimeout(
          ndk.fetchEvents(filter, { closeOnEose: true }, relaySet),
          FETCH_TIMEOUT_MS,
          'search-timeout',
        )

        if (cancelled || fetchIdRef.current !== id) return
        const arr = Array.from(result || [])
        const merged = mergeAndDedupReplaceables(arr)
        setEvents(merged)
        // Heuristic: if we got close to a full page, assume there's more.
        setHasMore(arr.length >= PAGE_SIZE - 5)
      } catch (e) {
        if (cancelled || fetchIdRef.current !== id) return
        setError(e?.message === 'search-timeout' ? 'Search timed out.' : (e?.message || 'Search failed.'))
        setHasMore(false)
      } finally {
        if (!cancelled && fetchIdRef.current === id) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [sessionPubkey, authorPubkey, category, resolveRelays])

  async function loadMore() {
    if (loading || !hasMore || events.length === 0) return
    const id = ++fetchIdRef.current
    setLoading(true)
    setError(null)
    try {
      const ndk = getNDK()
      const relayUrls = await resolveRelays()
      const relaySet = NDKRelaySet.fromRelayUrls(relayUrls, ndk)

      // Cursor: the oldest event we already have. Sort by created_at
      // ascending and take the first — events isn't necessarily
      // sorted at this point (mergeAndDedupReplaceables doesn't
      // guarantee order).
      const oldest = events.reduce(
        (acc, ev) => (acc == null || ev.created_at < acc) ? ev.created_at : acc,
        null,
      )
      const filter = { kinds: [KIND_PRODUCT], limit: PAGE_SIZE, until: oldest }
      if (authorPubkey) filter.authors = [authorPubkey]
      if (category)     filter['#t']    = [category]

      const result = await withTimeout(
        ndk.fetchEvents(filter, { closeOnEose: true }, relaySet),
        FETCH_TIMEOUT_MS,
        'search-timeout',
      )

      if (fetchIdRef.current !== id) return
      const arr = Array.from(result || [])
      // Merge new page into existing set, keep newest by coordinate.
      setEvents(prev => mergeAndDedupReplaceables([...prev, ...arr]))
      setHasMore(arr.length >= PAGE_SIZE - 5)
    } catch (e) {
      if (fetchIdRef.current !== id) return
      setError(e?.message === 'search-timeout' ? 'Search timed out.' : (e?.message || 'Search failed.'))
      setHasMore(false)
    } finally {
      if (fetchIdRef.current === id) setLoading(false)
    }
  }

  // Decode + apply client-side filters + sort.
  const listings = useMemo(() => {
    const decoded = events
      .map(ev => ({ event: ev, decoded: decodeProduct(ev) }))
      .filter(x => x.decoded)

    const k = (keyword || '').trim().toLowerCase()

    const filtered = decoded.filter(x => {
      const d = x.decoded
      // Default-hide sold + hidden visibility (search is for *active* discovery).
      if (d.status === 'sold') return false
      if (d.visibility === 'hidden') return false
      // NSFW gate. The Sell composer encodes the nsfw flag as a t-tag.
      if (!includeNSFW && (d.tTags || []).includes('nsfw')) return false
      // Image-presence filter: at least one ['image', ...] tag survived
      // decoding. Listings without images are usually thin or
      // placeholder; users browsing for products want to see them.
      if (withImages && (!Array.isArray(d.images) || d.images.length === 0)) return false
      // Price-presence filter: a numeric amount was set on the price tag.
      // Excludes "contact for price" / unset listings.
      if (withPrice && !Number.isFinite(d.price?.amount)) return false
      // Checkout-ready filter: at least one shipping_option ref. Mirrors
      // the gradeListing predicate exactly so Search + the per-card dot
      // describe the same set of "ready" listings.
      if (checkoutReady && !(Array.isArray(d.shippingOptionRefs) && d.shippingOptionRefs.length > 0)) return false
      // Keyword — match across title, summary, content, tTags, mainCategory.
      if (k) {
        const haystack = [
          d.title,
          d.summary,
          d.content,
          d.mainCategory,
          ...(d.tTags || []),
        ].filter(Boolean).join(' ').toLowerCase()
        if (!haystack.includes(k)) return false
      }
      return true
    })

    if (sort === 'price-asc') {
      return filtered.sort((a, b) => (a.decoded.price?.amount ?? Infinity) - (b.decoded.price?.amount ?? Infinity))
    }
    if (sort === 'price-desc') {
      return filtered.sort((a, b) => (b.decoded.price?.amount ?? -Infinity) - (a.decoded.price?.amount ?? -Infinity))
    }
    // 'newest' (default) — sort by created_at desc.
    return filtered.sort((a, b) => (b.event.created_at || 0) - (a.event.created_at || 0))
  }, [events, keyword, withImages, withPrice, checkoutReady, includeNSFW, sort])

  return {
    listings,
    rawCount: events.length,
    loading,
    error,
    hasMore,
    loadMore,
  }
}
