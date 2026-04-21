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
 *   Visitor view — same chip bar, read-only. Delegates to
 *   AuthorBookmarksPane, which fetches the author's 10003/30001/30003
 *   events, parses them into categories, and renders the chip bar
 *   without the "+ New" affordance so visitors can filter through every
 *   category the author has published.
 *
 * Live filtering: the active category's items are the authoritative id
 * set. We filter feed.items against that Set at render time so a
 * just-removed note drops out instantly (no scroll reset).
 *
 * Public / Private view (owner-only): a pill at the top of the tab
 * flips between the public `items` bucket and the NIP-51 encrypted
 * `privateItems` bucket. Every downstream UI affordance (chip counts,
 * feed content, bulk actions, lock indicator) keys off the active
 * `privacyView`. Visitors never see private bookmarks — the AuthorPane
 * only renders the owner's public items.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchNotesByIds, fetchProfiles } from '../../../../lib/primal.js'
import { useInfiniteFeed } from '../../../../hooks/useInfiniteFeed.js'
import { useNoteBookmarksContext } from '../../noteBookmarksContext.jsx'
import { NOTE_PRIMARY_CATEGORY_ID } from '../../../../lib/useNoteBookmarks.js'
import BookmarkChipBar from './BookmarkChipBar.jsx'
import NotesFeed from './NotesFeed.jsx'
import NoteThreadView from './NoteThreadView.jsx'
import AuthorBookmarksPane from './AuthorBookmarksPane.jsx'

