/**
 * NotesModule — Module 2
 *
 * Four modes, mirroring Longform: Write · My Notes · My Bookmarks · Search.
 * Only Write is implemented so far (via NoteComposer); the other three tabs
 * render a "coming soon" placeholder.
 *
 * The Write pane is always mounted (hidden via CSS) so draft state survives
 * a detour through the other tabs — same pattern LongformModule uses.
 *
 * Visitors (non-owners) see just Notes · Bookmarks, matching Longform's
 * Articles · Collection visitor view. Both are placeholders for now.
 */
import { useState, useEffect } from 'react'
import NoteComposer from './components/NoteComposer.jsx'
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

      {/* ── Placeholder panes for the not-yet-built tabs ── */}
      {!isWriteActive && (
        <ComingSoonPane tab={moduleTab} user={user} isOwner={isOwner} />
      )}
    </div>
  )
}

function ComingSoonPane({ tab, user, isOwner }) {
  const displayName = user?.profile?.displayName || user?.profile?.name || 'this user'
  const copy = {
    notes: {
      icon: '📝',
      title: isOwner ? 'My Notes' : `Notes by ${displayName}`,
      body: 'A feed of short notes is coming soon.',
    },
    bookmarks: {
      icon: '🔖',
      title: isOwner ? 'My Bookmarks' : `Bookmarks by ${displayName}`,
      body: 'Saved notes and a bookmarking workflow are coming soon.',
    },
    search: {
      icon: '🔍',
      title: 'Search',
      body: 'Full-text note search across relays is coming soon.',
    },
  }[tab] || { icon: '', title: '', body: '' }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-sm mx-auto px-4 py-12 text-center">
        <div className="text-3xl text-neutral-700 mb-4">{copy.icon}</div>
        <p className="text-sm text-neutral-300 mb-2">{copy.title}</p>
        <p className="text-xs text-neutral-600 leading-relaxed">{copy.body}</p>
      </div>
    </div>
  )
}
