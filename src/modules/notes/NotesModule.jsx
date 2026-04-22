/**
 * NotesModule — Module 2
 *
 * Four tabs, mirroring Longform:
 *   Write         — composer (owner only); multi-draft, tray on left desktop
 *                   and bottom sheet on mobile
 *   My Notes      — kind 1 feed for the viewed user (infinite scroll)
 *   My Bookmarks  — paginated feed of the viewed user's kind 10003 bookmarks
 *   Search        — author / note dropdown, loads a feed or pins a single note
 *
 * Visitors (non-owners) see just Notes · Bookmarks, matching Longform's
 * Articles · Collection visitor view.
 *
 * The Write pane is always mounted (hidden via CSS) so the draft list +
 * in-memory composer state survive a detour through the other tabs.
 */
import { useState, useEffect, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import NoteComposer from './components/NoteComposer.jsx'
import DraftsTray from './components/DraftsTray.jsx'
import MyNotesTab from './components/feed/MyNotesTab.jsx'
import BookmarksTab from './components/feed/BookmarksTab.jsx'
import SearchTab from './components/feed/SearchTab.jsx'
import { NoteBookmarksProvider } from './noteBookmarksContext.jsx'
import { UserReactionsProvider } from './userReactionsContext.jsx'
import { NotesNavigationProvider } from './notesNavigationContext.jsx'
import { useOwnerContext } from '../../lib/ownerContext.jsx'
import { useNoteDrafts } from '../../lib/useNoteDrafts.js'
import { useIsMobile } from '../../hooks/useIsMobile.js'
import { buildDraftSnapshotFromEvent } from '../../lib/draftFromEvent.js'
import { validateKind1Event } from '../../lib/noteParser.js'

export default function NotesModule({ user, sessionUser }) {
  const { isOwner } = useOwnerContext()
  const location = useLocation()
  const navigate = useNavigate()
  const isMobile = useIsMobile()

  const [moduleTab, setModuleTab] = useState(isOwner ? 'write' : 'notes')
  // Author handoff for "click name/pfp → open in Search." Only populated
  // when the owner triggers it; SearchTab consumes it once on mount and
  // calls back to clear so re-opening the same author still works.
  const [searchInitialAuthor, setSearchInitialAuthor] = useState(null)
  // One-shot Notes/Comments mode hint for MyNotesTab, seeded by location.state
  // before the initialTab effect nulls it out.
  const [notesInitialMode, setNotesInitialMode] = useState(null)

  // Multi-draft state — persisted per-pubkey in localStorage by the hook.
  // Only meaningful for the page owner (visitors can't publish).
  const {
    drafts,
    currentDraft,
    currentDraftId,
    setCurrentDraftId,
    createDraft,
    updateDraftWith,
    deleteDraft,
    deleteAllDrafts,
    clearDraft,
    publishOne,
    publishAll,
  } = useNoteDrafts(isOwner ? sessionUser?.pubkey : null)

  const [draftsMobileOpen, setDraftsMobileOpen] = useState(false)

  // Cross-module Comment / Quote deep-link. Any feed can push
  // `{ composerPrefill: { replyTo?, quote? } }` into router state when
  // navigating here; we open a NEW draft (not replace current) seeded
  // with the prefill, force the Write tab, and strip the state from
  // history so back/forward doesn't replay the prefill.
  useEffect(() => {
    const pending = location.state?.composerPrefill
    if (!pending) return
    if (!isOwner) return
    const { replyTo, quote } = pending
    createDraft({
      snapshot: {
        ...(replyTo && { replyToInput: replyTo }),
        ...(quote && { quoteInput: quote }),
      },
    })
    setModuleTab('write')
    navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, isOwner, createDraft, navigate])

  // Cross-module deep-link that requests a specific sub-tab (e.g. Profile's
  // stats-card cells landing on "notes" instead of the owner's default
  // "write"). Also forwards an optional `initialMode` to MyNotesTab for
  // Notes vs Comments landing. Consumed once and cleared so back/forward
  // can't replay it.
  useEffect(() => {
    const target = location.state?.initialTab
    if (!target) return
    setModuleTab(target)
    if (location.state?.initialMode) setNotesInitialMode(location.state.initialMode)
    navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])

  // Multi-JSON import — each file becomes a new draft. Size-capped per file
  // to match the single-file import path. Returns a summary so the tray can
  // surface per-file errors without blocking the successful ones.
  const handleImportDrafts = useCallback(async (files) => {
    const result = { imported: 0, errors: [] }
    for (const file of files) {
      const name = file.name || 'file'
      if (!name.endsWith('.json') && file.type !== 'application/json') {
        result.errors.push(`${name}: not a .json file`)
        continue
      }
      if (file.size > 1_000_000) {
        result.errors.push(`${name}: over 1 MB`)
        continue
      }
      try {
        const text = await file.text()
        const json = JSON.parse(text)
        const { valid, errors, event } = validateKind1Event(json)
        if (!valid) {
          result.errors.push(`${name}: ${errors.join('; ')}`)
          continue
        }
        const snapshot = await buildDraftSnapshotFromEvent(event, sessionUser?.pubkey)
        // Seed publishable directly from the imported event so Export-all
        // and Publish-all work immediately, before the user opens the draft.
        createDraft({
          snapshot,
          publishable: { content: event.content || '', tags: event.tags || [] },
        })
        result.imported++
      } catch (e) {
        result.errors.push(`${name}: ${e.message || 'invalid JSON'}`)
      }
    }
    return result
  }, [createDraft, sessionUser?.pubkey])

  // Export every draft with a valid publishable payload as its own JSON file.
  // Staggered downloads give the browser's "allow multiple downloads" prompt
  // a single moment to fire rather than one per file.
  const handleExportAllDrafts = useCallback(() => {
    const eligible = drafts.filter(d => d.publishable?.content?.trim())
    const result = { exported: 0, skipped: drafts.length - eligible.length }
    eligible.forEach((d, idx) => {
      const { content, tags } = d.publishable
      const event = {
        kind: 1,
        pubkey: sessionUser?.pubkey || '',
        created_at: Math.floor(Date.now() / 1000),
        content,
        tags,
      }
      const blob = new Blob([JSON.stringify(event, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const preview = (content.trim().split('\n')[0] || '')
        .slice(0, 24)
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
      const a = document.createElement('a')
      a.href = url
      a.download = `note-${String(idx + 1).padStart(2, '0')}${preview ? `-${preview}` : ''}.json`
      setTimeout(() => { a.click(); URL.revokeObjectURL(url) }, idx * 150)
      result.exported++
    })
    return result
  }, [drafts, sessionUser?.pubkey])

  const openAuthorInSearch = useCallback((author) => {
    if (!isOwner || !author?.pubkey) return
    setSearchInitialAuthor(author)
    setModuleTab('search')
  }, [isOwner])

  // If a visitor somehow lands on an owner-only tab (e.g. a stale URL or
  // coming back after logout), bounce to the default visitor tab.
  useEffect(() => {
    if (!isOwner && (moduleTab === 'write' || moduleTab === 'search')) {
      setModuleTab('notes')
    }
  }, [isOwner, moduleTab])

  const isWriteActive = moduleTab === 'write' && isOwner

  // Cmd/Ctrl+N for a new draft — only when the Write tab is active and the
  // user isn't typing inside a form field.
  useEffect(() => {
    if (!isWriteActive) return
    const handler = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'n') return
      // Let the browser handle the default new-window if modifiers other
      // than cmd/ctrl are in play (e.g. cmd+shift+n = new private window).
      if (e.shiftKey || e.altKey) return
      e.preventDefault()
      createDraft()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isWriteActive, createDraft])

  const notesLabel     = isOwner ? 'My Notes'     : 'Notes'
  const bookmarksLabel = isOwner ? 'My Bookmarks' : 'Bookmarks'

  const visibleTabs = isOwner
    ? [
        { id: 'write',     label: 'Write' },
        { id: 'notes',     label: notesLabel },
        { id: 'bookmarks', label: bookmarksLabel },
        { id: 'search',    label: 'Search' },
      ]
    : [
        { id: 'notes',     label: notesLabel },
        { id: 'bookmarks', label: bookmarksLabel },
      ]

  const handleSnapshotChange = useCallback((id, patch) => {
    updateDraftWith(id, (d) => ({ ...d, ...patch }))
  }, [updateDraftWith])

  return (
    <NoteBookmarksProvider user={sessionUser}>
    <UserReactionsProvider user={sessionUser}>
    <NotesNavigationProvider openAuthorInSearch={isOwner ? openAuthorInSearch : null}>
    <div className="flex flex-col flex-1 overflow-hidden">

      {/* ── Tab bar ── */}
      <div className="flex items-center gap-0 px-4 py-2.5 border-b border-neutral-800 flex-shrink-0">
        <div className="flex items-center gap-0 flex-shrink-0">
          {visibleTabs.map(({ id, label }, i, arr) => {
            const isActive = moduleTab === id
            return (
              <button
                key={id}
                onClick={() => setModuleTab(id)}
                className={`text-xs px-2.5 py-1 border transition-colors
                  ${i === 0 ? 'rounded-l' : ''} ${i === arr.length - 1 ? 'rounded-r' : ''}
                  ${isActive
                    ? 'bg-neutral-800 border-neutral-600 text-neutral-200'
                    : 'border-neutral-800 text-neutral-600 hover:text-neutral-400'
                  }`}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Write — always mounted for the page owner so draft state survives ── */}
      {isOwner && (
        <div
          className="flex flex-1 overflow-hidden"
          style={{ display: isWriteActive ? 'flex' : 'none' }}
        >
          {!isMobile && (
            <DraftsTray
              drafts={drafts}
              currentDraftId={currentDraftId}
              onSelectDraft={setCurrentDraftId}
              onCreateDraft={() => createDraft()}
              onDeleteDraft={deleteDraft}
              onDeleteAllDrafts={deleteAllDrafts}
              onImportDrafts={handleImportDrafts}
              onExportAllDrafts={handleExportAllDrafts}
              onPublishAll={publishAll}
            />
          )}
          {currentDraft && (
            <NoteComposer
              key={currentDraft.id}
              user={user}
              draft={currentDraft}
              draftCount={drafts.length}
              onSnapshotChange={(patch) => handleSnapshotChange(currentDraft.id, patch)}
              onPublish={() => publishOne(currentDraft.id)}
              onClear={() => clearDraft(currentDraft.id)}
              onAckPublished={() => deleteDraft(currentDraft.id)}
              onOpenDraftsMobile={isMobile ? () => setDraftsMobileOpen(true) : undefined}
            />
          )}
          {isMobile && (
            <DraftsTray
              isMobile
              isMobileOpen={draftsMobileOpen}
              onMobileClose={() => setDraftsMobileOpen(false)}
              drafts={drafts}
              currentDraftId={currentDraftId}
              onSelectDraft={setCurrentDraftId}
              onCreateDraft={() => createDraft()}
              onDeleteDraft={deleteDraft}
              onDeleteAllDrafts={deleteAllDrafts}
              onImportDrafts={handleImportDrafts}
              onExportAllDrafts={handleExportAllDrafts}
              onPublishAll={publishAll}
            />
          )}
        </div>
      )}

      {/* ── Read-mode tabs — feed panes. Unmounted when not active so each
           tab starts fresh on next visit (cheap; the author/bookmark fetch
           is cached by Primal's singleton socket anyway). */}
      {!isWriteActive && moduleTab === 'notes' && (
        <MyNotesTab
          user={user}
          isOwner={isOwner}
          initialMode={notesInitialMode}
          onInitialModeConsumed={() => setNotesInitialMode(null)}
        />
      )}
      {!isWriteActive && moduleTab === 'bookmarks' && (
        <BookmarksTab user={user} isOwner={isOwner} />
      )}
      {!isWriteActive && moduleTab === 'search' && isOwner && (
        <SearchTab
          initialAuthor={searchInitialAuthor}
          onInitialAuthorConsumed={() => setSearchInitialAuthor(null)}
        />
      )}
    </div>
    </NotesNavigationProvider>
    </UserReactionsProvider>
    </NoteBookmarksProvider>
  )
}
