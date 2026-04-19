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

export default function NoteActionsMenu({ open, onClose, note }) {
  const { categories, createCategory, addNote, removeNote, canEdit } = useNoteBookmarksContext()
  const isMobile = useIsMobile()
  const [submenu, setSubmenu] = useState(false)
  const [removeSubmenu, setRemoveSubmenu] = useState(false)
  const [mobileSheet, setMobileSheet] = useState(false)
  const [newName, setNewName] = useState('')
  const [copied, setCopied] = useState(null)
  const [pending, setPending] = useState(null) // 'add' | 'remove' | null
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
      await addNote(categoryId, note.id)
    } finally {
      if (mountedRef.current) {
        setPending(null)
        setSubmenu(false)
        onClose?.()
      }
    }
  }

  async function removeFromCategory(categoryId) {
    setPending('remove')
    try {
      await removeNote(categoryId, note.id)
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
      if (cat) await addNote(cat.id, note.id)
      if (mountedRef.current) setNewName('')
    } finally {
      if (mountedRef.current) {
        setPending(null)
        setSubmenu(false)
        onClose?.()
      }
    }
  }

  async function sheetPick(categoryId) {
    setPending('add')
    try {
      await addNote(categoryId, note.id)
    } finally {
      if (mountedRef.current) {
        setPending(null)
        setMobileSheet(false)
        onClose?.()
      }
    }
  }

  async function sheetCreate(name) {
    setPending('add')
    try {
      const cat = await createCategory(name)
      if (cat) await addNote(cat.id, note.id)
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
  const writableCategories = categories.filter(c => !c.readOnly)
  const showBookmarks = canEdit
  const containingCategories = writableCategories.filter(c =>
    c.items?.some(it => it.id === note.id?.toLowerCase())
  )

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
            <span>Add to bookmarks</span>
            {!isMobile && (
              <span className="text-neutral-600 text-[10px]">{submenu ? '▲' : '▼'}</span>
            )}
          </button>
          {!isMobile && submenu && (
            <div className="border-t border-neutral-700">
              {writableCategories.map(cat => (
                <button
                  key={cat.id}
                  onClick={() => addToCategory(cat.id)}
                  disabled={!!pending}
                  className="w-full text-left px-4 py-1.5 text-xs text-neutral-400 hover:bg-neutral-700 transition-colors truncate disabled:opacity-50"
                >
                  {cat.title}
                </button>
              ))}
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
          {containingCategories.length > 0 && (
            <>
              <button
                onClick={() => {
                  if (pending) return
                  if (containingCategories.length === 1) {
                    removeFromCategory(containingCategories[0].id)
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
                {containingCategories.length > 1 && pending !== 'remove' && (
                  <span className="text-neutral-600 text-[10px]">{removeSubmenu ? '▲' : '▼'}</span>
                )}
              </button>
              {removeSubmenu && containingCategories.length > 1 && (
                <div className="border-t border-neutral-700">
                  {containingCategories.map(cat => (
                    <button
                      key={cat.id}
                      onClick={() => removeFromCategory(cat.id)}
                      disabled={!!pending}
                      className="w-full text-left px-4 py-1.5 text-xs text-neutral-400 hover:bg-neutral-700 transition-colors truncate disabled:opacity-50"
                    >
                      {cat.title}
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
