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
import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchNotesByIds, fetchProfiles } from '../../../../lib/primal.js'
import { getNDK, connectAndWait } from '../../../../lib/ndk.js'
import { isSafeUrl } from '../../../../lib/utils.js'
import { nip19 } from 'nostr-tools'
import NoteSearch from './NoteSearch.jsx'
import AuthorNotesPane from './AuthorNotesPane.jsx'
import NoteCard from './NoteCard.jsx'

export default function SearchTab({ initialAuthor, onInitialAuthorConsumed }) {
  // Mutually exclusive: one of these is set at a time.
  const [pickedAuthor, setPickedAuthor] = useState(initialAuthor || null)
  const [pickedNote,   setPickedNote]   = useState(null) // { id, author? }

  // Owner clicked an author elsewhere in Notes (e.g. a NoteCard header) and
  // NotesModule routed us here with the author pre-filled. Ack back so the
  // same author can be re-clicked later.
  useEffect(() => {
    if (initialAuthor) {
      setPickedAuthor(initialAuthor)
      setPickedNote(null)
      onInitialAuthorConsumed?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAuthor])

  function handlePickAuthor(author) {
    setPickedAuthor(author)
    setPickedNote(null)
  }
  function handlePickNote(note) {
    setPickedNote(note)
    setPickedAuthor(null)
  }
  function handleClear() {
    setPickedAuthor(null)
    setPickedNote(null)
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
                  <img src={pickedAuthor.picture} alt="" className="w-6 h-6 rounded-full object-cover" onError={e => { e.target.style.display = 'none' }} />
                ) : (
                  <div className="w-6 h-6 rounded-full bg-neutral-700" />
                )}
                <p className="text-xs text-neutral-300 truncate">
                  Notes by <span className="text-neutral-100">{pickedAuthor.name || 'this author'}</span>
                </p>
              </>
            )}
            {pickedNote && (
              <p className="text-xs text-neutral-400 truncate">Pinned note</p>
            )}
          </div>
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

  if (pickedAuthor) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="max-w-xl w-full mx-auto px-4 pt-4 shrink-0">{header}</div>
        <AuthorNotesPane pubkey={pickedAuthor.pubkey} emptyMessage="No notes from this author yet." />
      </div>
    )
  }

  if (pickedNote) {
    return (
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="max-w-xl mx-auto px-4 py-4">
          {header}
          <SingleNoteCard id={pickedNote.id} authorHint={pickedNote.author} />
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
function SingleNoteCard({ id, authorHint }) {
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
          const ev = await Promise.race([
            ndk.fetchEvent({ ids: [id] }),
            new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 6000)),
          ]).catch(() => null)
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
  return <NoteCard note={note} profile={profile} />
}