export default function BookmarksTab({ user, isOwner }) {
  const pubkey = user?.pubkey
  const displayName = user?.profile?.displayName || user?.profile?.name || 'this user'

  const {
    categories,
    loading: bookmarksLoading,
    createCategory,
    bulkMove,
    bulkRemove,
    bulkMoveToNew,
    bulkMovePrivacy,
    renameCategory,
    deleteCategory,
    hiddenIdsByView,
    hideCategory,
    unhideCategory,
  } = useNoteBookmarksContext()

  // Public / Private view toggle. Owner-only surface. Defaults to public
  // on every fresh mount — the private bucket is a deliberate opt-in
  // rather than sticky across sessions (don't leave a shoulder-surfer on
  // the last known state). Selection + category bucket semantics key off
  // this, so switching privacy always wipes the selection.
  const [privacyView, setPrivacyView] = useState('public')
  const isPrivate = privacyView === 'private'

  // Hiding is per-privacy-view: a category hidden on public can still be
  // visible on private (e.g., a "Sensitive" set you never want on your
  // public chip bar). `hiddenIds` below is always the active view's set;
  // the hide/unhide handlers pass the active view down to the hook so
  // the write lands in the right bucket.
  const hiddenIds = hiddenIdsByView?.[privacyView] || new Set()

  // Thread stack — clicking any bookmarked note opens the thread view.
  const [threadStack, setThreadStack] = useState([])
  const openThread  = useCallback(note => setThreadStack(s => [...s, note]), [])
  const closeThread = useCallback(() => setThreadStack(s => s.slice(0, -1)), [])

  // ── Owner: bulk-select state ────────────────────────────────────────
  // Checkboxes are always visible in the owner bookmark feed. The bulk
  // action bar slides in when at least one note is selected. Selection
  // clears on category switch (the ids belong to the old bucket) and
  // after any successful bulk action.
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [moveMenuOpen, setMoveMenuOpen] = useState(false)
  const [creatingNewMoveTarget, setCreatingNewMoveTarget] = useState(false)
  const [newMoveTargetName, setNewMoveTargetName] = useState('')
  // Destination privacy for the Move-to menu. Defaults to the current
  // view so the common case ("move these private bookmarks to Category
  // X, keep them private") is a single click. Reset whenever the menu
  // closes so the next open doesn't remember a prior cross-bucket move.
  const [moveTargetPrivacy, setMoveTargetPrivacy] = useState('public')
  // Inline confirm state for bulk-remove — the Remove button flips to
  // "Confirm?  Yes / No" on first click instead of popping a native
  // browser prompt (matches the longform module's pattern).
  const [confirmBulkRemove, setConfirmBulkRemove] = useState(false)
  const moveMenuRef = useRef(null)
  const newMoveInputRef = useRef(null)

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
    setMoveMenuOpen(false)
    setCreatingNewMoveTarget(false)
    setNewMoveTargetName('')
    setConfirmBulkRemove(false)
  }, [])

  // "Select all" grabs every id in the current category bucket — not
  // just the paginated slice — so bulk ops operate on the whole
  // category even if the user hasn't scrolled the feed to the bottom.
  // No-op when there's nothing to select.
  const selectAll = useCallback((ids) => {
    if (!ids || ids.length === 0) return
    setSelectedIds(new Set(ids))
  }, [])

  // Close move dropdown on outside click.
  useEffect(() => {
    if (!moveMenuOpen) return
    function onDown(e) {
      if (!moveMenuRef.current?.contains(e.target)) {
        setMoveMenuOpen(false)
        setCreatingNewMoveTarget(false)
        setNewMoveTargetName('')
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [moveMenuOpen])

  // Whenever the Move-to menu opens, seed the destination privacy with
  // the active view — the common case is "same bucket, different
  // category." Closing the menu resets it so a prior session doesn't
  // leak across opens.
  useEffect(() => {
    if (moveMenuOpen) setMoveTargetPrivacy(privacyView)
  }, [moveMenuOpen, privacyView])

  useEffect(() => {
    if (creatingNewMoveTarget) newMoveInputRef.current?.focus()
  }, [creatingNewMoveTarget])

  // ── Owner: category chip state ──────────────────────────────────────
  const [activeCategoryId, setActiveCategoryId] = useState(null)
  const [manageMode, setManageMode] = useState(false)

  // Exit manage mode whenever the category set drops to "nothing editable"
  // (just primary, or empty). Prevents an orphan "Done" button lingering.
  useEffect(() => {
    if (!manageMode) return
    const hasEditable = categories.some(c => c.id !== NOTE_PRIMARY_CATEGORY_ID && !c.readOnly)
    if (!hasEditable) setManageMode(false)
  }, [manageMode, categories])

  const handleRenameCategory = useCallback(async (categoryId, nextTitle) => {
    await renameCategory(categoryId, nextTitle)
  }, [renameCategory])

  const handleHideCategory = useCallback((categoryId) => {
    // Outside manage mode, hiding the currently-active chip would leave a
    // blank feed; snap to primary first.
    if (!manageMode && activeCategoryId === categoryId) {
      setActiveCategoryId(NOTE_PRIMARY_CATEGORY_ID)
    }
    hideCategory(categoryId, privacyView)
  }, [manageMode, activeCategoryId, hideCategory, privacyView])

  const handleUnhideCategory = useCallback((categoryId) => {
    unhideCategory(categoryId, privacyView)
  }, [unhideCategory, privacyView])

  // The ChipBar now owns the inline "Delete?" confirmation UI (matches the
  // pattern used by the longform BookmarksPanel), so this handler fires
  // only after the user has already said Yes.
  const handleDeleteCategory = useCallback(async (categoryId) => {
    // If the deleted category is currently active, snap back to primary
    // before the effect auto-picks a different default (avoids a
    // noticeable flicker where another category is briefly selected).
    if (activeCategoryId === categoryId) setActiveCategoryId(NOTE_PRIMARY_CATEGORY_ID)
    await deleteCategory(categoryId)
  }, [deleteCategory, activeCategoryId])

  // Switching categories invalidates the selection (those ids belong to
  // the previous bucket and we don't want to move notes the user can't
  // see). Same deal when toggling the public/private view — the ids we
  // had selected live in the other bucket.
  useEffect(() => {
    setSelectedIds(new Set())
    setMoveMenuOpen(false)
    setConfirmBulkRemove(false)
  }, [activeCategoryId, privacyView])

  // Pick a sensible default chip once data is available. Prefer primary
  // if it exists, else the first non-hidden custom category. Also bounce
  // off a hidden chip if the user hides the one they're currently
  // viewing (outside manage mode; inside manage mode hidden chips stay
  // selectable so unhide is reachable from any chip).
  useEffect(() => {
    if (!isOwner) return
    if (categories.length === 0) {
      if (activeCategoryId) setActiveCategoryId(null)
      return
    }
    const current = categories.find(c => c.id === activeCategoryId)
    const currentHiddenOutsideManage = current && hiddenIds.has(current.id) && !manageMode
    if (current && !currentHiddenOutsideManage) return
    const primary = categories.find(c => c.id === NOTE_PRIMARY_CATEGORY_ID)
    if (primary) {
      setActiveCategoryId(primary.id)
      return
    }
    const firstVisible = categories.find(c => !hiddenIds.has(c.id))
    setActiveCategoryId(firstVisible ? firstVisible.id : categories[0].id)
  }, [isOwner, categories, activeCategoryId, hiddenIds, manageMode])

  const activeCategory = categories.find(c => c.id === activeCategoryId) || null

  // Owner items carry an addedAt (kind 30003 has per-item timestamps in
  // our JSON content extension; kind 10003 uses the list event's
  // created_at for every item). Private-view reads the parallel
  // privateItems bucket instead.
  const currentItems = useMemo(() => {
    if (!activeCategory) return []
    return isPrivate ? (activeCategory.privateItems || []) : (activeCategory.items || [])
  }, [activeCategory, isPrivate])

  const currentIds = useMemo(() => currentItems.map(it => it.id), [currentItems])

  // Feed key invalidates the prefetch whenever the active id set shifts
  // — this is how add/remove round-trips into the sorted list. First/
  // last/length fingerprint is cheap and collides vanishingly rarely.
  // Privacy view is baked into the key so switching public↔private
  // rebuilds from the right bucket. Visitor mode delegates to
  // AuthorBookmarksPane (early-return below) so this key is only
  // consumed in owner mode.
  const feedKey = useMemo(() => {
    const tag = `${currentIds.length}:${currentIds[0]?.slice(0, 8) || ''}:${currentIds[currentIds.length - 1]?.slice(0, 8) || ''}`
    return `bookmarks:owner:${pubkey || ''}:${privacyView}:${activeCategoryId || ''}:${tag}`
  }, [pubkey, privacyView, activeCategoryId, currentIds])

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

  const waitingOnInitial = bookmarksLoading && categories.length === 0

  const feed = useInfiniteFeed({
    key: feedKey,
    loadPage,
    pageSize: 20,
    enabled: isOwner && !!pubkey && !waitingOnInitial && currentIds.length > 0,
  })

  const handleBulkMove = useCallback(async (targetCategoryId) => {
    if (selectedIds.size === 0) return
    const ids = [...selectedIds]
    const privacy = moveTargetPrivacy
    clearSelection()
    await bulkMove(targetCategoryId, ids, { privacy })
  }, [selectedIds, bulkMove, clearSelection, moveTargetPrivacy])

  // Atomic create + move in one hook call. Splitting it into
  // createCategory → bulkMove would queue two setCategories updates, and
  // bulkMove's reducer could (and did) race the pending creation and
  // find no target. The hook's bulkMoveToNew does both in one reducer.
  const handleBulkMoveToNew = useCallback(async () => {
    const name = newMoveTargetName.trim()
    if (!name || selectedIds.size === 0) return
    const ids = [...selectedIds]
    const privacy = moveTargetPrivacy
    clearSelection()
    await bulkMoveToNew(name, ids, { privacy })
  }, [newMoveTargetName, selectedIds, bulkMoveToNew, clearSelection, moveTargetPrivacy])

  const handleBulkRemove = useCallback(async () => {
    if (selectedIds.size === 0 || !activeCategoryId) return
    const ids = [...selectedIds]
    clearSelection()
    await bulkRemove(activeCategoryId, ids, { privacy: privacyView })
  }, [selectedIds, activeCategoryId, bulkRemove, clearSelection, privacyView])

  // Flip the selection's privacy in place (public ↔ private) within the
  // current category. One publish regardless of selection size.
  const handleBulkFlipPrivacy = useCallback(async () => {
    if (selectedIds.size === 0 || !activeCategoryId) return
    const ids = [...selectedIds]
    const target = isPrivate ? 'public' : 'private'
    clearSelection()
    await bulkMovePrivacy(activeCategoryId, ids, target)
  }, [selectedIds, activeCategoryId, bulkMovePrivacy, clearSelection, isPrivate])

  // Live filter: drop any already-paginated note that's no longer in the
  // active id set (e.g., user just removed it or moved it).
  const allowedIdSet = useMemo(() => new Set(currentIds), [currentIds])
  const displayedItems = useMemo(
    () => feed.items.filter(n => allowedIdSet.has(n.id)),
    [feed.items, allowedIdSet],
  )

  // Hoisted ahead of render because the zero-categories branch renders
  // the toggle too — if we declared these after the early returns the
  // zero-cats path would trip over the const TDZ.
  const privacyToggle = (
    <PrivacyToggle value={privacyView} onChange={setPrivacyView} categories={categories} />
  )

  const emptyMessage = activeCategory
    ? (isPrivate
        ? `No private bookmarks in ${activeCategory.title} yet.`
        : `Nothing in ${activeCategory.title} yet.`)
    : 'You haven’t bookmarked any notes yet.'

  // ── Render ─────────────────────────────────────────────────────────
  if (threadStack.length > 0) {
    const focus = threadStack[threadStack.length - 1]
    return <NoteThreadView focus={focus} onBack={closeThread} onNoteClick={openThread} />
  }

  if (!pubkey) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-4 py-10 text-center">
          <p className="text-xs text-neutral-500">No user loaded.</p>
        </div>
      </div>
    )
  }

  // Visitor view — delegate to the shared pane that fetches the author's
  // 10003 / 30001 / 30003 events, parses them into categories, and renders
  // a read-only chip bar. Same component the Search tab uses when you
  // drill into an author's bookmarks.
  if (!isOwner) {
    return (
      <AuthorBookmarksPane
        pubkey={pubkey}
        emptyMessage={`${displayName} hasn’t bookmarked any public notes.`}
        onNoteClick={openThread}
      />
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

  // Owner with zero categories → chip bar still renders (so they can
  // create one via "+ New"), feed pane shows an empty-state hint.
  if (categories.length === 0) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        {privacyToggle}
        <BookmarkChipBar
          categories={[]}
          activeCategoryId={null}
          onSelect={setActiveCategoryId}
          onCreateCategory={createCategory}
          privacyView={privacyView}
        />
        <div className="max-w-xl mx-auto w-full px-4 py-10 text-center">
          <p className="text-xs text-neutral-500">
            You haven’t bookmarked any notes yet.
          </p>
        </div>
      </div>
    )
  }

  // Move targets: normally exclude the active category (you can't
  // "move" within the same bucket of the same category — that's a no-op).
  // But when the user chose a destination privacy that differs from the
  // current view, the active category IS a meaningful target: it flips
  // the selection's bucket in place, same as the "Make public/private"
  // button. Include it so the Move-to menu is the single source of
  // truth for "where do these go next."
  const moveTargets = categories.filter(c => {
    if (hiddenIds.has(c.id)) return false
    if (c.id === activeCategoryId && moveTargetPrivacy === privacyView) return false
    return true
  })
  const hasSelection = selectedIds.size > 0
  const allSelected = currentIds.length > 0 && selectedIds.size === currentIds.length
  const canShowBulkBar = currentIds.length > 0

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {privacyToggle}
      <BookmarkChipBar
        categories={categories}
        activeCategoryId={activeCategoryId}
        onSelect={setActiveCategoryId}
        onCreateCategory={createCategory}
        manageMode={manageMode}
        onToggleManageMode={setManageMode}
        onRenameCategory={handleRenameCategory}
        onDeleteCategory={handleDeleteCategory}
        hiddenIds={hiddenIds}
        onHideCategory={handleHideCategory}
        onUnhideCategory={handleUnhideCategory}
        privacyView={privacyView}
      />

      {canShowBulkBar && (
        <div className="max-w-xl mx-auto w-full px-4 py-2 border-b border-neutral-800 flex items-center gap-2 text-xs">
          {hasSelection ? (
            <>
              <span className="text-neutral-300 shrink-0">
                {selectedIds.size} selected
              </span>
              <button
                type="button"
                onClick={() => allSelected ? clearSelection() : selectAll(currentIds)}
                className="text-neutral-400 hover:text-neutral-200 transition-colors"
              >
                {allSelected ? 'Deselect all' : `Select all (${currentIds.length})`}
              </button>

              <div ref={moveMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setMoveMenuOpen(v => !v)}
                  className="px-3 py-1 rounded border border-neutral-700 text-neutral-200 hover:bg-neutral-800 transition-colors"
                >
                  Move to…
                </button>
                {moveMenuOpen && (
                  <div className="absolute top-full left-0 mt-1 bg-neutral-900 border border-neutral-700 rounded shadow-lg z-20 min-w-[240px] max-h-80 overflow-y-auto">
                    {/* Save-as privacy pill mirrors the NoteActionsMenu Add
                        submenu. Users can move selected bookmarks to a
                        different category AND flip their privacy in one
                        publish; defaults to the current view on open. */}
                    <div className="px-3 py-2 border-b border-neutral-800 flex items-center justify-between gap-2">
                      <span className="text-[10px] uppercase tracking-wide text-neutral-500">
                        Save as
                      </span>
                      <div className="inline-flex items-center rounded-full border border-neutral-700 bg-neutral-950 p-0.5">
                        <button
                          type="button"
                          onClick={() => setMoveTargetPrivacy('public')}
                          className={`text-[11px] px-2.5 py-0.5 rounded-full transition-colors ${
                            moveTargetPrivacy === 'public'
                              ? 'bg-purple-700 text-white'
                              : 'text-neutral-400 hover:text-neutral-200'
                          }`}
                        >
                          Public
                        </button>
                        <button
                          type="button"
                          onClick={() => setMoveTargetPrivacy('private')}
                          title="NIP-51 encrypted — visible only to you"
                          className={`text-[11px] px-2.5 py-0.5 rounded-full transition-colors inline-flex items-center gap-1 ${
                            moveTargetPrivacy === 'private'
                              ? 'bg-purple-700 text-white'
                              : 'text-neutral-400 hover:text-neutral-200'
                          }`}
                        >
                          <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                            <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
                            <path d="M5.5 7V5a2.5 2.5 0 015 0v2" strokeLinecap="round" />
                          </svg>
                          Private
                        </button>
                      </div>
                    </div>

                    {moveTargets.map(cat => {
                      const isSameCat = cat.id === activeCategoryId
                      return (
                        <button
                          key={cat.id}
                          type="button"
                          onClick={() => handleBulkMove(cat.id)}
                          className="flex items-center justify-between w-full text-left px-3 py-2 text-xs text-neutral-200 hover:bg-neutral-800"
                        >
                          <span className="truncate">{cat.title}</span>
                          {isSameCat && (
                            <span className="ml-2 shrink-0 text-[10px] text-neutral-500 italic">
                              flip bucket
                            </span>
                          )}
                        </button>
                      )
                    })}

                    {moveTargets.length > 0 && <div className="border-t border-neutral-800" />}

                    {creatingNewMoveTarget ? (
                      <div className="px-2 py-2">
                        <div className="flex items-center gap-1.5">
                          <input
                            ref={newMoveInputRef}
                            type="text"
                            value={newMoveTargetName}
                            onChange={e => setNewMoveTargetName(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') handleBulkMoveToNew()
                              if (e.key === 'Escape') {
                                setCreatingNewMoveTarget(false)
                                setNewMoveTargetName('')
                              }
                            }}
                            placeholder="New category name…"
                            maxLength={60}
                            className="flex-1 min-w-0 text-xs px-2 py-1.5 rounded bg-neutral-950 border border-purple-500 text-neutral-100 focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={handleBulkMoveToNew}
                            disabled={!newMoveTargetName.trim()}
                            title="Create category + move selection"
                            aria-label="Create category and move selection"
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
                        onClick={() => setCreatingNewMoveTarget(true)}
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
                onClick={handleBulkFlipPrivacy}
                title={isPrivate ? 'Move selected to public bookmarks' : 'Move selected to private bookmarks (NIP-51 encrypted)'}
                className="px-3 py-1 rounded border border-neutral-700 text-neutral-200 hover:bg-neutral-800 transition-colors"
              >
                {isPrivate ? 'Make public' : 'Make private'}
              </button>

              {confirmBulkRemove ? (
                <div className="flex items-center gap-1 px-2" title={`Remove the selected bookmark${selectedIds.size === 1 ? '' : 's'} from ${activeCategory?.title || 'this category'}`}>
                  <span className="text-neutral-400">
                    Remove {selectedIds.size}?
                  </span>
                  <button
                    type="button"
                    onClick={handleBulkRemove}
                    className="px-1.5 text-red-400 hover:text-red-300 transition-colors"
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmBulkRemove(false)}
                    className="px-1.5 text-neutral-500 hover:text-neutral-300 transition-colors"
                  >
                    No
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmBulkRemove(true)}
                  className="px-3 py-1 rounded border border-red-900/60 text-red-400 hover:bg-red-950/50 transition-colors"
                >
                  Remove
                </button>
              )}

              <button
                type="button"
                onClick={clearSelection}
                className="ml-auto text-neutral-400 hover:text-neutral-200"
              >
                Clear
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => selectAll(currentIds)}
              className="text-neutral-400 hover:text-neutral-200 transition-colors"
            >
              Select all ({currentIds.length})
            </button>
          )}
        </div>
      )}

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
        inBookmarksFeed
        onNoteClick={openThread}
        selectMode={true}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelect}
        privateIdSet={isPrivate ? allowedIdSet : null}
      />
    </div>
  )
}

