/**
 * useInfiniteFeed — generic paginated feed hook.
 *
 * Caller supplies a `loadPage({ cursor, limit })` async fn that returns
 *   { items, profiles?, nextCursor, done }
 * and the hook handles:
 *   - the first-page load on `key` change (reset),
 *   - an IntersectionObserver sentinel for "scroll to load more,"
 *   - item dedup by id,
 *   - profile-map merging across pages.
 *
 * Returns { items, profiles, loading, initialLoading, error, done, sentinelRef, reload }.
 *
 * The `key` prop is the reset trigger — whenever it changes (e.g. the user
 * navigates to a new author's feed), the hook throws away current state and
 * fetches page 1 from scratch. Pass a stable value like the hex pubkey or a
 * serialized descriptor.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const DEFAULT_PAGE_SIZE = 25

export function useInfiniteFeed({ key, loadPage, pageSize = DEFAULT_PAGE_SIZE, enabled = true }) {
  const [items, setItems] = useState([])
  const [profiles, setProfiles] = useState(new Map())
  const [loading, setLoading] = useState(false)
  const [initialLoading, setInitialLoading] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)

  // Gen counter — any in-flight fetch whose gen no longer matches is ignored.
  // Prevents a slow page-2 from a stale `key` overwriting fresh page-1 data.
  const genRef = useRef(0)
  const cursorRef = useRef(null)
  const loadingRef = useRef(false)
  const sentinelRef = useRef(null)

  const reset = useCallback(() => {
    genRef.current += 1
    cursorRef.current = null
    loadingRef.current = false
    setItems([])
    setProfiles(new Map())
    setError(null)
    setDone(false)
    setLoading(false)
    setInitialLoading(false)
  }, [])

  const fetchPage = useCallback(async (isInitial) => {
    if (!enabled) return
    if (loadingRef.current) return
    if (done && !isInitial) return
    loadingRef.current = true
    const gen = genRef.current
    setLoading(true)
    if (isInitial) setInitialLoading(true)
    setError(null)
    try {
      const result = await loadPage({ cursor: cursorRef.current, limit: pageSize })
      if (gen !== genRef.current) return
      const newItems = result?.items || []
      const newProfiles = result?.profiles
      const nextCursor = result?.nextCursor ?? null
      const isDone = !!result?.done || newItems.length === 0

      setItems(prev => {
        if (newItems.length === 0) return prev
        const seen = new Set(prev.map(it => it.id))
        const merged = [...prev]
        for (const it of newItems) {
          if (it?.id && !seen.has(it.id)) { seen.add(it.id); merged.push(it) }
        }
        return merged
      })

      if (newProfiles && newProfiles.size) {
        setProfiles(prev => {
          const merged = new Map(prev)
          for (const [pk, p] of newProfiles) if (!merged.has(pk)) merged.set(pk, p)
          return merged
        })
      }

      cursorRef.current = nextCursor
      setDone(isDone)
    } catch (e) {
      if (gen !== genRef.current) return
      setError(e?.message || 'Failed to load')
    } finally {
      if (gen === genRef.current) {
        loadingRef.current = false
        setLoading(false)
        if (isInitial) setInitialLoading(false)
      }
    }
  }, [enabled, loadPage, pageSize, done])

  // Reset + fetch page 1 whenever the key changes.
  useEffect(() => {
    reset()
    if (!enabled) return
    // Defer by a macrotask so callers that just changed `key` can also update
    // their loadPage identity synchronously before we fire.
    const id = setTimeout(() => fetchPage(true), 0)
    return () => clearTimeout(id)
  }, [key, enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  // IntersectionObserver wired to the sentinel. Firing while the sentinel is
  // visible triggers the next page; the loadingRef guard prevents stampedes.
  useEffect(() => {
    const node = sentinelRef.current
    if (!node || done || !enabled) return
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting) fetchPage(false)
      }
    }, { rootMargin: '400px 0px' })
    io.observe(node)
    return () => io.disconnect()
  }, [done, enabled, fetchPage, items.length])

  const reload = useCallback(() => {
    reset()
    fetchPage(true)
  }, [reset, fetchPage])

  return { items, profiles, loading, initialLoading, error, done, sentinelRef, reload }
}
