/**
 * useWatchlist — fetch + mutate the buyer-side watchlist.
 *
 * The watchlist is a single kind 30405 (Gamma collection) per user with a
 * fixed `d:watchlist` identifier. References are `["a", "30402:pubkey:dtag"]`
 * pointing at any author's product — the Gamma spec doesn't restrict
 * collections to the author's own products, so we use this to track
 * other users' listings.
 *
 * Reading: fetches whichever pubkey you ask for. Visitors viewing
 * someone else's profile see that user's watchlist; on your own page,
 * you see yours.
 *
 * Writing: only meaningful when `pubkey === sessionUser.pubkey`. The
 * mutators (`add`, `remove`) sign with the NDK session signer and
 * publish via outbox-aware publishToOwnOutbox. Non-owner mutations
 * would publish events with the wrong author and silently fail at
 * relay-acceptance — guard at the call site (WatchlistButton does).
 */
import { useCallback, useEffect, useState } from 'react'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNDK, signWithTimeout, publishToOwnOutbox } from './ndk.js'
import { withTimeout } from './utils.js'
import {
  KIND_COLLECTION,
  WATCHLIST_D_TAG,
  encodeCollection,
  decodeCollection,
} from './gamma.js'

/**
 * Fetch the latest kind 30405 with d:watchlist for a pubkey.
 * Returns { event, decoded } or null when the user hasn't created one yet.
 */
async function fetchWatchlistEvent(pubkey) {
  if (!pubkey) return null
  const ndk = getNDK()
  try {
    const events = await withTimeout(
      ndk.fetchEvents({
        kinds:    [KIND_COLLECTION],
        authors:  [pubkey],
        '#d':     [WATCHLIST_D_TAG],
      }),
      8000,
      'fetch-timeout',
    )
    // Replaceable kind — pick newest by created_at if relays surface
    // multiple stale copies.
    let latest = null
    for (const ev of events) {
      if (!latest || (ev.created_at || 0) > (latest.created_at || 0)) latest = ev
    }
    if (!latest) return null
    const decoded = decodeCollection(latest)
    if (!decoded) return null
    return { event: latest, decoded }
  } catch {
    return null
  }
}

