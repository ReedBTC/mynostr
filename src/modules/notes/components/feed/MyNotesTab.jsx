/**
 * MyNotesTab — "My Notes" (owner) or "Notes by …" (visitor) pane.
 *
 * Owns:
 *   - The Notes / Comments pill toggle (author's originals vs replies)
 *   - A local thread-view stack. Clicking a note pushes onto the stack and
 *     renders NoteThreadView; the back button pops one level.
 */
import { useCallback, useState } from 'react'
import AuthorNotesPane from './AuthorNotesPane.jsx'
import NoteThreadView from './NoteThreadView.jsx'

export default function MyNotesTab({ user, isOwner }) {
  const pubkey = user?.pubkey
  const displayName = user?.profile?.displayName || user?.profile?.name || 'this user'
  const [mode, setMode] = useState('notes') // 'notes' | 'comments'
  const [threadStack, setThreadStack] = useState([]) // array of notes

  const openThread   = useCallback(note => setThreadStack(s => [...s, note]), [])
  const closeThread  = useCallback(() => setThreadStack(s => s.slice(0, -1)), [])

  if (!pubkey) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-4 py-10 text-center">
          <p className="text-xs text-neutral-500">No user loaded.</p>
        </div>
      </div>
    )
  }

  if (threadStack.length > 0) {
    const focus = threadStack[threadStack.length - 1]
    return <NoteThreadView focus={focus} onBack={closeThread} onNoteClick={openThread} />
  }

  const empty = mode === 'notes'
    ? (isOwner ? 'You haven\u2019t published any short notes yet.' : `${displayName} hasn\u2019t published any short notes yet.`)
    : (isOwner ? 'You haven\u2019t replied to any notes yet.' : `${displayName} hasn\u2019t replied to any notes yet.`)

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="max-w-xl mx-auto w-full px-4 pt-3 shrink-0">
        <ModePill mode={mode} onChange={setMode} />
      </div>
      <AuthorNotesPane
        pubkey={pubkey}
        emptyMessage={empty}
        mode={mode}
        onNoteClick={openThread}
      />
    </div>
  )
}

function ModePill({ mode, onChange }) {
  return (
    <div className="inline-flex items-center rounded-full border border-neutral-700 bg-neutral-900 p-0.5 mb-2">
      <PillBtn label="Notes"    active={mode === 'notes'}    onClick={() => onChange('notes')} />
      <PillBtn label="Comments" active={mode === 'comments'} onClick={() => onChange('comments')} />
    </div>
  )
}

function PillBtn({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-[11px] px-2.5 py-0.5 rounded-full transition-colors ${
        active ? 'bg-purple-700 text-white' : 'text-neutral-400 hover:text-neutral-200'
      }`}
    >
      {label}
    </button>
  )
}
