/**
 * AuthorBookmarksPane — paginated feed of kind 1 notes that an arbitrary
 * author has publicly bookmarked, split by bookmark category.
 *
 * Fetches the author's kind 10003 (primary "Bookmarks") and kind 30003
 * (custom categories) events via useAuthorBookmarkCategories. Renders the
 * same BookmarkChipBar used by the owner's My Bookmarks tab in read-only
 * mode (no "+ New") so viewers can filter by category.
 *
 * If the viewer is signed in (canEdit from NoteBookmarksContext), each
 * card gets a checkbox and a "Bookmark to…" bulk bar appears once
 * anything is selected — so readers can scoop interesting picks straight
 * into one of their own categories (or spin up a new one). Under the
 * hood this reuses `bulkMove` / `bulkMoveToNew` from the viewer's
 * bookmarks hook — if a selected note is already in one of the viewer's
 * buckets, it will move (mutually-exclusive buckets is the current
 * contract; same behavior as My Bookmarks → Move to…).
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
import { useNoteBookmarksContext } from '../../noteBookmarksContext.jsx'
import BookmarkChipBar from './BookmarkChipBar.jsx'
import NotesFeed from './NotesFeed.jsx'

export default function AuthorBookmarksPane({ pubkey, emptyMessage, onNoteClick }) {
  const { categories, loading } = useAuthorBookmarkCategories(pubkey)
  const {
    categories: ownCategories,
    canEdit,
    bulkMove,
    bulkMoveToNew,
  } = useNoteBookmarksContext()

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

  // ── Viewer's bulk-select state (only meaningful if canEdit) ──────────
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [bookmarkMenuOpen, setBookmarkMenuOpen] = useState(false)
  const [creatingNewTarget, setCreatingNewTarget] = useState(false)
  const [newTargetName, setNewTargetName] = useState('')
  const bookmarkMenuRef = useRef(null)
  const newTargetInputRef = useRef(null)

  const toggleSelect = useCallback((id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    setBookmarkMenuOpen(false)
    setCreatingNewTarget(false)
    setNewTargetName('')
  }, [])

  // Switching author's categories invalidates the selection (those ids
  // belong to the previous bucket).
  useEffect(() => {
    setSelectedIds(new Set())
    setBookmarkMenuOpen(false)
  }, [activeCategoryId, pubkey])

  // Close bookmark dropdown on outside click.
  useEffect(() => {
    if (!bookmarkMenuOpen) return
    function onDown(e) {
      if (!bookmarkMenuRef.current?.contains(e.target)) {
        setBookmarkMenuOpen(false)
        setCreatingNewTarget(false)
        setNewTargetName('')
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [bookmarkMenuOpen])

  useEffect(() => {
    if (creatingNewTarget) newTargetInputRef.current?.focus()
  }, [creatingNewTarget])

  const handleBulkBookmarkTo = useCallback(async (targetCategoryId) => {
    if (selectedIds.size === 0) return
    const ids = [...selectedIds]
    clearSelection()
    await bulkMove(targetCategoryId, ids)
  }, [selectedIds, bulkMove, clearSelection])

  const handleBulkBookmarkToNew = useCallback(async () => {
    const name = newTargetName.trim()
    if (!name || selectedIds.size === 0) return
    const ids = [...selectedIds]
    clearSelection()
    await bulkMoveToNew(name, ids)
  }, [newTargetName, selectedIds, bulkMoveToNew, clearSelection])

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

  const hasSelection = selectedIds.size > 0

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <BookmarkChipBar
        categories={categories}
        activeCategoryId={activeCategoryId}
        onSelect={setActiveCategoryId}
        readOnly
      />

      {canEdit && hasSelection && (
        <div className="max-w-xl mx-auto w-full px-4 py-2 border-b border-neutral-800 flex items-center gap-2 text-xs">
          <span className="text-neutral-300 shrink-0">
            {selectedIds.size} selected
          </span>

          <div ref={bookmarkMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setBookmarkMenuOpen(v => !v)}
              className="px-3 py-1 rounded border border-neutral-700 text-neutral-200 hover:bg-neutral-800 transition-colors"
            >
              Bookmark to…
            </button>
            {bookmarkMenuOpen && (
              <div className="absolute top-full left-0 mt-1 bg-neutral-900 border border-neutral-700 rounded shadow-lg z-20 min-w-[200px] max-h-72 overflow-y-auto">
                {ownCategories.map(cat => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => handleBulkBookmarkTo(cat.id)}
                    className="block w-full text-left px-3 py-2 text-xs text-neutral-200 hover:bg-neutral-800"
                  >
                    {cat.title}
                  </button>
                ))}

                {ownCategories.length > 0 && <div className="border-t border-neutral-800" />}

                {creatingNewTarget ? (
                  <div className="px-2 py-2">
                    <div className="flex items-center gap-1.5">
                      <input
                        ref={newTargetInputRef}
                        type="text"
                        value={newTargetName}
                        onChange={e => setNewTargetName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleBulkBookmarkToNew()
                          if (e.key === 'Escape') {
                            setCreatingNewTarget(false)
                            setNewTargetName('')
                          }
                        }}
                        placeholder="New category name…"
                        maxLength={60}
                        className="flex-1 min-w-0 text-xs px-2 py-1.5 rounded bg-neutral-950 border border-purple-500 text-neutral-100 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={handleBulkBookmarkToNew}
                        disabled={!newTargetName.trim()}
                        title="Create category + bookmark selection"
                        aria-label="Create category and bookmark selection"
                        className="shrink-0 w-7 h-7 rounded bg-purple-600 hover:bg-purple-500 text-white flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                          <path d="M3 7.5l3 3 5-7" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                    </div>
                    <p className="mt-1 text-[10px] text-neutral-500">
                      Enter / ✓ to confirm · Esc to cancel
                    </p>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setCreatingNewTarget(true)}
                    className="block w-full text-left px-3 py-2 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800"
                  >
                    + New category…
                  </button>
                )}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={clearSelection}
            className="ml-auto text-neutral-400 hover:text-neutral-200"
          >
            Clear
          </button>
        </div>
      )}

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
        selectMode={canEdit}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelect}
      />
    </div>
  )
}
