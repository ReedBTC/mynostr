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
import ShareButton from '../../components/ShareButton.jsx'
import NoteComposer from './components/NoteComposer.jsx'
import DraftsTray from './components/DraftsTray.jsx'
import MyNotesTab from './components/feed/MyNotesTab.jsx'
import BookmarksTab from './components/feed/BookmarksTab.jsx'
import SearchTab from './components/feed/SearchTab.jsx'
import NoteDetailView from './components/feed/NoteDetailView.jsx'
import { NoteBookmarksProvider } from './noteBookmarksContext.jsx'
import { NotesNavigationProvider } from './notesNavigationContext.jsx'
import { useOwnerContext } from '../../lib/ownerContext.jsx'
import { useNoteDrafts } from '../../lib/useNoteDrafts.js'
import { useIsMobile } from '../../hooks/useIsMobile.js'
import { buildDraftSnapshotFromEvent } from '../../lib/draftFromEvent.js'
import {
  cancelScheduled as workerCancelScheduled,
  getScheduledEntryLocal,
  onLocalChange as onSchedulerLocalChange,
  MIN_LEAD_SECONDS,
} from '../../lib/scheduler.js'
import { validateKind1Event } from '../../lib/noteParser.js'

export default function NotesModule({ user, sessionUser, subtab }) {
  const { isOwner } = useOwnerContext()
  const location = useLocation()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const npub = user?.npub

  // Detail-page detection — subtab starting with `nevent1` (or `note1`)
  // is a single-note URL. Renders NoteDetailView outside the tab strip,
  // matching how EventsModule handles `naddr1…`.
  const isNoteDetail = typeof subtab === 'string' &&
    (subtab.startsWith('nevent1') || subtab.startsWith('note1'))

  // Derive current tab from URL subtab. The `comments` subtab is special —
  // it lands on the MyNotes tab with the Comments pill pre-selected rather
  // than being its own tab. Unknown / owner-only subtabs visited by a
  // non-owner fall through to the default (see the bounce effect below).
  // Bare `/notes` always means the My Notes feed — Write has its own URL
  // so "My Notes" is reachable via the tab button and shareable links.
  const moduleTab = (() => {
    if (isNoteDetail) return null
    if (subtab === 'comments') return 'notes'
    if (subtab === 'bookmarks') return 'bookmarks'
    if (subtab === 'search' && isOwner) return 'search'
    if (subtab === 'write' && isOwner) return 'write'
    return 'notes'
  })()
  const notesMode = subtab === 'comments' ? 'comments' : 'notes'

  // Helper for navigating between tabs. `notes` default view maps to the
  // bare `/notes` URL; `comments` is a sub-view of it.
  const setModuleTab = useCallback((id) => {
    if (!npub) return
    const path = id === 'notes' ? `/${npub}/notes` : `/${npub}/notes/${id}`
    navigate(path)
  }, [npub, navigate])

  // Author handoff for "click name/pfp → open in Search." Only populated
  // when the owner triggers it; SearchTab consumes it once on mount and
  // calls back to clear so re-opening the same author still works.
  const [searchInitialAuthor, setSearchInitialAuthor] = useState(null)

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
    moveDraft,
    publishOne,
    publishAll,
  } = useNoteDrafts(isOwner ? sessionUser?.pubkey : null)

  const [draftsMobileOpen, setDraftsMobileOpen] = useState(false)

  // Scheduled-item selection — mutually exclusive with a draft selection.
  // When a user clicks a scheduled row, the editor swaps to a locked
  // view of that item. Clicking any draft row clears the scheduled
  // selection (and vice versa).
  const [currentScheduledId, setCurrentScheduledId] = useState(null)
  const [scheduledDraftView, setScheduledDraftView] = useState(null)
  // ^ synthetic draft (id, snapshot) built from the scheduled event
  // when one is selected. Carried in state so a localStorage refresh
  // mid-view doesn't yank the editor's contents.

  const handleSelectScheduled = useCallback(async (eventId) => {
    if (!sessionUser?.pubkey) return
    const entry = getScheduledEntryLocal(sessionUser.pubkey, eventId)
    if (!entry?.event) {
      // Cache miss — caller should have refreshed the list first.
      // Bail silently rather than show an empty editor.
      return
    }
    const snap = await buildDraftSnapshotFromEvent(entry.event, sessionUser.pubkey)
    setScheduledDraftView({
      id: `scheduled-${eventId}`,
      snapshot: snap,
      status: 'idle',
      // Carry the signed event through so the composer's locked banner
      // can encode it as nevent / note id for copy actions. The
      // synthetic draft's snapshot doesn't preserve sig/id, but the
      // copy menu needs them.
      sourceEvent: entry.event,
    })
    setCurrentScheduledId(eventId)
    // Don't clear currentDraftId — the underlying draft state is
    // preserved so clicking back to a draft row restores it
    // immediately (we just stop rendering it while a scheduled item
    // is the active selection).
  }, [sessionUser?.pubkey])

  // Cancel-and-edit: remove the scheduled entry from the worker, build
  // a fresh real draft seeded with the same content + publishAt, and
  // select it. If the original publishAt is in the past or too close
  // to fire, bump it forward to the next valid 15-min slot so the
  // freshly-editable composer has a sensible default.
  const handleCancelScheduledAndEdit = useCallback(async () => {
    if (!currentScheduledId || !sessionUser?.pubkey) return
    const entry = getScheduledEntryLocal(sessionUser.pubkey, currentScheduledId)
    try {
      await workerCancelScheduled(currentScheduledId, sessionUser.pubkey)
    } catch (e) {
      // If the worker is down or auth fails, surface in console;
      // user can retry. Don't drop them out of locked view.
      console.warn('[scheduler] cancel failed:', e?.message || e)
      return
    }

    const nowSec = Math.floor(Date.now() / 1000)
    const minPublish = nowSec + MIN_LEAD_SECONDS
    let bumpedPublishAt = entry?.scheduledFor || minPublish
    if (bumpedPublishAt < minPublish) {
      // Round forward to next 15-min boundary at least MIN_LEAD ahead.
      const d = new Date(minPublish * 1000)
      const m = d.getMinutes()
      const next15 = Math.ceil(m / 15) * 15
      if (next15 === 60) {
        d.setHours(d.getHours() + 1)
        d.setMinutes(0, 0, 0)
      } else {
        d.setMinutes(next15, 0, 0)
      }
      bumpedPublishAt = Math.floor(d.getTime() / 1000)
    }

    // Re-derive a draft snapshot from the original signed event, then
    // overwrite publishAt with the bumped value (if changed).
    let snap = null
    if (entry?.event) {
      snap = await buildDraftSnapshotFromEvent(entry.event, sessionUser.pubkey)
      snap.publishAt = bumpedPublishAt
    }
    setCurrentScheduledId(null)
    setScheduledDraftView(null)
    if (snap) {
      createDraft({ snapshot: snap })
      // useNoteDrafts.createDraft selects the new draft automatically.
    }
  }, [currentScheduledId, sessionUser?.pubkey, createDraft])

  // When the user clicks a regular draft row, drop the scheduled view.
  const handleSelectDraft = useCallback((id) => {
    setCurrentDraftId(id)
    setCurrentScheduledId(null)
    setScheduledDraftView(null)
  }, [setCurrentDraftId])

  // Detect when the currently-viewed scheduled item disappears from the
  // local mirror — happens when cron publishes it (worker deletes the
  // KV row, next listScheduled() refresh drops the entry locally) or
  // when another device cancels it. Without this, the composer would
  // stay stranded in viewingScheduled mode pointing at a synthetic
  // draft for an event that no longer exists, and clicking Cancel
  // would error.
  useEffect(() => {
    if (!sessionUser?.pubkey || !currentScheduledId) return
    return onSchedulerLocalChange(() => {
      const entry = getScheduledEntryLocal(sessionUser.pubkey, currentScheduledId)
      if (!entry) {
        setCurrentScheduledId(null)
        setScheduledDraftView(null)
      }
    })
  }, [sessionUser?.pubkey, currentScheduledId])

  // Cross-module Comment / Quote deep-link. Any feed can push
  // `{ composerPrefill: { replyTo?, quote? } }` into router state when
  // navigating here; we open a NEW draft (not replace current) seeded
  // with the prefill, route to the Write tab, and strip the state from
  // history so back/forward doesn't replay the prefill.
  //
  // Single navigate is load-bearing: an earlier two-call dance
  // (setModuleTab + a follow-up pathname/state-clear) raced against
  // itself — the second `replace` stomped the path change, dropping the
  // user back at /notes with the draft silently created but no visible
  // tab switch. One navigate that does both at once avoids the race.
  useEffect(() => {
    const pending = location.state?.composerPrefill
    if (!pending) return
    if (!isOwner) return
    if (!npub) return
    const { replyTo, quote } = pending
    createDraft({
      snapshot: {
        ...(replyTo && { replyToInput: replyTo }),
        ...(quote && { quoteInput: quote }),
      },
    })
    navigate(`/${npub}/notes/write`, { replace: true, state: null })
  }, [location.state, isOwner, npub, createDraft, navigate])

  // Multi-JSON import — each file becomes a new draft. Size-capped per file
  // to match the single-file import path. Returns a summary so the tray can
  // surface per-file errors without blocking the successful ones.
  //
  // If the first draft in the tray was empty before this run (e.g. the
  // hook's freshly-seeded blank draft on first visit), it gets dropped
  // after a successful import so the user ends up with N drafts after
  // importing N — not N + 1 with a leftover empty.
  const handleImportDrafts = useCallback(async (files) => {
    const seedDraft = drafts[0]
    const seedWasEmpty = seedDraft &&
      !seedDraft.snapshot?.content?.trim() &&
      !seedDraft.publishable

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

    if (result.imported > 0 && seedWasEmpty) {
      deleteDraft(seedDraft.id)
    }
    return result
  }, [createDraft, deleteDraft, drafts, sessionUser?.pubkey])

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
        // Sidecar: full UI snapshot (relayOverride, zapSplits, mentions,
        // reply/quote inputs) so re-importing into mynostr restores the
        // composer state exactly. Other Nostr clients ignore unknown
        // top-level keys.
        _mynostr_form: d.snapshot,
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
  }, [isOwner, setModuleTab])

  // If a visitor lands on an owner-only URL (e.g. /notes/write via a stale
  // share or browser back after logout), redirect to the default view.
  useEffect(() => {
    if (!isOwner && (subtab === 'write' || subtab === 'search') && npub) {
      navigate(`/${npub}/notes`, { replace: true })
    }
  }, [isOwner, subtab, npub, navigate])

  // Pill handler for MyNotesTab — flip Notes↔Comments by navigating.
  const handleNotesModeChange = useCallback((mode) => {
    if (!npub) return
    navigate(mode === 'comments' ? `/${npub}/notes/comments` : `/${npub}/notes`)
  }, [npub, navigate])

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

  // Single-note URL: bypass the tab strip entirely and render the
  // dedicated detail view. Wrapped in the bookmark provider so embedded
  // NoteCards / thread cards get bookmark context. Like state is sourced
  // from the cross-module reaction store (no provider needed).
  if (isNoteDetail) {
    return (
      <NoteBookmarksProvider user={sessionUser}>
      <NotesNavigationProvider openAuthorInSearch={isOwner ? openAuthorInSearch : null}>
        <NoteDetailView nevent={subtab} viewerNpub={npub} />
      </NotesNavigationProvider>
      </NoteBookmarksProvider>
    )
  }

  return (
    <NoteBookmarksProvider user={sessionUser}>
    <NotesNavigationProvider openAuthorInSearch={isOwner ? openAuthorInSearch : null}>
    <div className="flex flex-col flex-1 overflow-hidden">

      {/* ── Tab bar ── */}
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-neutral-800 flex-shrink-0">
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
        {/* Share is hidden on Write/Search — Write isn't a shareable
            surface, and Search is owner-only (visitors get redirected). */}
        {moduleTab !== 'write' && moduleTab !== 'search' && (
          <div className="shrink-0">
            <ShareButton variant="button" />
          </div>
        )}
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
              onSelectDraft={handleSelectDraft}
              onCreateDraft={() => createDraft()}
              onDeleteDraft={deleteDraft}
              onDeleteAllDrafts={deleteAllDrafts}
              onImportDrafts={handleImportDrafts}
              onExportAllDrafts={handleExportAllDrafts}
              onPublishAll={publishAll}
              onMoveDraft={moveDraft}
              pubkey={sessionUser?.pubkey || ''}
              currentScheduledId={currentScheduledId}
              onSelectScheduled={handleSelectScheduled}
            />
          )}
          {scheduledDraftView ? (
            <NoteComposer
              key={scheduledDraftView.id}
              user={user}
              draft={scheduledDraftView}
              draftCount={drafts.length}
              viewingScheduled
              onCancelScheduled={handleCancelScheduledAndEdit}
              onOpenDraftsMobile={isMobile ? () => setDraftsMobileOpen(true) : undefined}
            />
          ) : currentDraft && (
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
              onSelectDraft={handleSelectDraft}
              onCreateDraft={() => createDraft()}
              onDeleteDraft={deleteDraft}
              onDeleteAllDrafts={deleteAllDrafts}
              onImportDrafts={handleImportDrafts}
              onExportAllDrafts={handleExportAllDrafts}
              onPublishAll={publishAll}
              onMoveDraft={moveDraft}
              pubkey={sessionUser?.pubkey || ''}
              currentScheduledId={currentScheduledId}
              onSelectScheduled={handleSelectScheduled}
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
          mode={notesMode}
          onModeChange={handleNotesModeChange}
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
    </NoteBookmarksProvider>
  )
}
