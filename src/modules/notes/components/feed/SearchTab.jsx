/**
 * SearchTab — author-or-note search for the Notes module.
 *
 * Same two-mode behavior users expect from Longform's Search:
 *   - Pick an author → show their kind 1 feed (infinite scroll)
 *   - Pick a single note (note1 / nevent1) → show that one note's card
 *
 * The picked author/note persists only in component state — intentional: a
 * shared browser shouldn't leave residue keyed by searched authors.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchNotesByIds, fetchProfiles } from '../../../../lib/primal.js'
import { getNDK, connectAndWait } from '../../../../lib/ndk.js'
import { isSafeUrl, withTimeout } from '../../../../lib/utils.js'
import { nip19 } from 'nostr-tools'
import NoteSearch from './NoteSearch.jsx'
import AuthorNotesPane from './AuthorNotesPane.jsx'
import AuthorBookmarksPane from './AuthorBookmarksPane.jsx'
import NoteCard from './NoteCard.jsx'
import NoteThreadView from './NoteThreadView.jsx'

export default function SearchTab({ initialAuthor, onInitialAuthorConsumed }) {
  // Mutually exclusive: one of these is set at a time.
  const [pickedAuthor, setPickedAuthor] = useState(initialAuthor || null)
  const [pickedNote,   setPickedNote]   = useState(null) // { id, author? }

  // Author-view mode: which feed to show for the picked author. Resets to
  // 'notes' on every fresh author pick so the toggle doesn't persist
  // across unrelated authors. Three-way pill: notes | comments | bookmarks.
  const [authorMode, setAuthorMode] = useState('notes') // 'notes' | 'comments' | 'bookmarks'

  // Thread stack — click-through any note in the search results to open its
  // thread. Resets on clear or a fresh author/note pick so you don't carry
  // a stale thread into an unrelated search.
  const [threadStack, setThreadStack] = useState([])
  const openThread  = useCallback(note => setThreadStack(s => [...s, note]), [])
  const closeThread = useCallback(() => setThreadStack(s => s.slice(0, -1)), [])

  // Owner clicked an author elsewhere in Notes (e.g. a NoteCard header) and
  // NotesModule routed us here with the author pre-filled. Ack back so the
  // same author can be re-clicked later.
  useEffect(() => {
    if (initialAuthor) {
      setPickedAuthor(initialAuthor)
      setPickedNote(null)
      setAuthorMode('notes')
      setThreadStack([])
      onInitialAuthorConsumed?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAuthor])

  function handlePickAuthor(author) {
    setPickedAuthor(author)
    setPickedNote(null)
    setAuthorMode('notes')
    setThreadStack([])
  }
  function handlePickNote(note) {
    setPickedNote(note)
    setPickedAuthor(null)
    setThreadStack([])
  }
  function handleClear() {
    setPickedAuthor(null)
    setPickedNote(null)
    setAuthorMode('notes')
    setThreadStack([])
  }

  const header = (
    <div className="mb-4 space-y-2">
      <NoteSearch onPickAuthor={handlePickAuthor} onPickNote={handlePickNote} />
      {(pickedAuthor || pickedNote) && (
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {pickedAuthor && (
              <>
                {pickedAuthor.picture && isSafeUrl(pickedAuthor.picture) ? (
                  <img src={pickedAuthor.picture} alt="" className="w-6 h-6 rounded-full object-cover" referrerPolicy="no-referrer" onError={e => { e.target.style.display = 'none' }} />
                ) : (
                  <div className="w-6 h-6 rounded-full bg-neutral-700" />
                )}
                <p className="text-xs text-neutral-300 truncate">
                  <span className="text-neutral-100">{pickedAuthor.name || 'this author'}</span>
                </p>
              </>
            )}
            {pickedNote && (
              <p className="text-xs text-neutral-400 truncate">Pinned note</p>
            )}
          </div>
          {pickedAuthor && (
            <div className="inline-flex items-center rounded-full border border-neutral-700 bg-neutral-900 p-0.5 shrink-0">
              {['notes', 'comments', 'bookmarks'].map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setAuthorMode(m)}
                  className={`text-[11px] px-2.5 py-0.5 rounded-full transition-colors capitalize ${
                    authorMode === m
                      ? 'bg-purple-700 text-white'
                      : 'text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={handleClear}
            className="text-[11px] text-neutral-500 hover:text-neutral-300 underline shrink-0"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  )

  // Thread view short-circuits the author/note panes — back button pops
  // the stack and the normal search result renders again.
  if (threadStack.length > 0) {
    const focus = threadStack[threadStack.length - 1]
    return <NoteThreadView focus={focus} onBack={closeThread} onNoteClick={openThread} />
  }

  if (pickedAuthor) {
    const who = pickedAuthor.name || 'this author'
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="max-w-xl w-full mx-auto px-4 pt-4 shrink-0">{header}</div>
        {authorMode === 'notes' || authorMode === 'comments' ? (
          <AuthorNotesPane
            pubkey={pickedAuthor.pubkey}
            emptyMessage={
              authorMode === 'comments'
                ? `${who} hasn’t replied to any notes yet.`
                : `No notes from ${who} yet.`
            }
            mode={authorMode}
            onNoteClick={openThread}
          />
        ) : (
          <AuthorBookmarksPane
            pubkey={pickedAuthor.pubkey}
            emptyMessage={`${who} hasn’t bookmarked any public notes.`}
            onNoteClick={openThread}
          />
        )}
      </div>
    )
  }

  if (pickedNote) {
    return (
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="max-w-xl mx-auto px-4 py-4">
          {header}
          <SingleNoteCard id={pickedNote.id} authorHint={pickedNote.author} onNoteClick={openThread} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden">
      <div className="max-w-xl mx-auto px-4 py-4">
        {header}
        <div className="py-10 text-center">
          <p className="text-xs text-neutral-500">Search for an author or paste a note ID to get started.</p>
        </div>
      </div>
    </div>
  )
}

// Fetches one note by id and renders it as a single NoteCard. Primal first,
// NDK fallback — notes off the Primal index are rare but worth reaching.
function SingleNoteCard({ id, authorHint, onNoteClick }) {
  const [note, setNote] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Supersession token — a fetch whose token no longer matches tokenRef.current
  // drops its result rather than clobbering a fresh lookup.
  const tokenRef = useRef(0)

  const key = useMemo(() => `single:${id}`, [id])

  useEffect(() => {
    const token = ++tokenRef.current
    setLoading(true)
    setError(null)
    setNote(null)
    setProfile(null)

    ;(async () => {
      try {
        const { notes, profiles } = await fetchNotesByIds([id])
        if (tokenRef.current !== token) return
        let found = notes[0] || null
        const profMap = new Map(profiles)

        if (!found) {
          const ndk = getNDK()
          await connectAndWait(ndk, 3000).catch(() => {})
          if (tokenRef.current !== token) return
          const ev = await withTimeout(ndk.fetchEvent({ ids: [id] }), 6000).catch(() => null)
          if (tokenRef.current !== token) return
          if (ev) {
            found = { id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at, content: ev.content, tags: ev.tags, kind: ev.kind }
          }
        }

        if (!found) { setError('Note not found on connected caches or relays.'); setLoading(false); return }
        if (found.kind !== 1) { setError(`Expected a kind 1 note, got kind ${found.kind}.`); setLoading(false); return }

        if (!profMap.has(found.pubkey)) {
          try {
            const got = await fetchProfiles([found.pubkey])
            if (tokenRef.current !== token) return
            for (const [pk, p] of got) profMap.set(pk, p)
          } catch {}
        }

        if (tokenRef.current !== token) return
        setNote(found)
        setProfile(profMap.get(found.pubkey) || null)
        setLoading(false)
      } catch (e) {
        if (tokenRef.current !== token) return
        setError(e?.message || 'Failed to load note')
        setLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (loading) {
    return (
      <div className="py-10 text-center">
        <span className="inline-block w-5 h-5 border-2 border-neutral-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-xs text-neutral-500 mt-2">Loading note…</p>
      </div>
    )
  }
  if (error) {
    const hintNpub = authorHint ? nip19.npubEncode(authorHint).slice(0, 12) + '\u2026' : null
    return (
      <div className="py-10 text-center">
        <p className="text-xs text-red-400 mb-1">{error}</p>
        {hintNpub && <p className="text-[10px] text-neutral-600">Author hint: {hintNpub}</p>}
      </div>
    )
  }
  if (!note) return null
  return <NoteCard note={note} profile={profile} onNoteClick={onNoteClick} />
}
