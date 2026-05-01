/**
 * NoteActionBar — Like / Zap / Comments / Repost / Bookmark row at the
 * bottom of a kind 1 NoteCard. Mirrors the longform reader's action bar,
 * except Bookmark sits here (right-aligned) next to the others instead
 * of up in the header — notes don't have their own header ✕ to compete
 * with.
 *
 * Session-aware: Like/Repost require a publishable session (isOwner or
 * at least a signer). Zap only needs the author's lud16 — anyone can
 * pay an invoice. Comments is greyed out until the reply module ships.
 *
 * Bookmark mirrors NoteActionsMenu's add/remove flow — mobile opens
 * BookmarkPickerSheet, desktop opens an inline dropdown under the
 * button. Label toggles Bookmark ↔ Saved based on membership in any
 * writable category.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { getNDK, signWithTimeout } from '../../../../lib/ndk.js'
import { withTimeout } from '../../../../lib/utils.js'
import { Z } from '../../../../lib/zIndex.js'
import { useIsMobile } from '../../../../hooks/useIsMobile.js'
import { useOwnerContext } from '../../../../lib/ownerContext.jsx'
import { useNoteBookmarksContext } from '../../noteBookmarksContext.jsx'
import ZapModal from '../../../../components/ZapModal.jsx'
import BookmarkIcon from '../../../../components/BookmarkIcon.jsx'
import BookmarkPickerSheet from './BookmarkPickerSheet.jsx'
import { useMyZapped, useMyZapPending } from '../../../../lib/useMyZapped.js'
import { useMyLiked } from '../../../../lib/useMyLiked.js'
import { publishLike } from '../../../../lib/publishLike.js'
import { extractZapSplits } from '../../../../lib/zapSplits.js'

export default function NoteActionBar({ note, profile }) {
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const { sessionUser } = useOwnerContext()
  const { categories, createCategory, addNote, removeNote, canEdit } = useNoteBookmarksContext()

  const canPublish = !!sessionUser?.pubkey && !sessionUser?.readOnly

  // Build a portable nevent for the composer's Reply / Quote fields. Author
  // travels with it so the composer can resolve the p-tag without a fetch.
  function encodeNoteRef() {
    if (!note?.id || !/^[0-9a-f]{64}$/i.test(note.id)) return null
    try { return nip19.neventEncode({ id: note.id, author: note.pubkey }) }
    catch { return null }
  }

  function openInComposer(field) {
    if (!canPublish || !sessionUser?.npub) return
    const bech32 = encodeNoteRef()
    if (!bech32) return
    navigate(`/${sessionUser.npub}/notes`, {
      state: { composerPrefill: { [field]: bech32 } },
    })
  }

  // Lowercased note id — used by the bookmark-membership check below
  // (categories store ids lowercased) and previously by the reactions
  // context. Kept here even after the migration to the shared reaction
  // store because the bookmark code still consumes it.
  const noteIdLower = note?.id?.toLowerCase()

  // ── Like ──
  // Derived from the shared reactions store so card unmount/remount (scroll
  // away → back) and full reloads don't lose the "Liked" state. Source of
  // truth is kind 7 events on relays — fetched once on session login,
  // refreshed in localStorage for instant cold-load styling.
  const liked = useMyLiked({ eventId: note?.id })
  const [liking, setLiking] = useState(false)

  // ── Zap ──
  const [zapOpen, setZapOpen] = useState(false)
  const [zapLud16, setZapLud16] = useState(profile?.lud16 || null)
  const [zapFetching, setZapFetching] = useState(false)
  const zapped     = useMyZapped({ eventId: note?.id })
  const zapPending = useMyZapPending({ eventId: note?.id })

  // ── Repost ──
  const [repostOpen, setRepostOpen] = useState(false)
  const [reposting, setReposting] = useState(false)
  const [repostDone, setRepostDone] = useState(false)
  const repostRef = useRef(null)
  useEffect(() => {
    if (!repostOpen) return
    function onDown(e) {
      if (repostRef.current && !repostRef.current.contains(e.target)) setRepostOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [repostOpen])

  // ── Bookmark menu ──
  const [bookmarkOpen, setBookmarkOpen] = useState(false)
  const [mobileSheet, setMobileSheet] = useState(false)
  const [newName, setNewName] = useState('')
  const [pending, setPending] = useState(null) // 'add' | 'remove' | null
  // Privacy target for the Add section. Resets to 'public' on each open.
  // Mirrors NoteActionsMenu's pill so the inline dropdown can save to the
  // encrypted (NIP-51 privateItems) bucket — previously the inline
  // dropdown always saved public regardless of which bucket the user
  // intended (and silently dropped the privacy arg from BookmarkPickerSheet
  // on mobile).
  const [addPrivacy, setAddPrivacy] = useState('public')
  useEffect(() => { if (!bookmarkOpen) setAddPrivacy('public') }, [bookmarkOpen])
  const bookmarkRef = useRef(null)
  // Setup must reset to true — React 18 StrictMode runs setup → cleanup
  // → setup again on mount, so a no-body setup would leave `current`
  // permanently false and gate every async callback into a silent
  // early-return.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Portal position — same pattern as NoteActionsMenu. Computed from
  // the trigger's rect once the dropdown opens; closes on scroll/resize.
  // Fixed positioning + body portal escape the NoteCard's overflow:hidden
  // so the dropdown can drop past the card/feed edges.
  const [bookmarkPos, setBookmarkPos] = useState(null)
  useEffect(() => {
    if (!bookmarkOpen || !bookmarkRef.current) { setBookmarkPos(null); return }
    const rect = bookmarkRef.current.getBoundingClientRect()
    setBookmarkPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
    function dismiss() { setBookmarkOpen(false) }
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [bookmarkOpen])

  useEffect(() => {
    if (!bookmarkOpen) return
    // Dropdown is portaled to document.body so `contains` misses it —
    // also check the data-attribute so clicks inside the portaled
    // dropdown don't close it.
    function onDown(e) {
      if (bookmarkRef.current?.contains(e.target)) return
      if (e.target.closest?.('[data-note-bookmark-menu="true"]')) return
      setBookmarkOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [bookmarkOpen])

  const writableCategories = categories.filter(c => !c.readOnly)
  // All (category, privacy) pairs that currently hold the note — used for
  // the "In" section so the user can see and remove from each bucket.
  const containingRows = []
  for (const c of writableCategories) {
    if (c.items?.some(it => it.id === noteIdLower)) containingRows.push({ cat: c, privacy: 'public' })
    if (c.privateItems?.some(it => it.id === noteIdLower)) containingRows.push({ cat: c, privacy: 'private' })
  }
  const isBookmarked = containingRows.length > 0
  // Categories not yet holding the note in the *target* privacy bucket.
  // Changing the pill between Public ↔ Private re-filters this list.
  const addableCategories = writableCategories.filter(c => {
    const held = addPrivacy === 'private'
      ? c.privateItems?.some(it => it.id === noteIdLower)
      : c.items?.some(it => it.id === noteIdLower)
    return !held
  })

  async function handleLike() {
    if (!canPublish || liking || liked) return
    if (!note?.id || !/^[0-9a-f]{64}$/i.test(note.id)) return
    if (!note?.pubkey || !/^[0-9a-f]{64}$/i.test(note.pubkey)) return
    setLiking(true)
    await publishLike({ eventId: note.id, eventPubkey: note.pubkey, kind: 1 })
    if (mountedRef.current) setLiking(false)
  }

  async function handleRepost() {
    if (!canPublish || reposting) return
    if (!note?.id || !/^[0-9a-f]{64}$/i.test(note.id)) return
    if (!note?.pubkey || !/^[0-9a-f]{64}$/i.test(note.pubkey)) return
    // Optimistic: show "Reposted" immediately; revert on failure OR on
    // a zero-ack publish so the label doesn't lie about persistence.
    setReposting(true)
    setRepostDone(true)
    setRepostOpen(false)
    try {
      const ndk = getNDK()
      const ev = new NDKEvent(ndk)
      // NIP-18: kind 6 for kind 1 note reposts
      ev.kind = 6
      ev.content = ''
      ev.tags = [
        ['e', note.id],
        ['p', note.pubkey],
      ]
      await signWithTimeout(ev)
      const publishedTo = await ev.publish()
      if (!publishedTo || publishedTo.size === 0) {
        if (import.meta.env.DEV) console.warn('Repost reached no relays')
        if (mountedRef.current) setRepostDone(false)
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn('Repost failed:', err)
      if (mountedRef.current) setRepostDone(false)
    } finally {
      if (mountedRef.current) setReposting(false)
    }
  }

  async function handleZapClick() {
    if (zapLud16) { setZapOpen(true); return }
    setZapFetching(true)
    try {
      const ndk = getNDK()
      const events = await withTimeout(
        ndk.fetchEvents({ kinds: [0], authors: [note.pubkey] }),
        5000,
      )
      const event = Array.from(events)[0]
      if (event) {
        try {
          const parsed = JSON.parse(event.content)
          if (parsed.lud16) {
            setZapLud16(parsed.lud16)
            setZapOpen(true)
            return
          }
        } catch { /* malformed profile JSON */ }
      }
    } catch { /* silently fail */ } finally {
      setZapFetching(false)
    }
  }

  async function handleAddToCategory(categoryId, privacyOverride) {
    setPending('add')
    try { await addNote(categoryId, note.id, { privacy: privacyOverride || addPrivacy }) }
    finally {
      if (!mountedRef.current) return
      setPending(null); setBookmarkOpen(false); setMobileSheet(false)
    }
  }
  async function handleRemoveFromCategory(categoryId, privacyOverride) {
    setPending('remove')
    try { await removeNote(categoryId, note.id, { privacy: privacyOverride || 'public' }) }
    finally {
      if (!mountedRef.current) return
      setPending(null); setBookmarkOpen(false)
    }
  }
  async function handleCreateAndAdd(name, privacyOverride) {
    const trimmed = name.trim()
    if (!trimmed) return
    setPending('add')
    try {
      const cat = await createCategory(trimmed)
      if (cat) await addNote(cat.id, note.id, { privacy: privacyOverride || addPrivacy })
      if (mountedRef.current) setNewName('')
    } finally {
      if (!mountedRef.current) return
      setPending(null); setBookmarkOpen(false); setMobileSheet(false)
    }
  }

  const authorName = profile?.display_name || profile?.name || ''

  return (
    <>
      {zapOpen && zapLud16 && (
        <ZapModal
          lud16={zapLud16}
          recipientPubkey={note.pubkey}
          recipientName={authorName}
          targetEvent={note}
          targetKind="1"
          user={sessionUser}
          zapSplits={extractZapSplits(note?.tags)}
          onClose={() => setZapOpen(false)}
        />
      )}

      <div className="flex items-center gap-1.5 mt-3 pt-2 border-t border-neutral-800">
        {/* Like */}
        <button
          onClick={handleLike}
          disabled={!canPublish || liking}
          title={canPublish ? 'Like' : 'Sign in to react'}
          className={`flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors disabled:opacity-40 ${
            liked
              ? 'border-red-800 text-red-400'
              : 'border-neutral-800 text-neutral-500 hover:border-neutral-600 hover:text-neutral-300'
          } ${liking ? 'animate-pulse' : ''}`}
        >
          {liked ? '❤️' : '🤍'} {liked ? 'Liked' : 'Like'}
        </button>

        {/* Zap */}
        <button
          onClick={handleZapClick}
          disabled={zapFetching}
          title={zapped ? `You zapped this note · zap again` : `Zap ${authorName || 'author'}`}
          className={`flex items-center gap-1 text-xs px-2 py-1 rounded border disabled:opacity-40 transition-colors ${
            zapped
              ? 'border-amber-700 bg-amber-950/30 text-amber-300 hover:bg-amber-900/40'
              : 'border-neutral-800 text-neutral-500 hover:border-amber-800 hover:text-amber-400'
          } ${zapPending ? 'animate-pulse' : ''}`}
        >
          ⚡ {zapFetching ? 'Finding…' : zapped ? 'Zapped' : 'Zap'}
        </button>

        {/* Comment — navigates to the Write module with this note prefilled
            into the Reply field so the author can write a kind 1 reply. */}
        <button
          onClick={() => openInComposer('replyTo')}
          disabled={!canPublish}
          title={canPublish ? 'Comment on this note' : 'Sign in to comment'}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-neutral-800 text-neutral-500 hover:border-neutral-600 hover:text-neutral-300 disabled:opacity-40 transition-colors"
        >
          💬 Comment
        </button>

        {/* Repost */}
        <div className="relative" ref={repostRef}>
          {repostDone ? (
            <span className={`text-xs text-neutral-500 px-2 ${reposting ? 'animate-pulse' : ''}`}>
              ✓ {reposting ? 'Reposting…' : 'Reposted'}
            </span>
          ) : (
            <button
              onClick={() => setRepostOpen(o => !o)}
              disabled={!canPublish}
              title={canPublish ? 'Repost' : 'Sign in to repost'}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-neutral-800 text-neutral-500 hover:border-neutral-600 hover:text-green-400 disabled:opacity-40 transition-colors"
            >
              🔁 Repost
            </button>
          )}
          {repostOpen && (
            <div className="absolute left-0 bottom-full mb-1 bg-neutral-900 border border-neutral-700 rounded shadow-xl z-20 min-w-[170px] py-1">
              <button
                onClick={handleRepost}
                disabled={reposting}
                className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-40 transition-colors"
              >
                🔁 {reposting ? 'Reposting…' : 'Repost'}
              </button>
              <button
                onClick={() => { setRepostOpen(false); openInComposer('quote') }}
                disabled={!canPublish}
                className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-40 transition-colors"
              >
                💬 Quote
              </button>
            </div>
          )}
        </div>

        {/* Bookmark — right-aligned */}
        {canEdit && (
          <div className="ml-auto relative" ref={bookmarkRef}>
            <button
              onClick={() => {
                if (isMobile) setMobileSheet(true)
                else setBookmarkOpen(o => !o)
              }}
              className={`text-xs px-2 py-1 rounded border transition-colors inline-flex items-center gap-1 ${
                isBookmarked
                  ? 'border-blue-800 text-blue-400'
                  : 'border-neutral-800 text-neutral-500 hover:border-neutral-600 hover:text-neutral-300'
              }`}
            >
              <BookmarkIcon filled className="text-blue-400" />
              <span>{isBookmarked ? 'Saved' : 'Bookmark'}</span>
            </button>

            {!isMobile && bookmarkOpen && bookmarkPos && createPortal(
              <div
                data-note-bookmark-menu="true"
                className={`fixed bg-neutral-800 border border-neutral-700 rounded shadow-xl ${Z.portaledMenu} w-[240px] max-h-[70vh] overflow-y-auto`}
                style={{ top: bookmarkPos.top, right: bookmarkPos.right }}
                onMouseDown={e => e.stopPropagation()}
                onClick={e => e.stopPropagation()}
              >
                {/* Save as: public/private pill — matches NoteActionsMenu. */}
                <div className="px-3 pt-2 pb-1.5 flex items-center justify-between gap-2 border-b border-neutral-700">
                  <span className="text-[10px] uppercase tracking-wide text-neutral-500">Save as</span>
                  <div className="inline-flex items-center rounded-full border border-neutral-700 bg-neutral-950 p-0.5">
                    <button
                      type="button"
                      onClick={() => setAddPrivacy('public')}
                      disabled={!!pending}
                      className={`text-[10px] px-2 py-0.5 rounded-full transition-colors disabled:opacity-40 ${
                        addPrivacy === 'public' ? 'bg-purple-700 text-white' : 'text-neutral-400 hover:text-neutral-200'
                      }`}
                    >
                      Public
                    </button>
                    <button
                      type="button"
                      onClick={() => setAddPrivacy('private')}
                      title="NIP-51 encrypted — visible only to you"
                      disabled={!!pending}
                      className={`text-[10px] px-2 py-0.5 rounded-full transition-colors inline-flex items-center gap-1 disabled:opacity-40 ${
                        addPrivacy === 'private' ? 'bg-purple-700 text-white' : 'text-neutral-400 hover:text-neutral-200'
                      }`}
                    >
                      <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
                        <path d="M5.5 7V5a2.5 2.5 0 015 0v2" strokeLinecap="round" />
                      </svg>
                      Private
                    </button>
                  </div>
                </div>

                {isBookmarked && (
                  <>
                    <p className="px-3 py-1.5 text-[10px] text-neutral-600 uppercase tracking-wider">In</p>
                    {containingRows.map(({ cat, privacy }) => (
                      <button
                        key={`in-${cat.id}-${privacy}`}
                        onClick={() => handleRemoveFromCategory(cat.id, privacy)}
                        disabled={!!pending}
                        className="w-full text-left px-3 py-1.5 text-xs text-amber-400 hover:bg-neutral-700 transition-colors truncate disabled:opacity-50 flex items-center justify-between gap-2"
                        title={`Remove from ${cat.title}${privacy === 'private' ? ' (private)' : ''}`}
                      >
                        <span className="truncate inline-flex items-center gap-1.5">
                          {privacy === 'private' && (
                            <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                              <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
                              <path d="M5.5 7V5a2.5 2.5 0 015 0v2" strokeLinecap="round" />
                            </svg>
                          )}
                          <span className="truncate">{cat.title}</span>
                        </span>
                        <span className="text-[10px] text-neutral-500 shrink-0">remove</span>
                      </button>
                    ))}
                    <div className="border-t border-neutral-700" />
                  </>
                )}

                {addableCategories.length > 0 && (
                  <>
                    <p className="px-3 py-1.5 text-[10px] text-neutral-600 uppercase tracking-wider">
                      {isBookmarked ? 'Move to' : 'Add to'}
                    </p>
                    {addableCategories.map(cat => (
                      <button
                        key={`add-${cat.id}`}
                        onClick={() => handleAddToCategory(cat.id)}
                        disabled={!!pending}
                        className="w-full text-left px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors truncate disabled:opacity-50"
                      >
                        {cat.title}
                      </button>
                    ))}
                  </>
                )}

                <div className="border-t border-neutral-700 px-3 py-1.5 flex gap-1">
                  <input
                    type="text"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleCreateAndAdd(newName)
                      if (e.key === 'Escape') setBookmarkOpen(false)
                    }}
                    placeholder="New collection…"
                    maxLength={60}
                    className="flex-1 bg-neutral-700 border border-neutral-600 rounded px-2 py-1 text-xs text-neutral-100 focus:outline-none"
                  />
                  <button
                    onClick={() => handleCreateAndAdd(newName)}
                    disabled={!newName.trim() || !!pending}
                    className="text-xs px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white transition-colors"
                  >
                    ✓
                  </button>
                </div>
              </div>,
              document.body,
            )}

            {isMobile && (
              <BookmarkPickerSheet
                open={mobileSheet}
                onClose={() => setMobileSheet(false)}
                categories={writableCategories}
                onPick={handleAddToCategory}
                onCreate={handleCreateAndAdd}
                pending={pending === 'add'}
              />
            )}
          </div>
        )}
      </div>
    </>
  )
}
