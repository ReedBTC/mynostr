/**
 * NotesModule — Module 2
 *
 * Four tabs, mirroring Longform:
 *   Write         — composer (owner only)
 *   My Notes      — kind 1 feed for the viewed user (infinite scroll)
 *   My Bookmarks  — paginated feed of the viewed user's kind 10003 bookmarks
 *   Search        — author / note dropdown, loads a feed or pins a single note
 *
 * Visitors (non-owners) see just Notes · Bookmarks, matching Longform's
 * Articles · Collection visitor view.
 *
 * The Write pane is always mounted (hidden via CSS) so draft state survives
 * a detour through the other tabs — same pattern LongformModule uses.
 */
import { useState, useEffect } from 'react'
import NoteComposer from './components/NoteComposer.jsx'
import MyNotesTab from './components/feed/MyNotesTab.jsx'
import BookmarksTab from './components/feed/BookmarksTab.jsx'
import SearchTab from './components/feed/SearchTab.jsx'
import { NoteBookmarksProvider } from './noteBookmarksContext.jsx'
import { useOwnerContext } from '../../lib/ownerContext.jsx'

export default function NotesModule({ user, sessionUser }) {
  const { isOwner } = useOwnerContext()

  const [moduleTab, setModuleTab] = useState(isOwner ? 'write' : 'notes')

  // If a visitor somehow lands on an owner-only tab (e.g. a stale URL or
  // coming back after logout), bounce to the default visitor tab.
  useEffect(() => {
    if (!isOwner && (moduleTab === 'write' || moduleTab === 'search')) {
      setModuleTab('notes')
    }
  }, [isOwner, moduleTab])

  const isWriteActive = moduleTab === 'write' && isOwner

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

  return (
    <NoteBookmarksProvider user={sessionUser}>
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
          <NoteComposer user={user} />
        </div>
      )}

      {/* ── Read-mode tabs — feed panes. Unmounted when not active so each
           tab starts fresh on next visit (cheap; the author/bookmark fetch
           is cached by Primal's singleton socket anyway). */}
      {!isWriteActive && moduleTab === 'notes' && (
        <MyNotesTab user={user} isOwner={isOwner} />
      )}
      {!isWriteActive && moduleTab === 'bookmarks' && (
        <BookmarksTab user={user} isOwner={isOwner} />
      )}
      {!isWriteActive && moduleTab === 'search' && isOwner && (
        <SearchTab />
      )}
    </div>
    </NoteBookmarksProvider>
  )
}
