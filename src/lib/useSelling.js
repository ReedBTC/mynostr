import { useEffect, useState, useCallback } from 'react'
import { getNDK, connectAndWait } from './ndk.js'
import { withTimeout } from './utils.js'
import { decodeProduct, KIND_PRODUCT } from './gamma.js'

/**
 * Fetch the kind 30402 listings authored by a single user.
 *
 * Kind 30402 is replaceable by `d`-tag, so an author may legitimately
 * have multiple events on relays sharing the same dTag (older versions
 * that some relays still hold). We dedupe by dTag and keep the newest
 * `created_at` — that's the canonical "current state" of the listing.
 *
 * Decoded shape passed back: each entry is the raw NDK event with
 * a `decoded` field tacked on (output of gamma.decodeProduct), so
 * callers can render either the raw or the structured form without
 * an extra decode pass.
 *
 * Returns: { listings, loading, error, reload }
 *   listings : [{ event, decoded }]   — sorted newest first
 *   loading  : boolean
 *   error    : string | null
 *   reload() : trigger a re-fetch (e.g. after publishing a new edit
 *              or deleting a listing — relay state changed)
 */
export function useSelling(pubkey) {
  const [listings, setListings] = useState([])
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)
  const [token,    setToken]    = useState(0)

  const reload = useCallback(() => setToken(t => t + 1), [])

  useEffect(() => {
    if (!pubkey) {
      setListings([])
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const ndk = getNDK()
        await connectAndWait(ndk, 3000).catch(() => {})
        const events = await withTimeout(
          ndk.fetchEvents({ kinds: [KIND_PRODUCT], authors: [pubkey] }),
          10000,
          'fetch-timeout'
        )
        if (cancelled) return

        // Dedupe by dTag, keep latest created_at. Then sort.
        const byDTag = new Map()
        for (const ev of events) {
          const dTag = ev.tags?.find(t => t[0] === 'd')?.[1] || ''
          if (!dTag) continue
          const existing = byDTag.get(dTag)
          if (!existing || (ev.created_at || 0) > (existing.created_at || 0)) {
            byDTag.set(dTag, ev)
          }
        }

        const out = []
        for (const ev of byDTag.values()) {
          const decoded = decodeProduct(ev)
          if (decoded) out.push({ event: ev, decoded })
        }
        out.sort((a, b) => (b.event.created_at || 0) - (a.event.created_at || 0))

        if (!cancelled) {
          setListings(out)
          setLoading(false)
        }
      } catch (e) {
        if (cancelled) return
        setError(e?.message === 'fetch-timeout' ? 'Relays timed out.' : (e?.message || 'Load failed.'))
        setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [pubkey, token])

  // Local-state mutators — let callers update the list optimistically
  // after a publish/delete without waiting for the relay round-trip.

  /** Replace or insert a listing by its event coordinate. Used after
   *  a successful re-publish so the edit shows up immediately. */
  const upsertLocal = useCallback((event) => {
    if (!event) return
    const decoded = decodeProduct(event)
    if (!decoded) return
    setListings(prev => {
      const dTag = decoded.dTag
      const filtered = prev.filter(l => l.decoded.dTag !== dTag)
      const next = [{ event, decoded }, ...filtered]
      next.sort((a, b) => (b.event.created_at || 0) - (a.event.created_at || 0))
      return next
    })
  }, [])

  /** Remove a listing by dTag — called after a successful kind-5 publish. */
  const removeLocal = useCallback((dTag) => {
    if (!dTag) return
    setListings(prev => prev.filter(l => l.decoded.dTag !== dTag))
  }, [])

  return { listings, loading, error, reload, upsertLocal, removeLocal }
}