export function useWatchlist(pubkey) {
  const [productRefs, setProductRefs] = useState([])
  const [decoded, setDecoded] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [token, setToken] = useState(0)
  // `pending` covers both the in-flight publish AND any optimistic
  // mutation. While pending the button shows a spinner so users don't
  // double-click and queue duplicate adds.
  const [pending, setPending] = useState(false)

  const reload = useCallback(() => setToken(t => t + 1), [])

  // Fetch on mount + when pubkey/token changes
  useEffect(() => {
    if (!pubkey) {
      setProductRefs([])
      setDecoded(null)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const result = await fetchWatchlistEvent(pubkey)
        if (cancelled) return
        if (result) {
          setProductRefs(result.decoded.productRefs || [])
          setDecoded(result.decoded)
        } else {
          setProductRefs([])
          setDecoded(null)
        }
        setLoading(false)
      } catch (e) {
        if (cancelled) return
        setError(e?.message || 'Watchlist load failed.')
        setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [pubkey, token])

  // Quick membership check used by toggle buttons. O(n) but n is small
  // (watchlists rarely exceed a few dozen entries) and useState/JSX
  // re-renders dwarf the linear scan cost.
  const has = useCallback((aTag) => {
    if (!aTag) return false
    return productRefs.includes(aTag)
  }, [productRefs])

  // Internal: build a 30405 from a product-ref array, sign, publish.
  // Always re-fetches the existing collection's metadata (title, image,
  // _extraTags) so we don't clobber fields a future client might have
  // added; only productRefs is mutated.
  const publishUpdate = useCallback(async (nextRefs) => {
    const ndk = getNDK()
    if (!ndk?.signer) throw new Error('No signer available')
    // Fall back to a fresh decoded shape if the user hasn't created a
    // watchlist yet. Title is hardcoded — it's a system collection,
    // not user-named.
    const base = decoded || {
      dTag: WATCHLIST_D_TAG,
      title: 'Watchlist',
      productRefs: [],
      shippingOptionRefs: [],
      tTags: [],
      _extraTags: [],
    }
    const form = {
      ...base,
      dTag: WATCHLIST_D_TAG,
      title: base.title || 'Watchlist',
      productRefs: nextRefs,
    }
    const { kind, content, tags } = encodeCollection(form)
    const ev = new NDKEvent(ndk, {
      kind,
      content,
      tags,
      created_at: Math.floor(Date.now() / 1000),
    })
    await signWithTimeout(ev)
    const publishedTo = await publishToOwnOutbox(ev)
    return { event: ev, publishedTo }
  }, [decoded])

  const add = useCallback(async (aTag) => {
    if (!aTag || pending) return { ok: false, reason: 'busy-or-empty' }
    if (productRefs.includes(aTag)) return { ok: true, alreadyPresent: true }
    setPending(true)
    setError(null)
    // Optimistic update so the star flips instantly.
    const prevRefs = productRefs
    const nextRefs = [...productRefs, aTag]
    setProductRefs(nextRefs)
    try {
      await publishUpdate(nextRefs)
      // Refetch to pick up the canonical decoded state (title etc. may
      // have changed if this was the very first publish).
      const fresh = await fetchWatchlistEvent(pubkey)
      if (fresh) setDecoded(fresh.decoded)
      return { ok: true }
    } catch (e) {
      // Roll back optimistic state on failure.
      setProductRefs(prevRefs)
      setError(e?.message || 'Add failed.')
      return { ok: false, error: e?.message || 'Add failed.' }
    } finally {
      setPending(false)
    }
  }, [pending, productRefs, publishUpdate, pubkey])

  const remove = useCallback(async (aTag) => {
    if (!aTag || pending) return { ok: false, reason: 'busy-or-empty' }
    if (!productRefs.includes(aTag)) return { ok: true, alreadyAbsent: true }
    setPending(true)
    setError(null)
    const prevRefs = productRefs
    const nextRefs = productRefs.filter(r => r !== aTag)
    setProductRefs(nextRefs)
    try {
      await publishUpdate(nextRefs)
      return { ok: true }
    } catch (e) {
      setProductRefs(prevRefs)
      setError(e?.message || 'Remove failed.')
      return { ok: false, error: e?.message || 'Remove failed.' }
    } finally {
      setPending(false)
    }
  }, [pending, productRefs, publishUpdate])

  // Update collection metadata (title, summary, image) without touching
  // productRefs. Used by the WatchlistEditModal so the user can rename
  // their watchlist or attach a cover image. Optimistic update; rolls
  // back on publish failure.
  const updateMetadata = useCallback(async (patch) => {
    if (pending) return { ok: false, reason: 'busy' }
    const ndk = getNDK()
    if (!ndk?.signer) return { ok: false, reason: 'no-signer', error: 'No signer available' }
    setPending(true)
    setError(null)
    const prevDecoded = decoded
    // Build a fresh decoded shape with the patched fields. Keep
    // productRefs from current state so a metadata-only edit doesn't
    // race with a concurrent add/remove (productRefs is the source of
    // truth in local state).
    const baseline = decoded || {
      dTag: WATCHLIST_D_TAG,
      title: 'Watchlist',
      summary: '',
      image: '',
      productRefs: [],
      shippingOptionRefs: [],
      tTags: [],
      _extraTags: [],
    }
    const nextDecoded = {
      ...baseline,
      ...patch,
      dTag: WATCHLIST_D_TAG,
      title: patch.title?.trim() || 'Watchlist',
      productRefs,
    }
    setDecoded(nextDecoded)
    try {
      const { kind, content, tags } = encodeCollection(nextDecoded)
      const ev = new NDKEvent(ndk, {
        kind,
        content,
        tags,
        created_at: Math.floor(Date.now() / 1000),
      })
      await signWithTimeout(ev)
      await publishToOwnOutbox(ev)
      return { ok: true }
    } catch (e) {
      setDecoded(prevDecoded)
      setError(e?.message || 'Update failed.')
      return { ok: false, error: e?.message || 'Update failed.' }
    } finally {
      setPending(false)
    }
  }, [pending, decoded, productRefs])

  return {
    productRefs,
    metadata: {
      title:   decoded?.title   || '',
      summary: decoded?.summary || '',
      image:   decoded?.image   || '',
    },
    loading,
    error,
    pending,
    has,
    add,
    remove,
    updateMetadata,
    reload,
  }
}
