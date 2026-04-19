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
import { useNavigate } from 'react-router-dom'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { getNDK } from '../../../../lib/ndk.js'
import { useIsMobile } from '../../../../hooks/useIsMobile.js'
import { useOwnerContext } from '../../../../lib/ownerContext.jsx'
import { useNoteBookmarksContext } from '../../noteBookmarksContext.jsx'
import { useUserReactionsContext } from '../../userReactionsContext.jsx'
import ZapModal from '../../../../components/ZapModal.jsx'
import BookmarkPickerSheet from './BookmarkPickerSheet.jsx'

export default function NoteActionBar({ note, profile }) {
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const { sessionUser } = useOwnerContext()
  const { categories, createCategory, addNote, removeNote, canEdit } = useNoteBookmarksContext()
  const { likedIds, markLiked, unmarkLiked } = useUserReactionsContext()

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

  // ── Like ──
  // Derived from the shared reactions set so card unmount/remount (scroll
  // away → back) and full reloads don't lose the "Liked" state.
  const noteIdLower = note?.id?.toLowerCase()
  const liked = !!noteIdLower && likedIds.has(noteIdLower)
  const [liking, setLiking] = useState(false)

  // ── Zap ──
  const [zapOpen, setZapOpen] = useState(false)
  const [zapLud16, setZapLud16] = useState(profile?.lud16 || null)
  const [zapFetching, setZapFetching] = useState(false)

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
  const bookmarkRef = useRef(null)
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  useEffect(() => {
    if (!bookmarkOpen) return
    function onDown(e) {
      if (bookmarkRef.current && !bookmarkRef.current.contains(e.target)) setBookmarkOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [bookmarkOpen])

  const writableCategories = categories.filter(c => !c.readOnly)
  const containingCategories = writableCategories.filter(c =>
    c.items?.some(it => it.id === note.id?.toLowerCase())
  )
  const isBookmarked = containingCategories.length > 0

  async function handleLike() {
    if (!canPublish || liking || liked) return
    if (!note?.id || !/^[0-9a-f]{64}$/i.test(note.id)) return
    if (!note?.pubkey || !/^[0-9a-f]{64}$/i.test(note.pubkey)) return
    // Optimistic: mark liked in the shared set right away so the heart
    // flips immediately and any other card showing this note stays in
    // sync. Revert if signing/publishing fails.
    setLiking(true)
    markLiked(note.id)
    try {
      const ndk = getNDK()
      const ev = new NDKEvent(ndk)
      ev.kind = 7
      ev.content = '+'
      ev.tags = [
        ['e', note.id],
        ['p', note.pubkey],
        ['k', '1'],
      ]
      await ev.sign()
      await ev.publish()
    } catch (err) {
      if (import.meta.env.DEV) console.warn('Like failed:', err)
      unmarkLiked(note.id)
    } finally {
      if (mountedRef.current) setLiking(false)
    }
  }

  async function handleRepost() {
    if (!canPublish || reposting) return
    if (!note?.id || !/^[0-9a-f]{64}$/i.test(note.id)) return
    if (!note?.pubkey || !/^[0-9a-f]{64}$/i.test(note.pubkey)) return
    // Optimistic: show "Reposted" immediately; revert on failure.
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
      await ev.sign()
      await ev.publish()
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
      const events = await Promise.race([
        ndk.fetchEvents({ kinds: [0], authors: [note.pubkey] }),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000)),
      ])
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

  async function handleAddToCategory(categoryId) {
    setPending('add')
    try { await addNote(categoryId, note.id) }
    finally {
      if (!mountedRef.current) return
      setPending(null); setBookmarkOpen(false); setMobileSheet(false)
    }
  }
  async function handleRemoveFromCategory(categoryId) {
    setPending('remove')
    try { await removeNote(categoryId, note.id) }
    finally {
      if (!mountedRef.current) return
      setPending(null); setBookmarkOpen(false)
    }
  }
  async function handleCreateAndAdd(name) {
    const trimmed = name.trim()
    if (!trimmed) return
    setPending('add')
    try {
      const cat = await createCategory(trimmed)
      if (cat) await addNote(cat.id, note.id)
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
          }`}
        >
          {liked ? '❤️' : '🤍'} {liked ? 'Liked' : 'Like'}
        </button>

        {/* Zap */}
        <button
          onClick={handleZapClick}
          disabled={zapFetching}
          title={`Zap ${authorName || 'author'}`}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-neutral-800 text-neutral-500 hover:border-amber-800 hover:text-amber-400 disabled:opacity-40 transition-colors"
        >
          ⚡ {zapFetching ? 'Finding…' : 'Zap'}
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
            <span className="text-xs text-neutral-500 px-2">✓ Reposted</span>
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
              className={`text-xs px-2 py-1 rounded border transition-colors ${
                isBookmarked
                  ? 'border-amber-800 text-amber-400'
                  : 'border-neutral-800 text-neutral-500 hover:border-neutral-600 hover:text-neutral-300'
              }`}
            >
              🔖 {isBookmarked ? 'Saved' : 'Bookmark'}
            </button>

            {!isMobile && bookmarkOpen && (
              <div className="absolute right-0 bottom-full mb-1 bg-neutral-800 border border-neutral-700 rounded shadow-xl z-20 min-w-[200px] max-h-[70vh] overflow-y-auto">
                {isBookmarked && (
                  <>
                    <p className="px-3 py-1.5 text-[10px] text-neutral-600 uppercase tracking-wider">In</p>
                    {containingCategories.map(cat => (
                      <button
                        key={`in-${cat.id}`}
                        onClick={() => handleRemoveFromCategory(cat.id)}
                        disabled={!!pending}
                        className="w-full text-left px-3 py-1.5 text-xs text-amber-400 hover:bg-neutral-700 transition-colors truncate disabled:opacity-50 flex items-center justify-between gap-2"
                        title={`Remove from ${cat.title}`}
                      >
                        <span className="truncate">{cat.title}</span>
                        <span className="text-[10px] text-neutral-500 shrink-0">remove</span>
                      </button>
                    ))}
                    <div className="border-t border-neutral-700" />
                  </>
                )}

                {writableCategories.filter(c => !containingCategories.some(cc => cc.id === c.id)).length > 0 && (
                  <>
                    <p className="px-3 py-1.5 text-[10px] text-neutral-600 uppercase tracking-wider">
                      {isBookmarked ? 'Move to' : 'Add to'}
                    </p>
                    {writableCategories
                      .filter(c => !containingCategories.some(cc => cc.id === c.id))
                      .map(cat => (
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
                    placeholder="New category…"
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
              </div>
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
