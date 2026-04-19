/**
 * AuthorBookmarksPane — paginated feed of kind 1 notes that an arbitrary
 * author has publicly bookmarked, split by bookmark category.
 *
 * Fetches the author's kind 10003 (primary "Bookmarks") and kind 30003
 * (custom categories) events via useAuthorBookmarkCategories. Renders the
 * same BookmarkChipBar used by the owner's My Bookmarks tab in read-only
 * mode (no "+ New") so viewers can filter by category.
 *
 * Active category's items feed into the same prefetch+sort+slice pipeline
 * used in BookmarksTab. Sort is (addedAt desc, created_at desc); for kind
 * 10003 addedAt ties across every item so the note's own timestamp carries
 * the order.
 *
 * Private bookmarks (NIP-04 encrypted in `content`) are intentionally
 * ignored — we don't hold the author's decryption key.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchNotesByIds, fetchProfiles } from '../../../../lib/primal.js'
import { useInfiniteFeed } from '../../../../hooks/useInfiniteFeed.js'
import { useAuthorBookmarkCategories } from '../../../../lib/useAuthorBookmarkCategories.js'
import { NOTE_PRIMARY_CATEGORY_ID } from '../../../../lib/useNoteBookmarks.js'
import BookmarkChipBar from './BookmarkChipBar.jsx'
import NotesFeed from './NotesFeed.jsx'

export default function AuthorBookmarksPane({ pubkey, emptyMessage, onNoteClick }) {
  const { categories, loading } = useAuthorBookmarkCategories(pubkey)

  // Default to primary if present, else first custom category. Re-run when
  // the active chip vanishes (category list refetched/changed).
  const [activeCategoryId, setActiveCategoryId] = useState(null)
  useEffect(() => {
    if (categories.length === 0) {
      if (activeCategoryId) setActiveCategoryId(null)
      return
    }
    const exists = categories.some(c => c.id === activeCategoryId)
    if (exists) return
    const primary = categories.find(c => c.id === NOTE_PRIMARY_CATEGORY_ID)
    setActiveCategoryId(primary ? primary.id : categories[0].id)
  }, [categories, activeCategoryId])

  const activeCategory = categories.find(c => c.id === activeCategoryId) || null
  const currentItems = activeCategory ? activeCategory.items : []
  const currentIds = useMemo(() => currentItems.map(it => it.id), [currentItems])

  // Feed key invalidates the prefetch whenever the active id set shifts.
  const feedKey = useMemo(() => {
    const tag = `${currentIds.length}:${currentIds[0]?.slice(0, 8) || ''}:${currentIds[currentIds.length - 1]?.slice(0, 8) || ''}`
    return `author-bookmarks:${pubkey || ''}:${activeCategoryId || ''}:${tag}`
  }, [pubkey, activeCategoryId, currentIds])

  // Prefetched+sorted cache. One fetch per feedKey; pagination is pure
  // local slicing after that.
  const cacheRef = useRef({ key: null, notes: [], profiles: new Map() })
  const cursorRef = useRef(0)
  const itemsRef = useRef(currentItems)
  useEffect(() => { itemsRef.current = currentItems }, [currentItems])
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

  const feed = useInfiniteFeed({
    key: feedKey,
    loadPage,
    pageSize: 20,
    enabled: !loading && currentIds.length > 0,
  })

  if (loading && categories.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-4 py-10 text-center">
          <span className="inline-block w-5 h-5 border-2 border-neutral-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-neutral-500 mt-2">Loading bookmarks…</p>
        </div>
      </div>
    )
  }

  if (categories.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-4 py-10 text-center">
          <p className="text-xs text-neutral-500">{emptyMessage || 'No public bookmarks.'}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <BookmarkChipBar
        categories={categories}
        activeCategoryId={activeCategoryId}
        onSelect={setActiveCategoryId}
        readOnly
      />
      <NotesFeed
        items={feed.items}
        profiles={feed.profiles}
        loading={feed.loading}
        initialLoading={feed.initialLoading}
        error={feed.error}
        done={feed.done}
        sentinelRef={feed.sentinelRef}
        emptyMessage={activeCategory
          ? `Nothing in ${activeCategory.title} yet.`
          : (emptyMessage || 'No public bookmarks.')}
        onReload={feed.reload}
        onNoteClick={onNoteClick}
      />
    </div>
  )
}
