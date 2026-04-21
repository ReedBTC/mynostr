/**
 * NoteActionsMenu — three-dot menu attached to each NoteCard.
 *
 * Sections:
 *   - Add to bookmarks (submenu of categories + new-category input).
 *     Hidden for visitors and for sessions without a signer.
 *   - Copy nevent
 *   - Copy URL (njump.me/nevent)
 *   - Export JSON  — downloads the raw kind 1 event as a .json file,
 *     same shape NoteComposer accepts for JSON upload.
 *
 * The component owns only the popup; the parent (NoteCard) owns the
 * trigger button inside a relatively-positioned container. Closed via
 * onClose from the parent (outside-click handler + after each action).
 */
import { useState, useRef, useEffect } from 'react'
import { nip19 } from 'nostr-tools'
import { copyToClipboard } from '../../../../lib/utils.js'
import { useIsMobile } from '../../../../hooks/useIsMobile.js'
import { useNoteBookmarksContext } from '../../noteBookmarksContext.jsx'
import BookmarkPickerSheet from './BookmarkPickerSheet.jsx'

export default function NoteActionsMenu({ open, onClose, note, inBookmarksFeed = false }) {
  const { categories, createCategory, addNote, removeNote, canEdit, hiddenIdsByView } = useNoteBookmarksContext()
  const isMobile = useIsMobile()
  const [submenu, setSubmenu] = useState(false)
  const [removeSubmenu, setRemoveSubmenu] = useState(false)
  const [mobileSheet, setMobileSheet] = useState(false)
  const [newName, setNewName] = useState('')
  const [copied, setCopied] = useState(null)
  const [pending, setPending] = useState(null) // 'add' | 'remove' | null
  // Privacy target for the Add submenu. Resets to 'public' on each open
  // so a previous "Add → Private" doesn't silently persist the next time
  // the user bookmarks something.
  const [addPrivacy, setAddPrivacy] = useState('public')
  useEffect(() => { if (!open) { setAddPrivacy('public'); setSubmenu(false); setRemoveSubmenu(false) } }, [open])
  const mountedRef = useRef(true)

  useEffect(() => () => { mountedRef.current = false }, [])

  if (!open || !note?.id) return null

  let nevent = ''
  try { nevent = nip19.neventEncode({ id: note.id, author: note.pubkey }) } catch {}

  async function handleCopy(kind) {
    if (!nevent) return
    const text = kind === 'url' ? `https://njump.me/${nevent}` : nevent
    const ok = await copyToClipboard(text)
    if (!ok) return
    setCopied(kind)
    setTimeout(() => {
      if (!mountedRef.current) return
      setCopied(null)
      onClose?.()
    }, 1100)
  }

  async function addToCategory(categoryId) {
    setPending('add')
    try {
      await addNote(categoryId, note.id, { privacy: addPrivacy })
    } finally {
      if (mountedRef.current) {
        setPending(null)
        setSubmenu(false)
        onClose?.()
      }
    }
  }

  async function removeFromCategory(categoryId, privacy) {
    setPending('remove')
    try {
      await removeNote(categoryId, note.id, { privacy })
    } finally {
      if (mountedRef.current) {
        setPending(null)
        setRemoveSubmenu(false)
        onClose?.()
      }
    }
  }

  async function createAndAdd() {
    const name = newName.trim()
    if (!name) return
    setPending('add')
    try {
      const cat = await createCategory(name)
      if (cat) await addNote(cat.id, note.id, { privacy: addPrivacy })
      if (mountedRef.current) setNewName('')
    } finally {
      if (mountedRef.current) {
        setPending(null)
        setSubmenu(false)
        onClose?.()
      }
    }
  }

  async function sheetPick(categoryId, privacy) {
    setPending('add')
    try {
      await addNote(categoryId, note.id, { privacy: privacy || 'public' })
    } finally {
      if (mountedRef.current) {
        setPending(null)
        setMobileSheet(false)
        onClose?.()
      }
    }
  }

  async function sheetCreate(name, privacy) {
    setPending('add')
    try {
      const cat = await createCategory(name)
      if (cat) await addNote(cat.id, note.id, { privacy: privacy || 'public' })
    } finally {
      if (mountedRef.current) {
        setPending(null)
        setMobileSheet(false)
        onClose?.()
      }
    }
  }

  function handleExportJson() {
    const event = {
      kind: 1,
      id: note.id,
      pubkey: note.pubkey,
      created_at: note.created_at,
      content: note.content || '',
      tags: note.tags || [],
      sig: note.sig || '',
    }
    const blob = new Blob([JSON.stringify(event, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `note-${note.id.slice(0, 8)}.json`
    a.click()
    URL.revokeObjectURL(url)
    onClose?.()
  }

  // Hide the bookmarks submenu for read-only / logged-out views — the
  // lists we'd list would belong to the viewed user, not the viewer, and
  // writing to them would require a signer we don't have.
  //
  // Per-view hiding: the Add submenu filters by the hidden set matching
  // the user's current Add-privacy pill, so you only add into categories
  // visible in the bucket you're adding as. The Remove submenu below
  // unions both sets so you can always remove from a category that
  // already holds the note — hidden is a display preference, not a ban.
  const addHiddenSet = hiddenIdsByView?.[addPrivacy] || new Set()
  const writableCategories = categories.filter(c => !c.readOnly && !addHiddenSet.has(c.id))
  const removableCategories = categories.filter(c => !c.readOnly)
  const showBookmarks = canEdit
  const noteIdLower = note.id?.toLowerCase()
  // Flatten to one row per (category, privacy) hit so the remove menu
  // can offer "Remove from Queue (public)" and "Remove from Queue
  // (private)" as distinct actions when both happen to hold the note.
  const containingRows = []
  for (const c of removableCategories) {
    if (c.items?.some(it => it.id === noteIdLower)) containingRows.push({ cat: c, privacy: 'public' })
    if (c.privateItems?.some(it => it.id === noteIdLower)) containingRows.push({ cat: c, privacy: 'private' })
  }

  return (
    <>
    <div
      className="absolute right-0 top-full mt-1 bg-neutral-800 border border-neutral-700 rounded shadow-xl z-30 min-w-[200px] max-h-[70vh] overflow-y-auto"
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      {showBookmarks && (
        <>
          <button
            onClick={() => {
              if (isMobile) setMobileSheet(true)
              else setSubmenu(o => !o)
            }}
            className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors flex items-center justify-between"
          >
            <span>{inBookmarksFeed ? 'Bookmark Category' : 'Add to bookmarks'}</span>
            {!isMobile && (
              <span className="text-neutral-600 text-[10px]">{submenu ? '▲' : '▼'}</span>
            )}
          </button>
          {!isMobile && submenu && (
            <div className="border-t border-neutral-700">
              <div className="px-3 pt-2 pb-1.5 flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase tracking-wide text-neutral-500">Save as</span>
                <div className="inline-flex items-center rounded-full border border-neutral-700 bg-neutral-950 p-0.5">
                  <button
                    type="button"
                    onClick={() => setAddPrivacy('public')}
                    className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${
                      addPrivacy === 'public' ? 'bg-purple-700 text-white' : 'text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    Public
                  </button>
                  <button
                    type="button"
                    onClick={() => setAddPrivacy('private')}
                    title="NIP-51 encrypted — visible only to you"
                    className={`text-[10px] px-2 py-0.5 rounded-full transition-colors inline-flex items-center gap-1 ${
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
              {writableCategories.map(cat => {
                const heldHere = addPrivacy === 'private'
                  ? cat.privateItems?.some(it => it.id === noteIdLower)
                  : cat.items?.some(it => it.id === noteIdLower)
                return (
                  <button
                    key={cat.id}
                    onClick={() => addToCategory(cat.id)}
                    disabled={!!pending}
                    className="w-full text-left px-4 py-1.5 text-xs text-neutral-400 hover:bg-neutral-700 transition-colors truncate disabled:opacity-50 flex items-center justify-between gap-2"
                  >
                    <span className="truncate">{cat.title}</span>
                    {heldHere && <span className="text-[10px] text-purple-400 shrink-0">✓</span>}
                  </button>
                )
              })}
              {writableCategories.length === 0 && (
                <p className="px-4 py-1.5 text-[11px] text-neutral-500 italic">No categories yet.</p>
              )}
              <div className="px-3 py-1.5 flex gap-1">
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') createAndAdd()
                    if (e.key === 'Escape') setSubmenu(false)
                  }}
                  placeholder="New category…"
                  maxLength={60}
                  className="flex-1 bg-neutral-700 border border-neutral-600 rounded px-2 py-1 text-xs text-neutral-100 focus:outline-none"
                />
                <button
                  onClick={createAndAdd}
                  disabled={!newName.trim() || !!pending}
                  className="text-xs px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white transition-colors"
                >✓</button>
              </div>
            </div>
          )}
          {containingRows.length > 0 && (
            <>
              <button
                onClick={() => {
                  if (pending) return
                  if (containingRows.length === 1) {
                    removeFromCategory(containingRows[0].cat.id, containingRows[0].privacy)
                  } else {
                    setRemoveSubmenu(o => !o)
                  }
                }}
                disabled={!!pending}
                className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors flex items-center justify-between disabled:opacity-50"
              >
                <span className="flex items-center gap-1.5">
                  {pending === 'remove' && (
                    <span className="inline-block w-3 h-3 border border-neutral-400 border-t-transparent rounded-full animate-spin" />
                  )}
                  {pending === 'remove' ? 'Removing…' : 'Remove from bookmarks'}
                </span>
                {containingRows.length > 1 && pending !== 'remove' && (
                  <span className="text-neutral-600 text-[10px]">{removeSubmenu ? '▲' : '▼'}</span>
                )}
              </button>
              {removeSubmenu && containingRows.length > 1 && (
                <div className="border-t border-neutral-700">
                  {containingRows.map(({ cat, privacy }) => (
                    <button
                      key={`${cat.id}:${privacy}`}
                      onClick={() => removeFromCategory(cat.id, privacy)}
                      disabled={!!pending}
                      className="w-full text-left px-4 py-1.5 text-xs text-neutral-400 hover:bg-neutral-700 transition-colors truncate disabled:opacity-50 flex items-center justify-between gap-2"
                    >
                      <span className="truncate">{cat.title}</span>
                      {privacy === 'private' && (
                        <span
                          className="shrink-0 inline-flex items-center text-purple-400"
                          title="Private bucket"
                          aria-label="Private"
                        >
                          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                            <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
                            <path d="M5.5 7V5a2.5 2.5 0 015 0v2" strokeLinecap="round" />
                          </svg>
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          <div className="border-t border-neutral-700" />
        </>
      )}

      <button
        onClick={() => handleCopy('nevent')}
        disabled={!nevent}
        className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors disabled:opacity-50"
      >
        {copied === 'nevent' ? '✓ Copied!' : 'Copy nevent'}
      </button>
      <button
        onClick={() => handleCopy('url')}
        disabled={!nevent}
        className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors disabled:opacity-50"
      >
        {copied === 'url' ? '✓ Copied!' : 'Copy URL'}
      </button>

      <div className="border-t border-neutral-700" />

      <button
        onClick={handleExportJson}
        className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
      >
        Export JSON
      </button>
    </div>
    {isMobile && showBookmarks && (
      <BookmarkPickerSheet
        open={mobileSheet}
        onClose={() => setMobileSheet(false)}
        categories={writableCategories}
        onPick={sheetPick}
        onCreate={sheetCreate}
        pending={pending === 'add'}
      />
    )}
    </>
  )
}