// Top-of-tab Public/Private pill. Total counts across all categories so
// the user has a rough scale before switching (the per-category count
// lives on each chip). Private side gets a small lock glyph + purple
// active state to signal "this bucket is end-to-end encrypted."
function PrivacyToggle({ value, onChange, categories }) {
  let totalPublic = 0
  let totalPrivate = 0
  for (const c of categories || []) {
    totalPublic  += c.items?.length || 0
    totalPrivate += c.privateItems?.length || 0
  }
  return (
    <div className="max-w-xl mx-auto w-full px-4 pt-3 flex items-center gap-2">
      <div className="inline-flex items-center rounded-full border border-neutral-700 bg-neutral-900 p-0.5">
        <button
          type="button"
          onClick={() => onChange('public')}
          className={`text-[11px] px-3 py-1 rounded-full transition-colors ${
            value === 'public'
              ? 'bg-purple-700 text-white'
              : 'text-neutral-400 hover:text-neutral-200'
          }`}
        >
          Public · {totalPublic}
        </button>
        <button
          type="button"
          onClick={() => onChange('private')}
          className={`text-[11px] px-3 py-1 rounded-full transition-colors inline-flex items-center gap-1 ${
            value === 'private'
              ? 'bg-purple-700 text-white'
              : 'text-neutral-400 hover:text-neutral-200'
          }`}
          title="NIP-51 encrypted — visible only to you"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
            <path d="M5.5 7V5a2.5 2.5 0 015 0v2" strokeLinecap="round" />
          </svg>
          Private · {totalPrivate}
        </button>
      </div>
    </div>
  )
}
