/**
 * AuthorBookmarksPane — paginated feed of kind 1 notes that an arbitrary
 * author has publicly bookmarked in their kind 10003 list.
 *
 * Walks the author's primary NIP-51 bookmark event (kind 10003), takes
 * the `e` tags in reverse order (most-recently-added first — the
 * universal client convention since 10003 has no per-item timestamp),
 * and pages through them via Primal's fetchNotesByIds in slices of 20.
 *
 * Private bookmarks (NIP-04 encrypted in `content`) are intentionally
 * ignored — we don't hold the author's decryption key.
 *
 * Companion to AuthorNotesPane: same NotesFeed rendering surface so the
 * Search tab can flip between "their notes" and "their bookmarks" with
 * a single pill toggle and no layout shifts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchNotesByIds, fetchProfiles } from '../../../../lib/primal.js'
import { getNDK, connectAndWait } from '../../../../lib/ndk.js'
import { useInfiniteFeed } from '../../../../hooks/useInfiniteFeed.js'
import NotesFeed from './NotesFeed.jsx'

const BOOKMARK_KIND = 10003

async function loadBookmarkItems(pubkey) {
  // Returns [{ id, addedAt }] where addedAt is the bookmark event's
  // created_at (all items in a 10003 share it — we rely on the note's
  // own created_at as the real tie-break at sort time).
  const ndk = getNDK()
  await connectAndWait(ndk, 3000).catch(() => {})
  const event = await Promise.race([
    ndk.fetchEvent({ kinds: [BOOKMARK_KIND], authors: [pubkey] }),
    new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 6000)),
  ]).catch(() => null)
  if (!event) return []
  const items = []
  const seen = new Set()
  const addedAt = (event.created_at || 0) * 1000
  for (const t of event.tags || []) {
    if (t[0] === 'e' && typeof t[1] === 'string' && /^[0-9a-f]{64}$/i.test(t[1])) {
      const id = t[1].toLowerCase()
      if (!seen.has(id)) { seen.add(id); items.push({ id, addedAt }) }
    }
  }
  return items
}

export default function AuthorBookmarksPane({ pubkey, emptyMessage }) {
  const [bookmarkItems, setBookmarkItems] = useState(null) // null = loading, [] = empty
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!pubkey) { setBookmarkItems([]); return }
    let cancelled = false
    setBookmarkItems(null)
    setError(null)
    ;(async () => {
      try {
        const items = await loadBookmarkItems(pubkey)
        if (cancelled) return
        setBookmarkItems(items)
      } catch (e) {
        if (cancelled) return
        setError(e?.message || 'Failed to load bookmarks')
        setBookmarkItems([])
      }
    })()
    return () => { cancelled = true }
  }, [pubkey])

  // Prefetch+sort on first loadPage per feedKey, then slice locally.
  // Sort is (addedAt desc, created_at desc); for 10003 addedAt ties
  // across every item so the note's own timestamp carries the order.
  const cacheRef = useRef({ key: null, notes: [], profiles: new Map() })
  const cursorRef = useRef(0)
  const itemsRef = useRef([])
  useEffect(() => { itemsRef.current = bookmarkItems || [] }, [bookmarkItems])

  const feedKey = useMemo(
    () => `author-bookmarks:${pubkey || ''}:${(bookmarkItems || []).length}`,
    [pubkey, bookmarkItems],
  )
  useEffect(() => { cursorRef.current = 0 }, [feedKey])

  const loadPage = useCallback(async ({ limit }) => {
    if (cacheRef.current.key !== feedKey) {
      const items = itemsRef.current
      if (items.length === 0) {
        cacheRef.current = { key: feedKey, notes: [], profiles: new Map() }
        return { items: [], done: true }
      }
      const ids = items.map(it => it.id)
      const addedAtById = new Map(items.map(it => [it.id, it.addedAt || 0]))
      const { notes, profiles } = await fetchNotesByIds(ids)

      const missing = new Set()
      for (const n of notes) if (!profiles.has(n.pubkey)) missing.add(n.pubkey)
      if (missing.size) {
        try {
          const fetched = await fetchProfiles([...missing])
          for (const [pk, p] of fetched) profiles.set(pk, p)
        } catch {}
      }

      notes.sort((a, b) => {
        const aAt = addedAtById.get(a.id) || 0
        const bAt = addedAtById.get(b.id) || 0
        if (bAt !== aAt) return bAt - aAt
        return (b.created_at || 0) - (a.created_at || 0)
      })

      cacheRef.current = { key: feedKey, notes, profiles }
      cursorRef.current = 0
    }

    const { notes, profiles } = cacheRef.current
    const start = cursorRef.current
    const slice = notes.slice(start, start + limit)
    cursorRef.current = start + slice.length
    return {
      items: slice,
      profiles,
      done: cursorRef.current >= notes.length,
    }
  }, [feedKey])

  const waitingOnList = bookmarkItems === null
  const feed = useInfiniteFeed({
    key: feedKey,
    loadPage,
    pageSize: 20,
    enabled: !waitingOnList && (bookmarkItems || []).length > 0,
  })

  if (waitingOnList) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-4 py-10 text-center">
          <span className="inline-block w-5 h-5 border-2 border-neutral-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-neutral-500 mt-2">Loading bookmarks…</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-4 py-10 text-center">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <NotesFeed
      items={feed.items}
      profiles={feed.profiles}
      loading={feed.loading}
      initialLoading={feed.initialLoading}
      error={feed.error}
      done={feed.done}
      sentinelRef={feed.sentinelRef}
      emptyMessage={emptyMessage || 'No public bookmarks.'}
      onReload={feed.reload}
    />
  )
}
