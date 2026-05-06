/**
 * NoteDetailView — URL-routed surface for a single kind-1 note.
 *
 * Reachable at /<authorNpub>/notes/<nevent>. Cold-loads from a shared
 * link land here. Decodes the nevent → fetches the event → hands it
 * to NoteThreadView (the same component used for in-app thread
 * navigation in SearchTab). The thread view handles ancestor
 * resolution, replies, and the focus-card rendering.
 *
 * Click-through on any in-thread card navigates to that note's own
 * detail URL — back button unwinds via real history rather than the
 * SearchTab thread-stack pattern. Cleaner story for shared links.
 */
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { nip19 } from 'nostr-tools'
import { getNDK, connectAndWait } from '../../../../lib/ndk.js'
import { withTimeout, safeNpubEncode } from '../../../../lib/utils.js'
import { fetchProfiles } from '../../../../lib/primal.js'
import NoteThreadView from './NoteThreadView.jsx'

export default function NoteDetailView({ nevent, viewerNpub }) {
  const navigate = useNavigate()

  const [decoded, setDecoded] = useState(null)
  const [focus, setFocus]     = useState(null)
  const [focusProfile, setFocusProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  // Decode the nevent + fetch the kind-1 by event id. Decode happens
  // in an effect (not at render) so a malformed URL only cascades a
  // notFound state rather than throwing at render time.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setNotFound(false)
    setFocus(null)
    setFocusProfile(null)
    setDecoded(null)
    if (!nevent) { setLoading(false); setNotFound(true); return }
    let d = null
    try {
      const r = nip19.decode(nevent)
      if (r.type === 'nevent') d = r.data
      else if (r.type === 'note') d = { id: r.data, author: '', relays: [] }
    } catch {}
    if (!d?.id) { setLoading(false); setNotFound(true); return }
    setDecoded(d)
    ;(async () => {
      try {
        const ndk = getNDK()
        await connectAndWait(ndk, 3000).catch(() => {})
        // fetchEvent returns a single best-match — same shape NDK uses
        // throughout. Returning null on miss is normal (the event might
        // live on a relay we don't talk to).
        const ev = await withTimeout(
          ndk.fetchEvent({ ids: [d.id] }),
          8000,
          'fetch-timeout',
        ).catch((err) => {
          if (import.meta.env?.DEV) {
            // eslint-disable-next-line no-console
            console.warn('[NoteDetailView] fetchEvent failed', { id: d.id, error: err?.message })
          }
          return null
        })
        if (cancelled) return
        if (!ev) { setNotFound(true); setLoading(false); return }
        // Normalize to the plain shape NoteCard / useNoteThread expect.
        // NDK events expose .pubkey/.tags/.content as getters; unwrap so
        // child components don't have to care.
        setFocus({
          id:         ev.id,
          pubkey:     ev.pubkey,
          kind:       ev.kind,
          content:    ev.content || '',
          tags:       ev.tags || [],
          created_at: ev.created_at || 0,
        })
        setLoading(false)
        // Fire-and-forget profile fetch in parallel — the focus card
        // shows pubkey-only until this lands, but cold-link arrivals
        // get an avatar/name within a beat instead of the longer wait
        // that useNoteThread's own profile resolver imposes.
        if (ev.pubkey) {
          fetchProfiles([ev.pubkey]).then(map => {
            if (cancelled) return
            const p = map.get(ev.pubkey)
            if (p) setFocusProfile(p)
          }).catch(() => {})
        }
      } catch {
        if (!cancelled) { setNotFound(true); setLoading(false) }
      }
    })()
    return () => { cancelled = true }
  }, [nevent])

  // Back button — always lands on the note author's notes feed. The
  // older navigate(-1) path silently failed on cold mounts: BechResolver
  // arrives via <Navigate replace />, which doesn't push history, so
  // navigate(-1) tried to go before the tab existed and did nothing.
  // Going to the author's notes is the predictable outcome regardless
  // of how the user arrived (cold link, in-app click-through, deep
  // share). Falls back to viewer's own notes, then home.
  const handleBack = useCallback(() => {
    const authorPubkey = decoded?.author || focus?.pubkey
    if (authorPubkey) {
      const np = safeNpubEncode(nip19, authorPubkey, 'NoteDetailView.back')
      if (np) { navigate(`/${np}/notes`); return }
    }
    if (viewerNpub) navigate(`/${viewerNpub}/notes`)
    else navigate('/')
  }, [navigate, decoded, focus, viewerNpub])

  // Click-through on an in-thread card → that card's own detail URL.
  // Each click pushes a new history entry; back button unwinds. The
  // thread view's existing onNoteClick contract takes a note object
  // with at least { id, pubkey } — re-encode to nevent and navigate.
  const handleNoteClick = useCallback((note) => {
    if (!note?.id) return
    let nev = ''
    try {
      nev = nip19.neventEncode({ id: note.id, author: note.pubkey, relays: [] })
    } catch { return }
    if (!nev) return
    // Use the page-owner's npub from the URL so the user stays in the
    // same browsing context — matches the rule we apply for events
    // (cards navigate to /<currentRouteNpub>/<module>/<id>).
    const target = viewerNpub
      || safeNpubEncode(nip19, note.pubkey, 'NoteDetailView.noteClick')
    if (!target) return
    navigate(`/${target}/notes/${nev}`)
  }, [navigate, viewerNpub])

  if (loading) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header onBack={handleBack} />
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-4 py-10 text-center">
            <span className="inline-block w-5 h-5 border-2 border-neutral-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-xs text-neutral-500 mt-2">Loading note…</p>
          </div>
        </div>
      </div>
    )
  }

  if (notFound || !focus) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header onBack={handleBack} />
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-4 py-12 text-center">
            <div className="text-2xl mb-2">🤷</div>
            <div className="text-sm text-neutral-300">Note not found</div>
            <div className="text-[11px] text-neutral-500 mt-1">
              The relays we tried don't have this one. It may have been deleted, or it may live on a relay we don't talk to.
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <NoteThreadView
      focus={focus}
      onBack={handleBack}
      onNoteClick={handleNoteClick}
      initialProfile={focusProfile}
    />
  )
}

// Standalone header for the loading + not-found states. Once the note
// lands, NoteThreadView's own header takes over (sticky, with the same
// back affordance).
function Header({ onBack }) {
  return (
    <div className="sticky top-0 z-10 bg-neutral-950/95 backdrop-blur border-b border-neutral-800">
      <div className="max-w-2xl mx-auto px-4 py-2 flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
          aria-label="Back"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="10 12 6 8 10 4" />
          </svg>
          <span>Back</span>
        </button>
        <span className="text-xs text-neutral-300 font-medium">Thread</span>
      </div>
    </div>
  )
}
