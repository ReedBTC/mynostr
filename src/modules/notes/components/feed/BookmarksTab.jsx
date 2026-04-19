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

  // ── Unified id list for the active view ─────────────────────────────
  const currentIds = useMemo(() => {
    if (isOwner) return activeCategory ? activeCategory.items.map(it => it.id) : []
    return visitorIds || []
  }, [isOwner, activeCategory, visitorIds])

  // The pagination cursor walks through currentIds in slices. Both it and
  // the id list itself live in refs so loadPage stays stable across
  // mutations — we don't want the feed hook to tear down and refetch when
  // the user adds or removes a note from the active chip.
  const idsRef = useRef([])
  useEffect(() => { idsRef.current = currentIds }, [currentIds])
  const cursorRef = useRef(0)

  // Key: pubkey + chip identity. Changes → feed resets to page 1.
  const feedKey = useMemo(() => {
    if (isOwner) return `bookmarks:owner:${pubkey || ''}:${activeCategoryId || ''}`
    return `bookmarks:visitor:${pubkey || ''}:${(visitorIds || []).length}`
  }, [isOwner, pubkey, activeCategoryId, visitorIds])

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
