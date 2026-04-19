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

async function loadBookmarkIds(pubkey) {
  const ndk = getNDK()
  await connectAndWait(ndk, 3000).catch(() => {})
  const event = await Promise.race([
    ndk.fetchEvent({ kinds: [BOOKMARK_KIND], authors: [pubkey] }),
    new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 6000)),
  ]).catch(() => null)
  if (!event) return []
  const ids = []
  const seen = new Set()
  for (const t of event.tags || []) {
    if (t[0] === 'e' && typeof t[1] === 'string' && /^[0-9a-f]{64}$/i.test(t[1])) {
      const id = t[1].toLowerCase()
      if (!seen.has(id)) { seen.add(id); ids.push(id) }
    }
  }
  // Newest-added first — kind 10003 has no timestamps, and every client
  // I've checked appends new bookmarks to the end of the tag array.
  ids.reverse()
  return ids
}

export default function AuthorBookmarksPane({ pubkey, emptyMessage }) {
  const [bookmarkIds, setBookmarkIds] = useState(null) // null = loading, [] = empty
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!pubkey) { setBookmarkIds([]); return }
    let cancelled = false
    setBookmarkIds(null)
    setError(null)
    ;(async () => {
      try {
        const ids = await loadBookmarkIds(pubkey)
        if (cancelled) return
        setBookmarkIds(ids)
      } catch (e) {
        if (cancelled) return
        setError(e?.message || 'Failed to load bookmarks')
        setBookmarkIds([])
      }
    })()
    return () => { cancelled = true }
  }, [pubkey])

  // Ref-mirror the id list + cursor so loadPage stays stable even if the
  // list is reassigned (e.g. new pubkey triggers a refetch).
  const idsRef = useRef([])
  useEffect(() => { idsRef.current = bookmarkIds || [] }, [bookmarkIds])
  const cursorRef = useRef(0)

  const feedKey = useMemo(
    () => `author-bookmarks:${pubkey || ''}:${(bookmarkIds || []).length}`,
    [pubkey, bookmarkIds],
  )
  useEffect(() => { cursorRef.current = 0 }, [feedKey])

  const loadPage = useCallback(async ({ limit }) => {
    const ids = idsRef.current
    const start = cursorRef.current
    const slice = ids.slice(start, start + limit)
    if (slice.length === 0) return { items: [], done: true }
    cursorRef.current = start + slice.length

    const { notes, profiles } = await fetchNotesByIds(slice)
    const indexOf = new Map(slice.map((id, i) => [id, i]))
    notes.sort((a, b) => (indexOf.get(a.id) ?? 1e9) - (indexOf.get(b.id) ?? 1e9))

    const missing = new Set()
    for (const n of notes) if (!profiles.has(n.pubkey)) missing.add(n.pubkey)
    if (missing.size) {
      try {
        const fetched = await fetchProfiles([...missing])
        for (const [pk, p] of fetched) profiles.set(pk, p)
      } catch {}
    }
    return {
      items: notes,
      profiles,
      done: cursorRef.current >= ids.length,
    }
  }, [])

  const waitingOnList = bookmarkIds === null
  const feed = useInfiniteFeed({
    key: feedKey,
    loadPage,
    pageSize: 20,
    enabled: !waitingOnList && (bookmarkIds || []).length > 0,
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
