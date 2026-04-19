/**
 * BookmarksTab — paginated feed of a user's public kind 1 bookmarks.
 *
 * Two modes:
 *
 *   Owner view — chip bar across the top lists the session user's primary
 *   (kind 10003) list plus every custom (kind 30003) category, plus a
 *   "+ New" action. The feed paginates through whatever chip is selected.
 *   Category data comes from the hoisted NoteBookmarksContext, which keeps
 *   the source of truth so add/remove mutations reflect instantly without
 *   a re-fetch.
 *
 *   Visitor view — flat primary feed fetched directly over NDK. Categories
 *   are not surfaced to visitors (we'd have to do a second round of fetches
 *   per-profile and the UX benefit is marginal). Visitors cannot mutate.
 *
 * Live filtering: the active category's items are the authoritative id
 * set. We filter feed.items against that Set at render time so a
 * just-removed note drops out instantly (no scroll reset).
 *
 * Private/encrypted bookmarks (NIP-04 payload in kind 10003 `content`) are
 * intentionally not surfaced — we'd need the decrypt flow first.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchNotesByIds, fetchProfiles } from '../../../../lib/primal.js'
import { getNDK, connectAndWait } from '../../../../lib/ndk.js'
import { useInfiniteFeed } from '../../../../hooks/useInfiniteFeed.js'
import { useNoteBookmarksContext } from '../../noteBookmarksContext.jsx'
import { NOTE_PRIMARY_CATEGORY_ID } from '../../../../lib/useNoteBookmarks.js'
import BookmarkChipBar from './BookmarkChipBar.jsx'
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
  // Kind 10003 has no per-item timestamp; clients almost universally
  // *append* new bookmarks, so the tail of the tag array is the most
  // recently added. Reverse so the feed leads with "just bookmarked."
  ids.reverse()
  return ids
}

export default function BookmarksTab({ user, isOwner }) {
  const pubkey = user?.pubkey
  const displayName = user?.profile?.displayName || user?.profile?.name || 'this user'

  const { categories, loading: bookmarksLoading, createCategory } = useNoteBookmarksContext()

  // ── Owner: category chip state ──────────────────────────────────────
  const [activeCategoryId, setActiveCategoryId] = useState(null)

  // Pick a sensible default chip once data is available. Prefer primary
  // if it exists, else the first custom category. Re-run whenever the
  // currently-active chip vanishes (e.g., its last note was moved to
  // another category and the set dropped to 0 items → filtered out).
  useEffect(() => {
    if (!isOwner) return
    if (categories.length === 0) {
      if (activeCategoryId) setActiveCategoryId(null)
      return
    }
    const exists = categories.some(c => c.id === activeCategoryId)
    if (exists) return
    const primary = categories.find(c => c.id === NOTE_PRIMARY_CATEGORY_ID)
    setActiveCategoryId(primary ? primary.id : categories[0].id)
  }, [isOwner, categories, activeCategoryId])

  const activeCategory = isOwner
    ? categories.find(c => c.id === activeCategoryId)
    : null

  // ── Visitor: direct primary-list fetch ──────────────────────────────
  const [visitorIds, setVisitorIds] = useState(null)
  const [visitorError, setVisitorError] = useState(null)

  useEffect(() => {
    if (isOwner || !pubkey) return
    let cancelled = false
    setVisitorIds(null)
    setVisitorError(null)
    ;(async () => {
      try {
        const list = await loadBookmarkIds(pubkey)
        if (cancelled) return
        setVisitorIds(list)
      } catch (e) {
        if (cancelled) return
        setVisitorError(e?.message || 'Failed to load bookmarks')
      }
    })()
    return () => { cancelled = true }
  }, [isOwner, pubkey])

  // ── Unified item list for the active view ───────────────────────────
  // Owner items carry an addedAt (kind 30003 has per-item timestamps in
  // our JSON content extension; kind 10003 uses the list event's
  // created_at for every item). Visitor items are plain ids — we only
  // have the one list-level timestamp, so addedAt defaults to 0 and the
  // note's own created_at becomes the effective sort key.
  const currentItems = useMemo(() => {
    if (isOwner) return activeCategory ? activeCategory.items : []
    return (visitorIds || []).map(id => ({ id, addedAt: 0 }))
  }, [isOwner, activeCategory, visitorIds])

  const currentIds = useMemo(() => currentItems.map(it => it.id), [currentItems])

  // Feed key invalidates the prefetch whenever the active id set shifts
  // — this is how add/remove round-trips into the sorted list. First/
  // last/length fingerprint is cheap and collides vanishingly rarely.
  const feedKey = useMemo(() => {
    const tag = `${currentIds.length}:${currentIds[0]?.slice(0, 8) || ''}:${currentIds[currentIds.length - 1]?.slice(0, 8) || ''}`
    if (isOwner) return `bookmarks:owner:${pubkey || ''}:${activeCategoryId || ''}:${tag}`
    return `bookmarks:visitor:${pubkey || ''}:${tag}`
  }, [isOwner, pubkey, activeCategoryId, currentIds])

  // Prefetched+sorted cache. One fetch per feedKey; pagination is pure
  // local slicing after that. Sort is (addedAt desc, created_at desc)
  // so "date bookmarked" wins when meaningful and the note's own
  // timestamp breaks ties (the whole order for 10003 where everyone
  // shares one addedAt).
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

  const waitingOnInitial = isOwner
    ? (bookmarksLoading && categories.length === 0)
    : visitorIds === null

  const feed = useInfiniteFeed({
    key: feedKey,
    loadPage,
    pageSize: 20,
    enabled: !!pubkey && !waitingOnInitial && currentIds.length > 0,
  })

  // Live filter: drop any already-paginated note that's no longer in the
  // active id set (e.g., user just removed it or moved it).
  const allowedIdSet = useMemo(() => new Set(currentIds), [currentIds])
  const displayedItems = useMemo(
    () => feed.items.filter(n => allowedIdSet.has(n.id)),
    [feed.items, allowedIdSet],
  )

  // ── Render ─────────────────────────────────────────────────────────
  if (!pubkey) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-4 py-10 text-center">
          <p className="text-xs text-neutral-500">No user loaded.</p>
        </div>
      </div>
    )
  }

  if (waitingOnInitial) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-4 py-10 text-center">
          <span className="inline-block w-5 h-5 border-2 border-neutral-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-neutral-500 mt-2">Loading bookmarks…</p>
        </div>
      </div>
    )
  }

  if (!isOwner && visitorError) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-4 py-10 text-center">
          <p className="text-xs text-red-400">{visitorError}</p>
        </div>
      </div>
    )
  }

  const chipBar = isOwner ? (
    <BookmarkChipBar
      categories={categories}
      activeCategoryId={activeCategoryId}
      onSelect={setActiveCategoryId}
      onCreateCategory={createCategory}
    />
  ) : null

  // Owner with zero categories → chip bar still renders (so they can
  // create one via "+ New"), feed pane shows an empty-state hint.
  if (isOwner && categories.length === 0) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <BookmarkChipBar
          categories={[]}
          activeCategoryId={null}
          onSelect={setActiveCategoryId}
          onCreateCategory={createCategory}
        />
        <div className="max-w-xl mx-auto w-full px-4 py-10 text-center">
          <p className="text-xs text-neutral-500">
            You haven’t bookmarked any notes yet.
          </p>
        </div>
      </div>
    )
  }

  const emptyMessage = isOwner
    ? (activeCategory
        ? `Nothing in ${activeCategory.title} yet.`
        : 'You haven’t bookmarked any notes yet.')
    : `${displayName} hasn’t bookmarked any public notes.`

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {chipBar}
      <NotesFeed
        items={displayedItems}
        profiles={feed.profiles}
        loading={feed.loading}
        initialLoading={feed.initialLoading}
        error={feed.error}
        done={feed.done}
        sentinelRef={feed.sentinelRef}
        emptyMessage={emptyMessage}
        onReload={feed.reload}
      />
    </div>
  )
}
